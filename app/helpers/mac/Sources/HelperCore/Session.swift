import Darwin
import Foundation

/// An op's answer: its result, or an error code of CONTRACT §3 or of the op's `errors`, with a message that never holds
/// what the op read.
enum Outcome {
    case success([String: Any])
    case failure(code: String, message: String, retryable: Bool = false)
}

/// The session layer of ac-helper: NDJSON on stdin and stdout (CONTRACT §2), errors (§3), hello (§4), cancel (§5) and
/// exit (§6). Requests other than hello, cancel and shutdown run off the reading thread; one lock guards stdout and the
/// requests in flight, so every request gets exactly one answer and nothing follows the shutdown answer.
public final class Session: @unchecked Sendable {
    static let maxLineBytes = 16_777_216  // ops.json max_line_bytes, the newline included
    static let protocolVersion = 1
    static let helperVersion = "0.1.0"

    private let lock = NSLock()
    private var running: [Int: String] = [:]  // id -> op of each request whose handler has not answered yet
    private var ready = false                  // hello answered
    private var seq = 0                        // the last event's seq (CONTRACT §2.6)
    private var lastId = 0                     // the reading thread's last request id (CONTRACT §2.5)
    private let work = DispatchQueue(label: "ac-helper.ops", attributes: .concurrent)
    private let output: Int32
    private let handlers: (String) -> Handler?

    public convenience init() { self.init(output: STDOUT_FILENO, handlers: Ops.handler) }

    /// The unit tests' session: lines go to `output`, and the ops run `handlers`.
    init(output: Int32, handlers: @escaping (String) -> Handler?) {
        self.output = output
        self.handlers = handlers
    }

    /// Reads stdin on its own thread and runs the main run loop, which AppKit's ops and the watches need; never returns.
    public func run() -> Never {
        signal(SIGPIPE, SIG_IGN)
        Events.connect { [self] name, data, live in emit(name, data, live) }
        let reader = Thread { [self] in readLoop() }
        reader.name = "ac-helper.stdin"
        reader.start()
        // A port keeps the main run loop running while nothing else is scheduled on it.
        RunLoop.main.add(NSMachPort(), forMode: .default)
        while true { RunLoop.main.run() }
    }

    private func readLoop() -> Never {
        var pending: [UInt8] = []
        var scanned = 0  // pending[0..<scanned] holds no newline
        var chunk = [UInt8](repeating: 0, count: 1 << 16)
        while true {
            guard let newline = pending[scanned...].firstIndex(of: 0x0A) else {
                if pending.count >= Self.maxLineBytes { protocolError("a line is longer than max_line_bytes") }
                scanned = pending.count
                let got = chunk.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
                if got < 0 && errno == EINTR { continue }
                if got <= 0 { break }
                pending.append(contentsOf: chunk[0..<got])
                continue
            }
            if newline + 1 > Self.maxLineBytes { protocolError("a line is longer than max_line_bytes") }
            let line = pending[0..<newline]
            handleLine(line)
            pending.removeFirst(newline + 1)
            scanned = 0
        }
        if !pending.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { protocolError("the last line has no newline") }
        // stdin closed: a shutdown without an answer (CONTRACT §6.1).
        lock.lock()
        ControlListen.stop()
        exit(0)
    }

