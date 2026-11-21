// right_option's poll over a scripted key state and clock: no hot key is registered and no key is read.
@testable import HelperCore
import XCTest

final class PushToTalkTests: XCTestCase {
    private func polls(_ reads: [(pressed: Bool, sinceKey: TimeInterval, now: TimeInterval)]) -> [String] {
        let sent = Recorder()
        Events.connect { name, _, _ in sent.add(name) }
        defer { Events.connect { _, _, _ in } }
        for read in reads { PushToTalk.poll(pressed: read.pressed, sinceKey: { read.sinceKey }, now: read.now) }
        return sent.names
    }

    func testAKeyTypedWhileHeldIsTypingNotSpeaking() {
        XCTAssertEqual(polls([(true, 9, 100), (true, 0.01, 100.05), (true, 0.06, 100.1), (false, 0.11, 100.15)]),
                       ["ptt.down", "ptt.typed", "ptt.up"])
    }

    /// A key typed after the last poll still counts as the key goes up.
    func testAKeyTypedJustBeforeTheReleaseIsCaughtAtTheRelease() {
        XCTAssertEqual(polls([(true, 9, 200), (true, 9.05, 200.05), (false, 0.01, 200.1)]), ["ptt.down", "ptt.typed", "ptt.up"])
    }

    func testAHoldWithoutTypingIsSpeaking() {
        XCTAssertEqual(polls([(true, 9, 300), (true, 9.05, 300.05), (false, 9.1, 300.1)]), ["ptt.down", "ptt.up"])
    }
}
