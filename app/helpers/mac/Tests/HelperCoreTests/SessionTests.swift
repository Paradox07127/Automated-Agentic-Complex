// The session layer over a pipe with stand-in handlers, the cancellation of the capture and OCR ops, JSON integers and
// a watch's held events.
import CoreGraphics
import Darwin
@testable import HelperCore
import XCTest

/// The lines a session writes into a pipe, read on a thread of their own so that a long line cannot block the writer.
private final class Lines: @unchecked Sendable {
    let input: Int32
    private let lock = NSLock()
    private let arrived = DispatchSemaphore(value: 0)
    private var lines: [Data] = []

    init() {
        var fds: [Int32] = [0, 0]
        precondition(pipe(&fds) == 0)
        input = fds[1]
        let output = fds[0]
        Thread { [self] in
            var pending: [UInt8] = []
            var chunk = [UInt8](repeating: 0, count: 1 << 16)
            while true {
                let got = chunk.withUnsafeMutableBytes { read(output, $0.baseAddress, $0.count) }
                if got <= 0 { return }
                var start = pending.count
                pending.append(contentsOf: chunk[0..<got])
                while let newline = pending[start...].firstIndex(of: 0x0A) {
                    let line = Data(pending[0..<newline])
                    pending.removeFirst(newline + 1)
                    start = 0
                    lock.withLock { lines.append(line) }
                    arrived.signal()
                }
            }
        }.start()
    }

    /// The next line without its newline, or nil when none came within `seconds`.
    func next(_ seconds: TimeInterval = 10) -> Data? {
        guard arrived.wait(timeout: .now() + seconds) == .success else { return nil }
        return lock.withLock { lines.removeFirst() }
    }
}

final class SessionTests: XCTestCase {
    private func started(_ handlers: [String: Handler]) -> (Session, Lines) {
        let lines = Lines()
        let session = Session(output: lines.input, handlers: { handlers[$0] })
        send(session, ["v": 1, "id": 1, "op": "hello", "params": ["protocol": 1, "client": "tests"]])
        XCTAssertNotNil(lines.next(), "hello answers")
        return (session, lines)
    }

    private func send(_ session: Session, _ message: [String: Any]) {
        session.handleLine(ArraySlice([UInt8](JSON.dump(message)!)))
    }

    private func object(_ line: Data?) -> [String: Any] {
        line.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
    }

    private func code(_ message: [String: Any]) -> String? { (message["error"] as? [String: Any])?["code"] as? String }

    private func code(_ outcome: Outcome) -> String? {
        if case let .failure(code, _, _) = outcome { return code }
        return nil
    }

    func testARequestCancelledBeforeItStartsNeverRuns() {
        var ran = false
        let (session, lines) = started(["screens.list": Handler(onMain: true, run: { _ in
            ran = true
            return .success([:])
        })])
        // The main-thread job waits for this test to give the main run loop a turn.
        send(session, ["v": 1, "id": 2, "op": "screens.list", "params": [:]])
        send(session, ["v": 1, "id": 3, "op": "cancel", "params": ["target": 2]])
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertFalse(ran, "the handler of a cancelled request ran")
        let target = object(lines.next())
        XCTAssertEqual(target["id"] as? Int, 2)
        XCTAssertEqual(code(target), "cancelled")
        XCTAssertEqual(object(lines.next())["result"] as? [String: Bool], ["cancelled": true])
        XCTAssertNil(lines.next(0.2), "one answer each")
    }

    func testWaitForCancelsItsTaskWhenCancelledOrPastItsTime() {
        for (seconds, cancelled) in [(5.0, true), (0.2, false)] {
            let stopped = DispatchSemaphore(value: 0)
            let cancelAt = Date().addingTimeInterval(cancelled ? 0.2 : 60)
            let got = waitFor(seconds, cancelled: { Date() >= cancelAt }) { () async -> Bool in
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { stopped.signal() }
                return true
            }
            XCTAssertNil(got)
            XCTAssertEqual(stopped.wait(timeout: .now() + 1), .success, "the task is still running (cancelled \(cancelled))")
        }
    }

    func testTheCapturesStopWhenCancelled() throws {
        try XCTSkipUnless(ScreenGrant.granted, "the capture checks run only with the Screen Recording grant")
        let window = Ops.handler("capture.window")!.run(["window_id": 2147483000], { true })
        XCTAssertEqual(code(window), "timeout", "capture.window went on after its cancel")
        let ambient = Ops.handler("capture.ambient")!.run(["source": "screen", "side": 2, "exclude_pids": [Int(getpid())]], { true })
        XCTAssertEqual(code(ambient), "timeout", "capture.ambient went on after its cancel")
    }