    /// Nil once the message is out; else what keeps it from being one line, and nothing was written.
    private func write(_ message: [String: Any]) -> String? {
        guard var data = JSON.dump(message) else { return "holds a value JSON cannot write" }
        guard data.count < Self.maxLineBytes else { return "is longer than max_line_bytes" }
        data.append(0x0A)
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let wrote = Darwin.write(output, raw.baseAddress! + offset, raw.count - offset)
                if wrote < 0 && errno == EINTR { continue }
                if wrote <= 0 { return }  // the main process is gone
                offset += wrote
            }
        }
        return nil
    }

    /// Callers hold the lock.
    private func answer(_ id: Int, _ outcome: Outcome) {
        var message: [String: Any] = ["v": 1, "id": id]
        switch outcome {
        case let .success(result):
            message["ok"] = true
            message["result"] = result
        case let .failure(code, text, retryable):
            message["ok"] = false
            var error: [String: Any] = ["code": code, "message": text]
            if retryable { error["retryable"] = true }
            message["error"] = error
        }
        if let problem = write(message) { answer(id, .failure(code: "internal", message: "the answer \(problem)")) }
    }

    func emit(_ name: String, _ data: [String: Any], _ live: () -> Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard ready, live() else { return }
        seq += 1
        if let problem = write(["v": 1, "event": name, "seq": seq, "data": data]) {
            seq -= 1
            FileHandle.standardError.write(Data("ac-helper: dropped a \(name) event that \(problem)\n".utf8))
        }
    }

    /// Exit code 2 after one line on stderr (CONTRACT §6.2).
    private func protocolError(_ why: String) -> Never {
        lock.lock()
        FileHandle.standardError.write(Data("ac-helper: protocol error: \(why)\n".utf8))
        exit(2)
    }

    func handleLine(_ line: ArraySlice<UInt8>) {
        if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { return }
        guard let value = JSON.parse(line) else { protocolError("a line is not JSON") }
        guard let message = value as? [String: Any] else { protocolError("a line is not a JSON object") }
        guard let v = JSON.int(message["v"]), v == Self.protocolVersion else { protocolError("a message has no \"v\": 1") }
        guard let op = message["op"] as? String, message["ok"] == nil, message["event"] == nil else {
            protocolError("a message from the main process is not a request")
        }
        guard let id = JSON.int(message["id"]), id > 0 else { protocolError("a request id is not a positive integer") }
        guard id > lastId else { protocolError("a request id is not above every earlier one") }
        lastId = id
        dispatch(id, op, message["params"])
    }

    private func dispatch(_ id: Int, _ name: String, _ params: Any?) {
        lock.lock()
        defer { lock.unlock() }
        if !ready && name != "hello" { return answer(id, .failure(code: "not_ready", message: "the hello request has not been answered")) }
        guard let op = OpTable.find(name) else { return answer(id, .failure(code: "unknown_op", message: "this helper does not know the op")) }
        guard let params = params as? [String: Any] else { return answer(id, .failure(code: "bad_request", message: "params is not an object")) }
        if let problem = OpTable.paramsError(op, params) { return answer(id, .failure(code: "bad_request", message: problem)) }
        switch name {
        case "hello": return hello(id, params)
        case "cancel": return cancel(id, JSON.int(params["target"])!)
        case "shutdown": shutdown(id)
        default: break
        }
        guard let handler = handlers(name) else {
            return answer(id, .failure(code: "unsupported", message: "\(name) is not implemented in the macOS helper yet"))
        }
        running[id] = name
        let cancelled = { [self] in lock.withLock { running[id] == nil } }
        let job = { [self] in
            if cancelled() { return }
            let outcome = handler.run(params, cancelled)
            lock.lock()
            defer { lock.unlock() }
            guard running.removeValue(forKey: id) != nil else { return }
            answer(id, outcome)
            if case .success = outcome { handler.answered?(params) }
        }
        if handler.onMain { DispatchQueue.main.async(execute: job) } else { work.async(execute: job) }
    }

    /// Callers hold the lock.
    private func hello(_ id: Int, _ params: [String: Any]) {
        let asked = JSON.int(params["protocol"])!
        guard asked == Self.protocolVersion else {
            answer(id, .failure(code: "protocol_mismatch", message: "this helper speaks protocol 1"))
            FileHandle.standardError.write(Data("ac-helper: hello asked for protocol \(asked); this helper speaks 1\n".utf8))
            exit(3)
        }
        let session: Set = ["hello", "cancel", "shutdown"]
        let ops = OpTable.specs.map(\.name).filter { session.contains($0) || handlers($0) != nil }
        let v = ProcessInfo.processInfo.operatingSystemVersion
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        ready = true
        answer(id, .success([
            "protocol": Self.protocolVersion, "platform": "macos", "helper_version": Self.helperVersion,
            "os_version": "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", "arch": arch,
            "pid": Int(getpid()), "ops": ops, "events": Ops.events.filter { handlers($0.op) != nil }.map(\.event),
        ]))
    }

    /// Callers hold the lock.
    private func cancel(_ id: Int, _ target: Int) {
        let cancelled = running.removeValue(forKey: target) != nil
        if cancelled { answer(target, .failure(code: "cancelled", message: "cancelled by request \(id)")) }
        answer(id, .success(["cancelled": cancelled]))
    }

    /// Callers hold the lock. Every request in flight gets its one answer before the shutdown answer (CONTRACT §6.1).
    private func shutdown(_ id: Int) -> Never {
        for target in running.keys.sorted() { answer(target, .failure(code: "cancelled", message: "the helper is shutting down")) }
        running.removeAll()
        answer(id, .success([:]))
        ControlListen.stop()
        exit(0)
    }
}
