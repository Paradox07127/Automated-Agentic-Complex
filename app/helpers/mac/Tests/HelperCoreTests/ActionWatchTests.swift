// input.actions without an event tap: which presses become an input.action, their keys, and the merged clicks.
import CoreGraphics
@testable import HelperCore
import XCTest

final class ActionWatchTests: XCTestCase {
    private func action(_ flags: CGEventFlags, _ keyCode: Int64, _ character: String?) -> ActionWatch.KeyAction? {
        ActionWatch.keyAction(flags: flags, keyCode: keyCode, character: { character })
    }

    func testAShortcutListsItsModifiersInOrderThenThePlainKey() {
        XCTAssertEqual(action([.maskCommand, .maskShift], 35, "p"), ActionWatch.KeyAction(kind: "shortcut", keys: "shift+cmd+p"))
        XCTAssertEqual(action([.maskCommand, .maskShift, .maskAlternate, .maskControl], 40, "K"),
                       ActionWatch.KeyAction(kind: "shortcut", keys: "ctrl+alt+shift+cmd+k"))
        XCTAssertEqual(action(.maskControl, 105, nil), ActionWatch.KeyAction(kind: "shortcut", keys: "ctrl+key105"))
        XCTAssertEqual(action(.maskCommand, 36, "\r"), ActionWatch.KeyAction(kind: "shortcut", keys: "cmd+return"))
    }

    func testReturnOrEnterWithoutCommandControlOrOptionIsASubmit() {
        let submit = ActionWatch.KeyAction(kind: "submit", keys: "return")
        XCTAssertEqual(ActionWatch.keyAction(flags: [], keyCode: 36, character: { XCTFail("read the character"); return nil }), submit)
        XCTAssertEqual(ActionWatch.keyAction(flags: [], keyCode: 76, character: { XCTFail("read the character"); return nil }), submit)
        XCTAssertNil(ActionWatch.keyAction(flags: .maskShift, keyCode: 36, character: { XCTFail("read the character"); return nil }))
    }

    func testOtherKeysSendNothingAndReadNoCharacter() {
        let unread = { () -> String? in
            XCTFail("read the character")
            return nil
        }
        XCTAssertNil(ActionWatch.keyAction(flags: [], keyCode: 0, character: unread))
        XCTAssertNil(ActionWatch.keyAction(flags: .maskShift, keyCode: 0, character: unread))
        XCTAssertNil(ActionWatch.keyAction(flags: [.maskShift, .maskAlphaShift], keyCode: 49, character: unread))
    }

    func testMouseKinds() {
        XCTAssertEqual(ActionWatch.mouseKind(.leftMouseUp), "click")
        XCTAssertEqual(ActionWatch.mouseKind(.rightMouseDown), "context_menu")
    }

    func testRepeatedClicksOnOneControlWithin150MsAreOne() {
        var throttle = ClickThrottle()
        XCTAssertTrue(throttle.allow("702:a", at: 10))
        XCTAssertFalse(throttle.allow("702:a", at: 10.1))
        XCTAssertTrue(throttle.allow("702:b", at: 10.12))
        XCTAssertTrue(throttle.allow("702:a", at: 10.2))
        XCTAssertTrue(throttle.allow("702:a", at: 10.35))
    }
}
