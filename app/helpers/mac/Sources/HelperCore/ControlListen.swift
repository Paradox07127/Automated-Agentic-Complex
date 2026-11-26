import Darwin
import Foundation

/// `control.listen` and `control.respond`: a Unix socket in a directory of this
/// user (0700), a 0600 token file next to it, connections of this user only, one request of at most 64 KiB per
/// connection, its token compared in constant time, and at most 4 connections reading their request at once. Each
/// request goes to the main process as `control.request` without its token; `control.respond` writes the answer and
/// closes the connection.
enum ControlListen {
    static let maxPathBytes = 103
    static let maxLineBytes = 65_536
    static let maxConnections = 4
    static let ioSeconds = 2

    private final class Listener {
        let fd: Int32
        let source: DispatchSourceRead
        let endpoint: String
        let tokenFile: String
        let token: [UInt8]
        var accepting = false

        init(fd: Int32, source: DispatchSourceRead, endpoint: String, tokenFile: String, token: [UInt8]) {
            self.fd = fd
            self.source = source
            self.endpoint = endpoint
            self.tokenFile = tokenFile
            self.token = token
        }
    }

    /// A connection whose request went out and waits for `control.respond`; its source sees the peer hang up.
    private struct Waiting {
        let fd: Int32
        let source: DispatchSourceRead
    }

    private static let lock = NSLock()
    private static var listener: Listener?
    private static var starting = false  // a listen is past its check and has not set `listener` yet
    private static var waiting: [Int: Waiting] = [:]
    private static var open = 0  // connections accepted and still reading their request
    private static var lastConn = 0
    private static let queue = DispatchQueue(label: "ac-helper.control-listen")

    private static func unavailable(_ why: String) -> Outcome { .failure(code: "endpoint_unavailable", message: why) }

    /// The checks on the two paths alone; nil when they pass.
    static func pathProblem(endpoint: String, tokenFile: String) -> String? {
        guard endpoint.hasPrefix("/"), tokenFile.hasPrefix("/") else { return "the endpoint and the token file need absolute paths" }
        guard !endpoint.contains("\0"), !tokenFile.contains("\0") else { return "the endpoint or the token file holds a NUL" }
        guard endpoint.utf8.count <= maxPathBytes else { return "the endpoint is longer than 103 bytes" }
        guard !endpoint.hasSuffix("/"), !tokenFile.hasSuffix("/"), endpoint != tokenFile else { return "the endpoint and the token file need two file names" }
        let dir = (endpoint as NSString).deletingLastPathComponent
        guard dir == (tokenFile as NSString).deletingLastPathComponent else { return "the token file must be in the endpoint's directory" }
        return nil
    }

