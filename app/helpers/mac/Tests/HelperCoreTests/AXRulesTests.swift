// The pure rules of the AX ops: password nodes, editable roles, carets, dialog buttons, banners, IME windows, window
// matching and the focus window, in CG global points.
import CoreGraphics
@testable import HelperCore
import XCTest

final class AXRulesTests: XCTestCase {
    func testSecureNodesByRoleSubroleTitleOrDescription() {
        XCTAssertTrue(AXRules.isSecure(role: "AXTextField", subrole: "AXSecureTextField", title: nil, description: nil))
        XCTAssertTrue(AXRules.isSecure(role: "AXTextField", subrole: nil, title: "Password", description: nil))
        XCTAssertTrue(AXRules.isSecure(role: "AXTextField", subrole: nil, title: nil, description: "请输入密码"))
        XCTAssertTrue(AXRules.isSecure(role: "AXTextField", subrole: nil, title: "交易口令", description: nil))
        XCTAssertFalse(AXRules.isSecure(role: "AXTextArea", subrole: nil, title: "Notes", description: "body"))
    }

    func testEditableRolesAndSubroles() {
        XCTAssertTrue(AXRules.isEditable(role: "AXTextArea", subrole: nil))
        XCTAssertTrue(AXRules.isEditable(role: "AXComboBox", subrole: nil))
        XCTAssertTrue(AXRules.isEditable(role: "AXGroup", subrole: "AXSearchField"))
        XCTAssertTrue(AXRules.isEditable(role: nil, subrole: "AXSecureTextField"))
        XCTAssertFalse(AXRules.isEditable(role: "AXButton", subrole: nil))
        XCTAssertFalse(AXRules.isEditable(role: nil, subrole: nil))
    }

    func testCaretMustBeTallEnoughAndNearTheField() {
        let field = CGRect(x: 100, y: 100, width: 300, height: 40)
        XCTAssertEqual(AXRules.caret(bounds: CGRect(x: 120, y: 110, width: 0, height: 16), field: field),
                       CGRect(x: 120, y: 110, width: 2, height: 16))
        XCTAssertEqual(AXRules.caret(bounds: CGRect(x: 120, y: 110, width: 8, height: 16), field: field),
                       CGRect(x: 120, y: 110, width: 8, height: 16))
        XCTAssertNil(AXRules.caret(bounds: CGRect(x: 120, y: 110, width: 1, height: 3), field: field))
        XCTAssertNil(AXRules.caret(bounds: CGRect(x: 900, y: 110, width: 1, height: 16), field: field))
        XCTAssertNotNil(AXRules.caret(bounds: CGRect(x: 70, y: 70, width: 1, height: 16), field: field))
        XCTAssertNil(AXRules.caret(bounds: nil, field: field))
    }

    func testDialogButtonsOnlyForDialogsAndSheets() {
        let buttons = [CGRect(x: 1, y: 2, width: 80, height: 28)]
        XCTAssertEqual(AXRules.dialogButtons(windowSubrole: "AXDialog", hasSheet: false, buttons: buttons), buttons)
        XCTAssertEqual(AXRules.dialogButtons(windowSubrole: "AXSystemDialog", hasSheet: false, buttons: buttons), buttons)
        XCTAssertEqual(AXRules.dialogButtons(windowSubrole: "AXStandardWindow", hasSheet: true, buttons: buttons), buttons)
        XCTAssertEqual(AXRules.dialogButtons(windowSubrole: "AXStandardWindow", hasSheet: false, buttons: buttons), [])
    }

    func testBannersAreBannerSizedAndOnTheScreen() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let banner = CGRect(x: 1080, y: 40, width: 344, height: 72)
        let frames = [screen, banner, CGRect(x: 1080, y: 40, width: 100, height: 72), CGRect(x: 1300, y: 40, width: 344, height: 72),
                      CGRect(x: 10, y: 10, width: 600, height: 401)]
        XCTAssertEqual(AXRules.banners(frames, screen: screen), [banner])
    }

    func testIMEWindowsOfInputMethodsBelowHerLayerThatAreVisible() {
        func window(_ id: Int, _ pid: Int32, layer: Int, alpha: Double) -> Windows.Window {
            Windows.Window(id: id, pid: pid, bounds: CGRect(x: id, y: 0, width: 10, height: 10), layer: layer, alpha: alpha, title: nil,
                           owner: nil)
        }
        let windows = [window(1, 7, layer: 3, alpha: 1), window(2, 8, layer: 3, alpha: 1), window(3, 7, layer: 25, alpha: 1),
                       window(4, 7, layer: 101, alpha: 1), window(5, 7, layer: 0, alpha: 0)]
        XCTAssertEqual(AXRules.imeRects(windows, inputMethodPids: [7]), [CGRect(x: 1, y: 0, width: 10, height: 10)])
    }

    func testWindowMatchIsUniqueWithinTwoPoints() {
        let target = CGRect(x: 200, y: 120, width: 900, height: 600)
        XCTAssertEqual(AXRules.matchWindow(frames: [nil, CGRect(x: 201, y: 118, width: 902, height: 600)], target: target), 1)
        XCTAssertNil(AXRules.matchWindow(frames: [CGRect(x: 203, y: 120, width: 900, height: 600)], target: target))
        XCTAssertNil(AXRules.matchWindow(frames: [target, target], target: target))
    }

    func testFocusWindowIsTheFirstWindowOrSheetUpward() {
        XCTAssertEqual(AXRules.focusWindow(ancestors: [("AXGroup", nil), ("AXSheet", nil), ("AXWindow", "AXStandardWindow")]), 1)
        XCTAssertEqual(AXRules.focusWindow(ancestors: [("AXGroup", nil), ("AXWindow", "AXDialog")]), 1)
        XCTAssertNil(AXRules.focusWindow(ancestors: [("AXGroup", nil), ("AXApplication", nil)]))
    }

    func testLabelIsTheFirstNonEmptyAndDocIsAPath() {
        XCTAssertEqual(AXRules.label(["", nil, "Search"]), "Search")
        XCTAssertNil(AXRules.label([nil, ""]))
        XCTAssertEqual(AXRules.doc("file:///Users/me/a%20b.txt"), "/Users/me/a b.txt")
        XCTAssertEqual(AXRules.doc("https://example.com/x"), "https://example.com/x")
        XCTAssertNil(AXRules.doc(nil))
    }
}
