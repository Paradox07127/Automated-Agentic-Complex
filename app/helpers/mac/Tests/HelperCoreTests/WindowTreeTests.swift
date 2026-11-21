// ax.window_tree's text: its lines, the folded containers, the visible ranges, the secure nodes, the budgets and the
// diff against a kept version.
@testable import HelperCore
import XCTest

/// A node of a made-up window, walked the way the AX reader walks one.
private final class FakeNode {
    let node: TreeNode
    let children: [FakeNode]

    init(_ node: TreeNode, _ children: [FakeNode] = []) {
        self.node = node
        self.children = children
    }
}

final class WindowTreeTests: XCTestCase {
    private func walk(_ root: FakeNode, maxLines: Int = 800, maxScalars: Int = 32000, stop: @escaping () -> Bool = { false })
        -> (lines: [TreeLine], truncated: Bool, secure: Bool) {
        WindowTree.walk(root, read: { ($0.node, $0.children) }, maxLines: maxLines, maxScalars: maxScalars, stop: stop)
    }

    private func text(_ root: FakeNode) -> String { walk(root).lines.map(\.text).joined(separator: "\n") }

    private func window(_ children: [FakeNode]) -> FakeNode { FakeNode(TreeNode(role: "AXWindow", title: "notes.txt"), children) }

    func testFullTreeLinesCarryDepthNumberRoleTitleValueDescriptionAndStates() {
        let root = window([
            FakeNode(TreeNode(role: "AXButton", title: "Save", value: "never shown", disabled: true)),
            FakeNode(TreeNode(role: "AXTextArea", description: "editor", value: "Shopping list\nmilk")),
            FakeNode(TreeNode(role: "AXStaticText", value: "Total")),
            FakeNode(TreeNode(role: "AXCheckBox", title: "Bold", description: "Make bold", value: "1")),
            FakeNode(TreeNode(role: "AXOutline"), [
                FakeNode(TreeNode(role: "AXRow", selected: true, expanded: false), [FakeNode(TreeNode(role: "AXStaticText", value: "Inbox"))]),
                FakeNode(TreeNode(role: "AXRow", expanded: true)),
            ]),
        ])
        XCTAssertEqual(text(root), """
            0 window notes.txt
            \t1 button Save (disabled)
            \t2 text area editor, Value: Shopping list\\nmilk
            \t3 static text, Value: Total
            \t4 check box Bold, Value: 1, Description: Make bold
            \t5 outline
            \t\t6 row (selected) (collapsed)
            \t\t\t7 static text, Value: Inbox
            \t\t8 row (expanded)
            """)
    }

    func testAValueIsCutTo500Scalars() {
        let long = String(repeating: "字", count: 600)
        let line = walk(window([FakeNode(TreeNode(role: "AXTextField", value: long))])).lines[1].text
        XCTAssertEqual(line, "\t1 text field, Value: " + String(repeating: "字", count: 500))
    }

    func testRoleNamesDropTheAXPrefixAndSplitTheWords() {
        XCTAssertEqual(WindowTree.roleName("AXStaticText"), "static text")
        XCTAssertEqual(WindowTree.roleName("AXButton"), "button")
        XCTAssertEqual(WindowTree.roleName("AXMenuBarItem"), "menu bar item")
        XCTAssertEqual(WindowTree.roleName("AXWebArea"), "web area")
    }

    func testPureContainersWithOneChildAreFoldedIntoTheirParent() {
        let root = window([
            FakeNode(TreeNode(role: "AXGroup"), [FakeNode(TreeNode(role: "AXUnknown"), [FakeNode(TreeNode(role: "AXButton", title: "OK"))])]),
            FakeNode(TreeNode(role: "AXGroup", title: "Tools"), [FakeNode(TreeNode(role: "AXButton", title: "A"))]),
            FakeNode(TreeNode(role: "AXLayoutArea"), [FakeNode(TreeNode(role: "AXButton", title: "B")),
                                                       FakeNode(TreeNode(role: "AXButton", title: "C"))]),
        ])
        XCTAssertEqual(text(root), """
            0 window notes.txt
            \t1 button OK
            \t2 group Tools
            \t\t3 button A
            \t4 layout area
            \t\t5 button B
            \t\t6 button C
            """)
    }

    func testAContainerShowingPartOfItsItemsSaysWhichAndWalksOnlyThose() {
        XCTAssertEqual(WindowTree.range(first: 2, shown: 2, total: 10), TreeRange(first: 3, last: 4, total: 10))
        XCTAssertNil(WindowTree.range(first: 0, shown: 10, total: 10))
        XCTAssertNil(WindowTree.range(first: nil, shown: 0, total: 10))
        let list = FakeNode(TreeNode(role: "AXList", shown: TreeRange(first: 3, last: 4, total: 10)),
                            [FakeNode(TreeNode(role: "AXStaticText", value: "c")), FakeNode(TreeNode(role: "AXStaticText", value: "d"))])
        XCTAssertEqual(text(window([list])), """
            0 window notes.txt
            \t1 list (showing 3-4 of 10 items)
            \t\t2 static text, Value: c
            \t\t3 static text, Value: d
            """)
    }

    func testRowsAreWalkedOnlyWhenThereAreAny() {
        // Chromium's AXWebArea answers AXRows and AXVisibleRows with empty arrays beside its children.
        let web = WindowTree.items(rows: [Int](), visibleRows: [], children: [1, 2], visibleChildren: [1, 2])
        XCTAssertEqual(web.all, [1, 2])
        XCTAssertEqual(web.visible, [1, 2])
        let table = WindowTree.items(rows: [7, 8, 9], visibleRows: [8], children: [1], visibleChildren: nil)
        XCTAssertEqual(table.all, [7, 8, 9])
        XCTAssertEqual(table.visible, [8])
    }