    static func listen(_ params: [String: Any], _ request: Request) -> Outcome {
        let endpoint = params["endpoint"] as! String, tokenFile = params["token_file"] as! String
        let first = lock.withLock { () -> Bool in
            guard listener == nil, !starting else { return false }
            starting = true
            return true
        }
        guard first else { return .failure(code: "already_running", message: "this helper listens already") }
        defer { lock.withLock { starting = false } }
        if let problem = pathProblem(endpoint: endpoint, tokenFile: tokenFile) { return unavailable(problem) }
        let dir = (endpoint as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            return unavailable("the endpoint's directory could not be made")
        }
        var info = stat()
        guard lstat(dir, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), chmod(dir, 0o700) == 0 else {
            return unavailable("the endpoint's directory is no directory of this user")
        }
        if accepts(endpoint) { return .failure(code: "already_running", message: "another process listens on the endpoint") }
        // Only what an earlier listener leaves is replaced: this user's token file and socket.
        for (path, kind) in [(tokenFile, S_IFREG), (endpoint, S_IFSOCK)] where lstat(path, &info) == 0 {
            guard info.st_mode & S_IFMT == kind, info.st_uid == getuid() else {
                return unavailable("\(path) exists and is no \(kind == S_IFREG ? "token file" : "socket") of this user")
            }
        }
        var token = [UInt8](repeating: 0, count: 32)
        arc4random_buf(&token, token.count)
        let text = Array(token.map { String(format: "%02x", $0) }.joined().utf8)
        // The directory is this user's alone; the token file is made anew and never followed as a link.
        unlink(tokenFile)
        let file = Darwin.open(tokenFile, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { return unavailable("the token file could not be made") }
        let wrote = fchmod(file, 0o600) == 0 && writeAll(file, text)
        close(file)
        guard wrote else {
            unlink(tokenFile)
            return unavailable("the token file could not be written")
        }
        unlink(endpoint)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0, var address = address(endpoint) else {
            if fd >= 0 { close(fd) }
            unlink(tokenFile)
            return unavailable("no socket could be made")
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 }
        }
        guard bound, chmod(endpoint, 0o600) == 0, Darwin.listen(fd, Int32(maxConnections)) == 0 else {
            close(fd)
            unlink(endpoint)
            unlink(tokenFile)
            return unavailable("the endpoint could not be bound")
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        let made = Listener(fd: fd, source: source, endpoint: endpoint, tokenFile: tokenFile, token: text)
        source.setEventHandler { acceptAll(made) }
        source.setCancelHandler { close(fd) }
        guard request.commit() else {
            // Cancelled first, so that it takes no connection; a suspended source runs its cancel handler only once resumed.
            source.cancel()
            source.resume()
            unlink(endpoint)
            unlink(tokenFile)
            return .cancelled
        }
        lock.withLock { listener = made }
        return .success(["endpoint": endpoint])
    }

    /// control.listen's answer is out: connections are taken from now on, so control.request follows it.
    static func answered(_ params: [String: Any]) {
        lock.withLock {
            guard let listener, !listener.accepting else { return }
            listener.accepting = true
            listener.source.resume()
        }
    }

    static func respond(_ params: [String: Any]) -> Outcome {
        let conn = JSON.int(params["conn"])!
        guard let found = lock.withLock({ waiting.removeValue(forKey: conn) }) else {
            return .failure(code: "conn_gone", message: "connection \(conn) is closed or already answered")
        }
        defer { found.source.cancel() }
        guard var line = JSON.dump(params["response"] as! [String: Any]) else {
            return .failure(code: "internal", message: "the response cannot be written as JSON")
        }
        line.append(0x0A)
        guard writeAll(found.fd, Array(line)) else {
            return .failure(code: "conn_gone", message: "connection \(conn) hung up")
        }
        return .success(["sent": true])
    }

    /// Shutdown and stdin closing: the endpoint and the token file go.
    static func stop() {
        lock.withLock {
            guard let listener else { return }
            if !listener.accepting { listener.source.resume() }
            listener.source.cancel()
            unlink(listener.endpoint)
            unlink(listener.tokenFile)
            self.listener = nil
            for (_, conn) in waiting { conn.source.cancel() }
            waiting.removeAll()
        }
    }

    /// Something accepts connections at `path`.
    private static func accepts(_ path: String) -> Bool {
        guard var address = address(path) else { return false }
        let probe = socket(AF_UNIX, SOCK_STREAM, 0)
        guard probe >= 0 else { return false }
        defer { close(probe) }
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 }
        }
    }

    static func address(_ path: String) -> sockaddr_un? {
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        return address
    }

    private static func acceptAll(_ from: Listener) {
        while true {
            let client = accept(from.fd, nil, nil)
            guard client >= 0 else { return }
            let admitted = lock.withLock { () -> Bool in
                guard listener === from, open < maxConnections else { return false }
                open += 1
                return true
            }
            guard admitted else {
                close(client)
                continue
            }
            DispatchQueue.global(qos: .userInitiated).async { serve(client, from) }
        }
    }

    private static func closed(_ fd: Int32) {
        close(fd)
        lock.withLock { open -= 1 }
    }

    private static func serve(_ fd: Int32, _ from: Listener) {
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        // Accepted sockets inherit O_NONBLOCK from the listener; the timeouts below govern reads and writes.
        _ = fcntl(fd, F_SETFL, 0)
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        guard peerUID(fd) == getuid() else { return closed(fd) }
        var timeout = timeval(tv_sec: ioSeconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        guard let line = readLine(fd, most: maxLineBytes), var request = JSON.parse(line) as? [String: Any] else { return closed(fd) }
        guard let sent = request["token"] as? String, constantTimeEqual(Array(sent.utf8), from.token) else {
            let refusal: [String: Any] = ["id": request["id"] ?? NSNull(), "error": ["code": "unauthorized", "message": "the token is not valid"]]
            if var data = JSON.dump(refusal) {
                data.append(0x0A)
                _ = writeAll(fd, Array(data))
            }
            return closed(fd)
        }
        request.removeValue(forKey: "token")
        // The slot is for reading: the main process bounds the requests it runs and lets desktop_cancel past them.
        lock.withLock { open -= 1 }
        let hangUp = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        hangUp.setCancelHandler { close(fd) }
        let conn = lock.withLock { () -> Int? in
            guard listener === from else { return nil }
            lastConn += 1
            waiting[lastConn] = Waiting(fd: fd, source: hangUp)
            return lastConn
        }
        guard let conn else {
            hangUp.resume()
            return hangUp.cancel()
        }
        hangUp.setEventHandler {
            // One request per connection: more bytes are dropped; the end of the stream frees the slot.
            var scratch = [UInt8](repeating: 0, count: 512)
            let got = read(fd, &scratch, scratch.count)
            guard got == 0 || (got < 0 && errno != EINTR && errno != EAGAIN) else { return }
            if lock.withLock({ waiting.removeValue(forKey: conn) }) != nil { hangUp.cancel() }
        }
        hangUp.resume()
        Events.emit("control.request", ["conn": conn, "request": request], live: { lock.withLock { listener === from } })
    }

    /// One line of at most `most` bytes before its newline; nil on a longer line, a timeout or the end of the stream.
    static func readLine(_ fd: Int32, most: Int) -> ArraySlice<UInt8>? {
        var data: [UInt8] = []
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            if let newline = data.firstIndex(of: 0x0A) { return newline <= most ? data[..<newline] : nil }
            guard data.count <= most else { return nil }
            let got = read(fd, &buffer, buffer.count)
            if got < 0 && errno == EINTR { continue }
            guard got > 0 else { return nil }
            data += buffer[..<got]
        }
    }

    static func writeAll(_ fd: Int32, _ bytes: [UInt8]) -> Bool {
        var offset = 0
        while offset < bytes.count {
            let wrote = bytes[offset...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if wrote < 0 && errno == EINTR { continue }
            guard wrote > 0 else { return false }
            offset += wrote
        }
        return true
    }

    /// The user id of the process at the other end of a Unix socket.
    static func peerUID(_ fd: Int32) -> uid_t? {
        var credentials = xucred()
        var length = socklen_t(MemoryLayout<xucred>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &credentials, &length) == 0,
              length == socklen_t(MemoryLayout<xucred>.size), credentials.cr_version == UInt32(XUCRED_VERSION) else { return nil }
        return credentials.cr_uid
    }

    /// Equal bytes, in time that depends on the length only.
    static func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
