// The pure parts of the control ops: snapshots and their lifetime, the text budget, the params checks of control.act,
// the events click and scroll post (recorded, never posted), control.listen's path, line, peer and token checks, and
// a watch's events waiting for its answer. Opens no window and sends no input.
import ApplicationServices
import CoreGraphics
import Darwin
@testable import HelperCore
import XCTest

final class ControlTests: XCTestCase {
    private let target = ControlTarget(pid: 42, appId: "com.example.app", windowId: 7,
                                       bounds: CGRect(x: 100, y: 50, width: 300, height: 200), launchedAt: 1)
    private let element = AXUIElementCreateApplication(42)

    func testSnapshotsLiveFifteenSeconds() {
        let snapshots = ControlSnapshots(prefix: "t")
        let id = snapshots.add(target, ["e0": element], now: 100)
        XCTAssertEqual(id, "o-t-1")
        XCTAssertEqual(snapshots.find(id, now: 114.9)?.target, target)
        XCTAssertNotNil(snapshots.find(id, now: 114.9)?.elements["e0"])
        XCTAssertNil(snapshots.find(id, now: 115))
        XCTAssertNil(snapshots.find(id, now: 99), "a clock that went back does not revive a snapshot")
    }

    func testSixteenSnapshotsAreKeptAndAnActionEndsThemAll() {
        let snapshots = ControlSnapshots(prefix: "t")
        let ids = (0..<17).map { snapshots.add(target, [:], now: 100 + Double($0) / 10) }
        XCTAssertNil(snapshots.find(ids[0], now: 102), "the oldest goes when a seventeenth comes")
        XCTAssertTrue(ids.dropFirst().allSatisfy { snapshots.find($0, now: 102) != nil })
        snapshots.invalidate()
        XCTAssertTrue(ids.allSatisfy { snapshots.find($0, now: 102) == nil })
    }

    func testSnapshotIdsOfAnotherHelperAreStale() {
        let first = ControlSnapshots(), second = ControlSnapshots()
        let id = first.add(target, [:], now: 100)
        XCTAssertNotNil(first.find(id, now: 100))
        XCTAssertNil(second.find(id, now: 100))
        XCTAssertNotEqual(second.add(target, [:], now: 100), id)
    }

    func testTextBudgetCountsScalarsAcrossFields() {
        var budget = ControlTextBudget(6)
        XCTAssertEqual(budget.take("密码好", most: 256), "密码好")
        XCTAssertFalse(budget.clipped)
        XCTAssertEqual(budget.take("abcdef", most: 512), "abc")
        XCTAssertTrue(budget.clipped)
        XCTAssertEqual(budget.take("more", most: 512), "")
        var field = ControlTextBudget(4000)
        XCTAssertEqual(field.take(String(repeating: "x", count: 300), most: 256).count, 256)
        XCTAssertTrue(field.clipped)
        XCTAssertEqual(field.left, 3744)
    }

    func testActParamsAreCheckedBeforeAnyAXCall() {
        func code(_ params: [String: Any]) -> String? {
            guard case let .failure(code, _, _)? = Control.paramsProblem(params) else { return nil }
            return code
        }
        XCTAssertEqual(code(["action": "press"]), "element_required")
        XCTAssertNil(code(["action": "press", "element_id": "e1"]))
        XCTAssertEqual(code(["action": "type", "element_id": "e1"]), "invalid_text")
        XCTAssertEqual(code(["action": "set_value", "element_id": "e1", "text": String(repeating: "é", count: 2049)]), "invalid_text")
        XCTAssertNil(code(["action": "set_value", "element_id": "e1", "text": String(repeating: "é", count: 2048)]))
        XCTAssertEqual(code(["action": "set_value", "text": "x"]), "element_required")
        XCTAssertEqual(code(["action": "click", "x": 1]), "invalid_point")
        XCTAssertNil(code(["action": "click", "x": 1, "y": 2.5]))
        XCTAssertEqual(code(["action": "scroll", "x": 1, "y": 2]), "invalid_scroll")
        XCTAssertNil(code(["action": "scroll", "x": 1, "y": 2, "delta_y": -3]))
    }

    func testReadRefusesWhileSecureInputIsOn() {
        let was = Control.secureInputOn
        Control.secureInputOn = { true }
        defer { Control.secureInputOn = was }
        let id = Control.snapshots.add(target, ["e0": element], now: Date().timeIntervalSince1970)
        guard case let .failure(code, _, _) = Control.read(["snapshot_id": id, "element_id": "e0"], cancelled: { false }) else { return XCTFail("read answered") }
        XCTAssertEqual(code, "secure_input")
    }

    func testClickIsADownAndAnUpAtThePointWithTheMarker() throws {
        let events = try XCTUnwrap(ControlInput.events("click", at: CGPoint(x: 112.5, y: 90)))
        XCTAssertEqual(events.map(\.type), [.leftMouseDown, .leftMouseUp])
        for event in events {
            XCTAssertEqual(event.location, CGPoint(x: 112.5, y: 90))
            XCTAssertEqual(event.getIntegerValueField(.eventSourceUserData), InputWatch.marker)
        }
    }