    func testASecureControlGivesNoValueAndMarksTheTreeSecure() {
        let walked = walk(window([FakeNode(TreeNode(role: "AXTextField", subrole: "AXSecureTextField", value: "hunter2")),
                                  FakeNode(TreeNode(role: "AXTextField", title: "Password", value: "hunter2"))]))
        XCTAssertEqual(walked.lines.map(\.text), ["0 window notes.txt", "\t1 text field", "\t2 text field Password"])
        XCTAssertTrue(walked.secure)
        XCTAssertFalse(walk(window([])).secure)
    }

    func testTheLineScalarAndTimeLimitsTruncate() {
        let root = window([FakeNode(TreeNode(role: "AXButton", title: "A")), FakeNode(TreeNode(role: "AXButton", title: "B"))])
        let lines = walk(root, maxLines: 2)
        XCTAssertEqual(lines.lines.map(\.text), ["0 window notes.txt", "\t1 button A"])
        XCTAssertTrue(lines.truncated)
        XCTAssertFalse(walk(root, maxLines: 3).truncated)
        let scalars = walk(root, maxScalars: "0 window notes.txt\n\t1 button A\n".unicodeScalars.count)
        XCTAssertEqual(scalars.lines.count, 2)
        XCTAssertTrue(scalars.truncated)
        var reads = 0
        let timed = WindowTree.walk(root, read: { reads += 1; return ($0.node, $0.children) }, maxLines: 800, maxScalars: 32000,
                                    stop: { reads >= 1 })
        XCTAssertEqual(timed.lines.count, 1)
        XCTAssertTrue(timed.truncated)
    }

    func testTheSameTreeAgainIsNoChange() {
        let lines = walk(window([FakeNode(TreeNode(role: "AXButton", title: "A"))])).lines
        let first = WindowTree.answer(lines: lines, truncated: false, secure: false, window: "same", previous: nil)
        XCTAssertEqual(first["mode"] as? String, "full")
        XCTAssertEqual(first["text"] as? String, "0 window notes.txt\n\t1 button A")
        XCTAssertEqual(first["lines"] as? Int, 2)
        let again = WindowTree.answer(lines: lines, truncated: false, secure: false, window: "same", previous: first["tree_id"] as? String)
        XCTAssertEqual(again["mode"] as? String, "no_change")
        XCTAssertEqual(again["text"] as? String, "")
        XCTAssertNotEqual(again["tree_id"] as? String, first["tree_id"] as? String)
    }

    func testAChangedValueIsOneTildeLine() {
        let before = walk(window([FakeNode(TreeNode(role: "AXTextField", value: "milk")), FakeNode(TreeNode(role: "AXButton", title: "A"))]))
        let after = walk(window([FakeNode(TreeNode(role: "AXTextField", value: "eggs")), FakeNode(TreeNode(role: "AXButton", title: "A"))]))
        let first = WindowTree.answer(lines: before.lines, truncated: false, secure: false, window: "value", previous: nil)
        let next = WindowTree.answer(lines: after.lines, truncated: false, secure: false, window: "value", previous: first["tree_id"] as? String)
        XCTAssertEqual(next["mode"] as? String, "diff")
        XCTAssertEqual(next["text"] as? String, "~\t1 text field, Value: eggs")
    }

    func testAnAddedNodeIsOnePlusLineWhateverItShiftsTheNumbersOf() {
        let a = FakeNode(TreeNode(role: "AXButton", title: "A")), c = FakeNode(TreeNode(role: "AXButton", title: "C"))
        let before = walk(window([a, c])).lines
        let after = walk(window([a, FakeNode(TreeNode(role: "AXButton", title: "B")), c])).lines
        let first = WindowTree.answer(lines: before, truncated: false, secure: false, window: "added", previous: nil)
        let next = WindowTree.answer(lines: after, truncated: false, secure: false, window: "added", previous: first["tree_id"] as? String)
        XCTAssertEqual(next["mode"] as? String, "diff")
        XCTAssertEqual(next["text"] as? String, "+\t2 button B")
        XCTAssertEqual(WindowTree.diff(after, before), ["-\t2 button B"])
    }

    func testAnUnknownPreviousOrOneOfAnotherWindowIsAFullTree() {
        let lines = walk(window([])).lines
        XCTAssertEqual(WindowTree.answer(lines: lines, truncated: false, secure: false, window: "w1", previous: "t-unknown")["mode"] as? String,
                       "full")
        let other = WindowTree.answer(lines: lines, truncated: false, secure: false, window: "w2", previous: nil)
        let switched = WindowTree.answer(lines: lines, truncated: false, secure: false, window: "w1", previous: other["tree_id"] as? String)
        XCTAssertEqual(switched["mode"] as? String, "full")
        XCTAssertEqual(switched["text"] as? String, "0 window notes.txt")
    }

    func testATruncatedTreeAgainstAWholeOneIsAFullTreeWithoutMinusLines() {
        let root = window([FakeNode(TreeNode(role: "AXButton", title: "A")), FakeNode(TreeNode(role: "AXButton", title: "B"))])
        let whole = walk(root), cut = walk(root, maxLines: 2)
        let first = WindowTree.answer(lines: whole.lines, truncated: whole.truncated, secure: false, window: "cut", previous: nil)
        let next = WindowTree.answer(lines: cut.lines, truncated: cut.truncated, secure: false, window: "cut",
                                     previous: first["tree_id"] as? String)
        XCTAssertEqual(next["mode"] as? String, "full")
        XCTAssertEqual(next["text"] as? String, "0 window notes.txt\n\t1 button A")
        XCTAssertEqual(next["truncated"] as? Bool, true)
    }
}
