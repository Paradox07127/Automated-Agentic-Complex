// The pure parts of the fields CONTRACT §7.3, §7.4 and §8 added for the Electron shell: the focused window's AX title,
// the focused app's pid, the element and source keys, the value's text, the read at subscription time, the window of
// window and title notifications, the watch ids and the front app at workspace.watch.
@testable import HelperCore
import XCTest

final class AXWatchTests: XCTestCase {
    func testFrontCarriesTheFocusedWindowTitleOnlyWhenTitlesWereAsked() {
        let asked = Attention.front(pid: 7, name: "Notes", appId: "com.apple.Notes", window: NSNull(), category: nil,
                                    focusedWindowTitle: .some("Shopping"))
        XCTAssertEqual(asked["focused_window_title"] as? String, "Shopping")
        let unread = Attention.front(pid: 7, name: "Notes", appId: nil, window: NSNull(), category: nil, focusedWindowTitle: .some(nil))
        XCTAssertTrue(unread["focused_window_title"] is NSNull)
        let notAsked = Attention.front(pid: 7, name: "Notes", appId: nil, window: NSNull(), category: nil, focusedWindowTitle: nil)
        XCTAssertNil(notAsked["focused_window_title"])
        XCTAssertEqual(notAsked["pid"] as? Int, 7)
    }

    func testFocusedAnswerCarriesTheFocusedAppOnlyWithoutAPid() {
        let none = AXOps.focusedAnswer(NSNull(), appPid: .some(702))
        XCTAssertTrue(none["focus"] is NSNull)
        XCTAssertEqual(none["app_pid"] as? Int, 702)
        XCTAssertTrue(AXOps.focusedAnswer(NSNull(), appPid: .some(nil))["app_pid"] is NSNull)
        XCTAssertNil(AXOps.focusedAnswer(NSNull(), appPid: nil)["app_pid"])
    }

    func testElementCarriesItsKeyAndTheValueOnlyWhenAsked() {
        let plain = AXWatch.elementJSON(role: "AXTextArea", subrole: nil, title: nil, description: "Body", placeholder: nil, key: "42",
                                        window: (title: "notes.txt", doc: "/tmp/notes.txt"), valueLength: { 3 }, selected: nil,
                                        value: nil, secureInput: false)
        XCTAssertEqual(plain["element_key"] as? String, "42")
        XCTAssertEqual(plain["label"] as? String, "Body")
        XCTAssertEqual(plain["value_length"] as? Int, 3)
        XCTAssertNil(plain["value"])
        XCTAssertNil(plain["selected_text"])
        let typed = AXWatch.elementJSON(role: "AXTextArea", subrole: nil, title: nil, description: nil, placeholder: nil, key: "42",
                                        window: (title: nil, doc: nil), valueLength: { 3 }, selected: { "b" }, value: { "abc" },
                                        secureInput: false)
        XCTAssertEqual(typed["value"] as? String, "abc")
        XCTAssertEqual(typed["selected_text"] as? String, "b")
    }

    func testSecureInputKeepsTheSelectionAndTheValueUnread() {
        let typed = AXWatch.elementJSON(role: "AXTextArea", subrole: nil, title: nil, description: nil, placeholder: nil, key: "42",
                                        window: (title: nil, doc: nil), valueLength: { 3 },
                                        selected: { XCTFail("read the selection"); return "b" },
                                        value: { XCTFail("read the value"); return "abc" }, secureInput: true)
        XCTAssertTrue(typed["selected_text"] is NSNull)
        XCTAssertTrue(typed["value"] is NSNull)
        XCTAssertEqual(typed["value_length"] as? Int, 3)
    }

    func testPasswordElementGivesRolesAndKeyAndANullValueWithoutReadingIt() {
        let secure = AXWatch.elementJSON(role: "AXTextField", subrole: "AXSecureTextField", title: nil, description: nil, placeholder: nil,
                                         key: "9", window: (title: "Login", doc: nil),
                                         valueLength: { XCTFail("read the length"); return 1 },
                                         selected: { XCTFail("read the selection"); return nil },
                                         value: { XCTFail("read the value"); return nil }, secureInput: false)
        XCTAssertEqual(secure["element_key"] as? String, "9")
        XCTAssertTrue(secure["value_length"] is NSNull)
        XCTAssertTrue(secure["value"] is NSNull)
        XCTAssertNil(secure["selected_text"])
        XCTAssertEqual(secure["window_title"] as? String, "Login")
    }

