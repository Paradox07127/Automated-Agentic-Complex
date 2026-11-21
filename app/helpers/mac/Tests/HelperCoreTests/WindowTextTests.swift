// ax.window_text's text: its order, filters and lines, its scalar budget, and the per-node budget.
import CoreGraphics
@testable import HelperCore
import XCTest

final class WindowTextTests: XCTestCase {
    private func node(_ id: Int, _ parent: Int, _ role: String, title: String? = nil, description: String? = nil,
                      value: String? = nil, frame: CGRect?) -> PageNode {
        PageNode(id: id, parent: parent, node: TextNode(role: role, title: title, description: description, value: value), frame: frame)
    }

    private var page: [PageNode] {
        [node(0, -1, "AXWindow", title: "notes.txt", frame: CGRect(x: 200, y: 120, width: 900, height: 600)),
         node(1, 0, "AXButton", title: "Save", description: "Save", frame: CGRect(x: 210, y: 130, width: 60, height: 20)),
         node(2, 0, "AXTextArea", description: "editor", value: "Shopping list", frame: CGRect(x: 220, y: 180, width: 860, height: 520)),
         node(3, 0, "AXStaticText", value: "hidden", frame: CGRect(x: 300, y: 300, width: 1, height: 1)),
         node(4, 0, "AXScrollArea", frame: CGRect(x: 220, y: 180, width: 100, height: 100)),
         node(5, 4, "AXStaticText", value: "outside", frame: CGRect(x: 400, y: 400, width: 50, height: 20)),
         node(6, 4, "AXStaticText", value: "inside", frame: CGRect(x: 230, y: 190, width: 50, height: 20)),
         node(7, 0, "AXStaticText", value: "inside", frame: CGRect(x: 230, y: 230, width: 50, height: 20))]
    }

    func testTextNodesFirstThenTheRestWithoutHiddenClippedOrRepeatedLines() {
        var clips: [Int: CGRect] = [:]
        let text = WindowText.windowSummary(focused: nil, nodes: page, windowFrame: CGRect(x: 200, y: 120, width: 900, height: 600),
                                            scalarLimit: 6000, clips: &clips)
        XCTAssertEqual(text.text, "可见文字: Shopping list\n可见文字: inside\n标签: notes.txt\n标签: Save")
        XCTAssertFalse(text.cut)
    }

    func testTheFocusedControlComesFirstAndAPageWithoutItsParentsStillReads() {
        let focused = TextNode(role: "AXTextArea", title: "Body", selection: "milk")
        var clips: [Int: CGRect] = [:]
        let text = WindowText.windowSummary(focused: focused, nodes: [page[6]], windowFrame: nil, scalarLimit: 6000, clips: &clips)
        XCTAssertEqual(text.text, "焦点控件: AXTextArea\n标签: Body\n选中: milk\n可见文字: inside")
    }

    func testTheScalarLimitCutsALineAtAScalarBoundary() {
        var clips: [Int: CGRect] = [:]
        let text = WindowText.windowSummary(focused: nil, nodes: page, windowFrame: nil, scalarLimit: 12, clips: &clips)
        XCTAssertEqual(text.text, "可见文字: Shoppi")
        XCTAssertTrue(text.cut)
    }

    func testALineLeftOutWholeByTheScalarLimitCountsAsCut() {
        var clips: [Int: CGRect] = [:]
        let fits = WindowText.windowSummary(focused: nil, nodes: [page[2]], windowFrame: nil, scalarLimit: 19, clips: &clips)
        XCTAssertEqual(fits.text, "可见文字: Shopping list")
        XCTAssertFalse(fits.cut)
        let dropped = WindowText.windowSummary(focused: nil, nodes: [page[2], page[6]], windowFrame: nil, scalarLimit: 19, clips: &clips)
        XCTAssertEqual(dropped.text, "可见文字: Shopping list")
        XCTAssertTrue(dropped.cut)
        XCTAssertTrue(WindowText.focusedSummary(TextNode(role: "AXTextArea", selection: "milk"), scalarLimit: 10).cut)
    }

    func testAPageWhoseScrollAreaCameOnAnEarlierPageStillClipsToIt() {
        let frame = CGRect(x: 200, y: 120, width: 900, height: 600)
        var clips: [Int: CGRect] = [:]
        let first = WindowText.windowSummary(focused: nil, nodes: Array(page[0...4]), windowFrame: frame, scalarLimit: 6000,
                                             clips: &clips)
        XCTAssertEqual(first.text, "可见文字: Shopping list\n标签: notes.txt\n标签: Save")
        let next = WindowText.windowSummary(focused: nil, nodes: Array(page[5...7]), windowFrame: frame, scalarLimit: 6000,
                                            clips: &clips)
        XCTAssertEqual(next.text, "可见文字: inside")
    }

    func testFocusedLevelReadsOnlyTheFocusedControlAndNeverASecureOne() {
        XCTAssertEqual(WindowText.focusedSummary(TextNode(role: "AXTextField", title: "Search", value: "kept out"), scalarLimit: 2000).text,
                       "焦点控件: AXTextField\n标签: Search")
        XCTAssertEqual(WindowText.focusedSummary(TextNode(role: "AXTextField", subrole: "AXSecureTextField"), scalarLimit: 2000).text, "")
        XCTAssertEqual(WindowText.focusedSummary(nil, scalarLimit: 2000).text, "")
    }

    func testTheNodeBudgetCutsAtAScalarBoundaryAndSaysSo() {
        var budget = TextBudget(scalars: 5)
        XCTAssertEqual(budget.take("ab"), "ab")
        XCTAssertNil(budget.take(nil))
        XCTAssertFalse(budget.exhausted)
        XCTAssertEqual(budget.take("中文字🙂x"), "中文字")
        XCTAssertTrue(budget.cut)
        XCTAssertTrue(budget.exhausted)
        XCTAssertEqual(budget.take("y"), "")
    }

    func testCoverageStatus() {
        XCTAssertEqual(WindowText.status(nodes: 0, chars: 0, reasons: []), "empty")
        XCTAssertEqual(WindowText.status(nodes: 2, chars: 0, reasons: []), "complete")
        XCTAssertEqual(WindowText.status(nodes: 0, chars: 0, reasons: ["node_budget"]), "partial")
    }
}