    func testOCRStopsWhenCancelled() throws {
        try XCTSkipIf(OCR.supported().isEmpty, "Vision offers no language here")
        let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let png = Capture.encode(context.makeImage()!, jpeg: false, maxLongSide: nil)!
        let image: [String: Any] = ["format": "png", "width": 8, "height": 8, "data": png.data.base64EncodedString()]
        XCTAssertNil(code(Ops.handler("ocr.recognize")!.run(["image": image], { false })), "an 8 px image is recognized")
        XCTAssertEqual(code(Ops.handler("ocr.recognize")!.run(["image": image], { true })), "cancelled",
                       "ocr.recognize went on after its cancel")
    }

    func testAnAnswerOverMaxLineBytesIsAnInternalError() {
        let around = JSON.dump(["v": 1, "id": 2, "ok": true, "result": ["pad": ""]])!.count
        let fits = Session.maxLineBytes - 1 - around  // the pad of a line of exactly max_line_bytes, newline included
        var pad = 0
        let (session, lines) = started(["screens.list": Handler(onMain: false, run: { _ in
            .success(["pad": String(repeating: "x", count: pad)])
        })])
        pad = fits
        send(session, ["v": 1, "id": 2, "op": "screens.list", "params": [:]])
        let exact = lines.next()
        XCTAssertEqual(exact.map { $0.count + 1 }, Session.maxLineBytes)
        XCTAssertEqual(object(exact)["ok"] as? Bool, true)
        pad = fits + 1
        send(session, ["v": 1, "id": 3, "op": "screens.list", "params": [:]])
        let over = lines.next()
        XCTAssertLessThan(over?.count ?? .max, Session.maxLineBytes, "the answer is over max_line_bytes")
        guard (over?.count ?? .max) < Session.maxLineBytes else { return }
        XCTAssertEqual(object(over)["id"] as? Int, 3)
        XCTAssertEqual(code(object(over)), "internal")
    }

    func testAnEventOverMaxLineBytesIsDropped() {
        let (session, lines) = started([:])
        session.emit("workspace.changed", ["pad": String(repeating: "x", count: Session.maxLineBytes)], { true })
        session.emit("workspace.changed", ["reason": "activated", "front_pid": 1], { true })
        let line = lines.next()
        XCTAssertLessThan(line?.count ?? .max, Session.maxLineBytes, "the event over max_line_bytes went out")
        let next = object(line)
        XCTAssertEqual(next["data"] as? [String: AnyHashable], ["reason": "activated", "front_pid": 1],
                       "the event over max_line_bytes went out")
        XCTAssertEqual(next["seq"] as? Int, 1, "a dropped event takes no seq")
    }

    func testJSONIntegersOutsideIntAreNotInts() {
        func int(_ text: String) -> Int? { JSON.int(JSON.parse(ArraySlice(Array(text.utf8)))) }
        XCTAssertEqual(int("9223372036854775807"), Int.max)
        XCTAssertEqual(int("-9223372036854775808"), Int.min)
        XCTAssertNil(int("9223372036854775808"))
        XCTAssertNil(int("18446744073709551615"), "UInt64.max wraps to -1")
    }

    func testADisplayIdOutsideCGDirectDisplayIDIsNoDisplay() throws {
        // The wallpaper is looked up on the main thread, as on the ops queue.
        func wallpaper(_ display: Int) -> String? {
            var got: Outcome?
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                got = Capture.ambient(["source": "wallpaper", "side": 1, "display_id": display], { false })
                done.signal()
            }
            while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
            return code(got!)
        }
        let main = Int(CGMainDisplayID())
        try XCTSkipIf(wallpaper(main) != nil, "the main display's wallpaper cannot be read here")
        XCTAssertEqual(wallpaper(main + (1 << 32)), "capture_failed", "the main display id plus 2^32 reads the main display")
    }

    func testTwoAcknowledgementsKeepTheHeldEventsInOrder() {
        let lock = NSLock()
        var sent: [String] = []
        Events.connect { name, _, live in
            guard name.hasPrefix("o."), live() else { return }
            // The first held event takes long enough for a second drainer to overtake it.
            if name == "o.0" { Thread.sleep(forTimeInterval: 0.1) }
            lock.withLock { sent.append(name) }
        }
        let state = WatchState()
        let generation = state.start()
        for k in 0..<4 { state.send("o.\(k)", [:], generation) }
        state.answered()
        state.answered()
        state.send("o.4", [:], generation)
        let deadline = Date().addingTimeInterval(2)
        while lock.withLock({ sent.count }) < 5 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertEqual(lock.withLock { sent }, ["o.0", "o.1", "o.2", "o.3", "o.4"])
        state.stop()
    }
}
