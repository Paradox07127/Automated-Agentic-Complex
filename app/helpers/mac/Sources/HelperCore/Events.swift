import Foundation

/// CONTRACT §8: where the watches' events go. The session connects itself; an event is written only after hello, and
/// only while `live` holds, checked under the session's lock so that nothing follows the answer that turned it off.
enum Events {
    private static let lock = NSLock()
    private static var sink: ((String, [String: Any], () -> Bool) -> Void)?

    static func connect(_ write: @escaping (String, [String: Any], () -> Bool) -> Void) {
        lock.withLock { sink = write }
    }

    static func emit(_ name: String, _ data: [String: Any], live: @escaping () -> Bool) {
        lock.withLock { sink }?(name, data, live)
    }
}

/// One watch's on and off. Each start opens a generation; events of an older one are dropped. A generation's events wait
/// until the answer that started it is out (`answered`), then follow it in their order.
final class WatchState: @unchecked Sendable {
    /// The replay's switch: each watch sends one event of its own as it starts, to show that it follows the answer.
    static let probe = ProcessInfo.processInfo.environment["AC_HELPER_WATCH_PROBE"] != nil
    private let lock = NSLock()
    /// One drainer at a time, so that held events go in their order and before the live ones.
    private let drain = DispatchQueue(label: "ac-helper.watch-drain")
    private var generation = 0
    private var running = false
    private var opened = false  // the answer that started this generation is out and `held` is sent
    private var held: [(String, [String: Any])] = []

    var on: Bool { lock.withLock { running } }

    /// The new generation, for `live`.
    func start() -> Int {
        lock.withLock {
            generation += 1
            running = true
            opened = false
            held = []
            return generation
        }
    }

    func stop() {
        lock.withLock {
            generation += 1
            running = false
            opened = false
            held = []
        }
    }

    func live(_ started: Int) -> Bool { lock.withLock { running && generation == started } }

    /// An event of generation `started`; it waits while that generation's answer is not out.
    func send(_ name: String, _ data: [String: Any], _ started: Int) {
        let now = lock.withLock { () -> Bool in
            guard running && generation == started else { return false }
            if !opened { held.append((name, data)) }
            return opened
        }
        if now { Events.emit(name, data, live: { self.live(started) }) }
    }

    /// The watch op's success answer is out: the held events go, then the others as they come. It runs under the
    /// session's lock (`Handler.answered`), which writing an event takes, so the held ones go from another queue.
    func answered(_ params: [String: Any] = [:]) {
        let started = lock.withLock { generation }
        drain.async { [self] in
            while let (name, data) = lock.withLock({ () -> (String, [String: Any])? in
                guard running && generation == started, !opened else { return nil }
                guard !held.isEmpty else {
                    opened = true
                    return nil
                }
                return held.removeFirst()
            }) {
                Events.emit(name, data, live: { self.live(started) })
            }
        }
    }
}