    func testValueTextAsActivityRecorderReadsIt() {
        XCTAssertEqual(AXRules.valueText(length: 0, ranged: { _ in XCTFail("ranged read"); return nil }, plain: { nil }), "")
        XCTAssertEqual(AXRules.valueText(length: 3, ranged: { $0 == 3 ? "abc" : nil }, plain: { "plain" }), "abc")
        XCTAssertEqual(AXRules.valueText(length: 3, ranged: { _ in nil }, plain: { "plain" }), "plain")
        XCTAssertEqual(AXRules.valueText(length: nil, ranged: { _ in XCTFail("ranged read"); return nil }, plain: { "plain" }), "plain")
    }

    func testNotificationDataCarriesTheSourceTheWindowAndTheWatchId() {
        let value = AXWatch.notificationData(pid: 702, kind: "value", element: NSNull(), sourceKey: "5", window: nil, watchId: "")
        XCTAssertEqual(value["source_key"] as? String, "5")
        XCTAssertNil(value["window"])
        XCTAssertNil(value["watch_id"])
        let title = AXWatch.notificationData(pid: 702, kind: "title", element: NSNull(), sourceKey: "5",
                                             window: ["title": "renamed", "doc": NSNull()], watchId: "activity")
        XCTAssertEqual((title["window"] as? [String: Any])?["title"] as? String, "renamed")
        XCTAssertEqual(title["watch_id"] as? String, "activity")
        XCTAssertEqual(["window", "title"].filter(AXWatch.readsWindow), ["window", "title"])
        XCTAssertEqual(["focus", "value", "selection"].filter(AXWatch.readsWindow), [])
    }

    func testWatchIdsKeepTheirOwnSubscriptions() {
        XCTAssertEqual(AXWatch.watchId([:]), "")
        XCTAssertEqual(AXWatch.watchId(["watch_id": "activity"]), "activity")
        XCTAssertFalse(AXWatch.state("activity") === AXWatch.state("context"))
        XCTAssertTrue(AXWatch.state("activity") === AXWatch.state("activity"))
        XCTAssertTrue(AXWatch.state("") === AXWatch.state(""))
    }

    func testWatchResultAtSubscriptionAndAtStop() {
        let started = AXWatch.result(pid: 702, watchId: "activity", element: NSNull(), window: ["title": "t", "doc": NSNull()], manual: true)
        XCTAssertEqual(started["watching"] as? Bool, true)
        XCTAssertEqual(started["watch_id"] as? String, "activity")
        XCTAssertTrue(started["element"] is NSNull)
        XCTAssertEqual(started["manual_accessibility"] as? Bool, true)
        let stopped = AXWatch.result(pid: nil, watchId: "", element: nil, window: nil, manual: nil)
        XCTAssertEqual(stopped as NSDictionary, ["watching": false, "pid": NSNull()] as NSDictionary)
    }

    func testAWatchWhoseCommitFindsItCancelledIsTakenDown() throws {
        try XCTSkipUnless(AX.trusted, "ax.watch subscribes only with the Accessibility grant")
        let params: [String: Any] = ["pid": Int(getpid()), "notifications": ["focus"], "watch_id": "cancel-test"]
        guard case let .failure(code, _, _) = AXWatch.watch(params, cancelledRequest) else { return XCTFail("a cancelled watch answered") }
        XCTAssertEqual(code, "cancelled")
        XCTAssertFalse(AXWatch.state("cancel-test").on, "the cancelled watch is still on")
        guard case .success = AXWatch.watch(params, liveRequest) else { return XCTFail("a committed watch did not answer") }
        XCTAssertTrue(AXWatch.state("cancel-test").on)
        _ = AXWatch.watch(["pid": NSNull(), "notifications": [], "watch_id": "cancel-test"], liveRequest)
        XCTAssertFalse(AXWatch.state("cancel-test").on)
    }

    func testWorkspaceWatchAnswersTheFrontAppWhenTurnedOn() {
        XCTAssertEqual(Workspace.result(enabled: true, frontPid: 702) as NSDictionary, ["watching": true, "front_pid": 702] as NSDictionary)
        XCTAssertTrue(Workspace.result(enabled: true, frontPid: nil)["front_pid"] is NSNull)
        XCTAssertEqual(Workspace.result(enabled: false, frontPid: 702) as NSDictionary, ["watching": false] as NSDictionary)
    }
}