    func testScrollIsClampedToSixHundredAndMarked() throws {
        for (asked, sent) in [(5000, 600), (-5000, -600), (30, 30)] {
            let events = try XCTUnwrap(ControlInput.events("scroll", at: CGPoint(x: 10, y: 20), deltaY: asked))
            XCTAssertEqual(events.map(\.type), [.scrollWheel])
            XCTAssertEqual(events[0].location, CGPoint(x: 10, y: 20))
            XCTAssertEqual(events[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis1), Int64(sent))
            XCTAssertEqual(events[0].getIntegerValueField(.eventSourceUserData), InputWatch.marker)
        }
    }

    func testRecordingKeepsTheEventsAndPostsNone() throws {
        let was = ControlInput.record
        ControlInput.record = true
        defer { ControlInput.record = was }
        let before = ControlInput.recorded.count
        ControlInput.post(try XCTUnwrap(ControlInput.events("click", at: CGPoint(x: -100000, y: -100000))), to: getpid())
        let recorded = ControlInput.recorded.dropFirst(before)
        XCTAssertEqual(recorded.map(\.type), [.leftMouseDown, .leftMouseUp])
        XCTAssertTrue(recorded.allSatisfy { $0.getIntegerValueField(.eventSourceUserData) == InputWatch.marker })
    }

    func testListenPaths() {
        let dir = "/Users/me/run"
        XCTAssertNil(ControlListen.pathProblem(endpoint: "\(dir)/cc.sock", tokenFile: "\(dir)/cc.token"))
        XCTAssertNotNil(ControlListen.pathProblem(endpoint: "run/cc.sock", tokenFile: "run/cc.token"))
        XCTAssertNotNil(ControlListen.pathProblem(endpoint: "\(dir)/cc.sock", tokenFile: "/Users/me/cc.token"))
        XCTAssertNotNil(ControlListen.pathProblem(endpoint: "\(dir)/cc.sock", tokenFile: "\(dir)/cc.sock"))
        XCTAssertNotNil(ControlListen.pathProblem(endpoint: "\(dir)/cc.sock", tokenFile: "\(dir)/cc.sock\0.token"),
                        "the system sees a path up to its first NUL")
        XCTAssertNotNil(ControlListen.pathProblem(endpoint: "\(dir)/cc.token\0.sock", tokenFile: "\(dir)/cc.token"))
        let longest = "/" + String(repeating: "a", count: 98) + "/x.s"
        XCTAssertEqual(longest.utf8.count, 103)
        XCTAssertNil(ControlListen.pathProblem(endpoint: longest, tokenFile: "/" + String(repeating: "a", count: 98) + "/t"))
        XCTAssertNotNil(ControlListen.pathProblem(endpoint: longest + "x", tokenFile: "/" + String(repeating: "a", count: 98) + "/t"))
        XCTAssertNotNil(ControlListen.address(longest))
        XCTAssertNil(ControlListen.address(longest + "x"))
    }

    func testListenReplacesOnlyAnOldSocketAndTokenFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("c12-\(getpid())").path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let endpoint = "\(dir)/cc.sock", tokenFile = "\(dir)/cc.token", kept = "\(dir)/kept"
        func code(_ outcome: Outcome) -> String? {
            guard case let .failure(code, _, _) = outcome else { return nil }
            return code
        }
        func refused(_ why: String, _ make: () throws -> Void, leaves path: String) throws {
            try make()
            XCTAssertEqual(code(ControlListen.listen(["endpoint": endpoint, "token_file": tokenFile], liveRequest)), "endpoint_unavailable", why)
            ControlListen.stop()
            var info = stat()
            XCTAssertEqual(lstat(path, &info), 0, "\(why) is left alone")
            XCTAssertEqual(try? String(contentsOfFile: kept, encoding: .utf8), "mine", why)
            try FileManager.default.removeItem(atPath: path)
        }
        try "mine".write(toFile: kept, atomically: false, encoding: .utf8)
        try refused("a file at the endpoint", { try "mine".write(toFile: endpoint, atomically: false, encoding: .utf8) }, leaves: endpoint)
        try FileManager.default.removeItem(atPath: kept)
        try "mine".write(toFile: kept, atomically: false, encoding: .utf8)
        try refused("a link at the token file", { symlink(kept, tokenFile) }, leaves: tokenFile)
        // A socket nobody listens on and an old token, as a helper that crashed leaves them.
        let stale = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = try XCTUnwrap(ControlListen.address(endpoint))
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(stale, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        close(stale)
        XCTAssertEqual(bound, 0)
        try "old".write(toFile: tokenFile, atomically: false, encoding: .utf8)
        guard case .success = ControlListen.listen(["endpoint": endpoint, "token_file": tokenFile], liveRequest) else {
            return XCTFail("an old socket and token file are replaced")
        }
        ControlListen.stop()
    }

    func testTwoListensAtOnceMakeOneListener() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("c12-both-\(getpid())").path
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let lock = NSLock()
        var codes: [String] = []
        DispatchQueue.concurrentPerform(iterations: 2) { k in
            let outcome = ControlListen.listen(["endpoint": "\(dir)/\(k)/cc.sock", "token_file": "\(dir)/\(k)/cc.token"], liveRequest)
            let code: String
            if case let .failure(failed, _, _) = outcome { code = failed } else { code = "ok" }
            lock.withLock { codes.append(code) }
        }
        ControlListen.stop()
        XCTAssertEqual(codes.sorted(), ["already_running", "ok"])
    }

    func testACancelledListenLeavesNoListener() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("c12-cancel-\(getpid())").path
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let params = ["endpoint": "\(dir)/cc.sock", "token_file": "\(dir)/cc.token"]
        guard case let .failure(code, _, _) = ControlListen.listen(params, cancelledRequest) else {
            ControlListen.stop()
            return XCTFail("a cancelled listen answered")
        }
        XCTAssertEqual(code, "cancelled")
        var info = stat()
        XCTAssertNotEqual(lstat("\(dir)/cc.sock", &info), 0, "the socket is left")
        XCTAssertNotEqual(lstat("\(dir)/cc.token", &info), 0, "the token file is left")
        guard case .success = ControlListen.listen(params, liveRequest) else { return XCTFail("the cancelled listen still listens") }
        ControlListen.stop()
    }

    func testCommittedActionsGoAndCancelledOnesDoNot() {
        var posted = 0
        let action = { () -> Outcome in
            posted += 1
            return .success(["effect": "unverifiable"])
        }
        guard case .failure("cancelled", _, _) = Control.perform(cancelledRequest, action) else { return XCTFail("a cancelled action answered") }
        XCTAssertEqual(posted, 0, "the action went after its cancel")
        guard case .success = Control.perform(liveRequest, action) else { return XCTFail("a committed action did not answer") }
        XCTAssertEqual(posted, 1)
    }

    func testTokensCompareByEveryByte() {
        let token = Array("0123456789abcdef".utf8)
        XCTAssertTrue(ControlListen.constantTimeEqual(token, token))
        XCTAssertFalse(ControlListen.constantTimeEqual(token, Array("0123456789abcdeF".utf8)))
        XCTAssertFalse(ControlListen.constantTimeEqual(token, Array("0123456789abcde".utf8)))
        XCTAssertFalse(ControlListen.constantTimeEqual(token, []))
    }

    private func pair() -> (Int32, Int32) {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        var one: Int32 = 1
        for fd in fds { setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) }
        return (fds[0], fds[1])
    }

    func testALineIsAtMostSixtyFourKiB() {
        for (size, kept) in [(3, true), (ControlListen.maxLineBytes, true), (ControlListen.maxLineBytes + 1, false)] {
            let (reader, writer) = pair()
            let sender = Thread {
                _ = ControlListen.writeAll(writer, [UInt8](repeating: 0x61, count: size) + [0x0A, 0x62])
                close(writer)
            }
            sender.start()
            let line = ControlListen.readLine(reader, most: ControlListen.maxLineBytes)
            XCTAssertEqual(line?.count, kept ? size : nil, "a line of \(size) bytes")
            close(reader)
        }
        let (reader, writer) = pair()
        _ = ControlListen.writeAll(writer, Array("no newline".utf8))
        close(writer)
        XCTAssertNil(ControlListen.readLine(reader, most: ControlListen.maxLineBytes), "the stream ends before the newline")
        close(reader)
    }

    func testThePeerIsThisUser() {
        let (a, b) = pair()
        XCTAssertEqual(ControlListen.peerUID(a), getuid())
        close(a)
        close(b)
        XCTAssertNil(ControlListen.peerUID(-1))
    }

    func testAWatchHoldsItsEventsUntilItsAnswerIsOut() {
        let lock = NSLock()
        var sent: [String] = []
        Events.connect { name, _, live in
            guard name.hasPrefix("t."), live() else { return }
            lock.withLock { sent.append(name) }
        }
        let state = WatchState()
        let generation = state.start()
        state.send("t.first", [:], generation)
        state.send("t.second", [:], generation)
        XCTAssertEqual(lock.withLock { sent }, [], "nothing goes before the answer")
        state.answered()
        let deadline = Date().addingTimeInterval(2)
        while lock.withLock({ sent.count }) < 2 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        state.send("t.third", [:], generation)
        while lock.withLock({ sent.count }) < 3 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertEqual(lock.withLock { sent }, ["t.first", "t.second", "t.third"])
        state.stop()
        state.send("t.fourth", [:], generation)
        let restarted = state.start()
        state.send("t.old", [:], generation)
        state.answered()
        state.send("t.fifth", [:], restarted)
        let later = Date().addingTimeInterval(2)
        while lock.withLock({ sent.count }) < 4 && Date() < later { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertEqual(lock.withLock { sent }, ["t.first", "t.second", "t.third", "t.fifth"])
    }
}
