import AppKit
import ApplicationServices

struct TextNode: Equatable {
    var role: String
    var subrole: String? = nil
    var title: String? = nil
    var description: String? = nil
    var value: String? = nil
    var selection: String? = nil

    var secure: Bool { AXRules.isSecure(role: role, subrole: subrole, title: title, description: description) }
}

/// A node of one page of a walk; `parent` is -1 for the window, and may be a node of an earlier page.
struct PageNode {
    var id: Int
    var parent: Int
    var node: TextNode
    var frame: CGRect?
}

/// Scalars left for the node texts of one page; a text that does not fit is cut at a scalar boundary.
struct TextBudget {
    private(set) var remaining: Int
    private(set) var cut = false

    init(scalars: Int) { remaining = scalars }

    var exhausted: Bool { remaining <= 0 }

    mutating func take(_ text: String?) -> String? {
        guard let text else { return nil }
        let scalars = text.unicodeScalars
        guard scalars.count > remaining else {
            remaining -= scalars.count
            return text
        }
        cut = true
        let kept = String(String.UnicodeScalarView(scalars.prefix(max(0, remaining))))
        remaining = 0
        return kept
    }
}

/// CONTRACT §7.4 `ax.window_text`: a time-sliced breadth-first walk of one window and
/// its text, with the contract's node and scalar budgets per answer. A cursor continues the walk of
/// the same snapshot; the text is not redacted (the main process does that).
enum WindowText {
    private static let textRoles: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXHeading"]
    private static let valueRoles: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField"]
    /// Walks kept for their cursors, oldest first.
    private static let lock = NSLock()
    private static var walks: [TextWalk] = []
    private static var made = 0
    private static let keptWalks = 8

    // MARK: text

    /// Drops nodes too small or outside the window or their scroll areas, then writes
    /// text nodes before the rest, each in document order, one line per label and visible text, without repeats. `cut`
    /// when the limit left out some of it. `clips` carries from page to page the scroll-area clip each node gives the nodes
    /// under it, which may come on a later page.
    static func windowSummary(focused: TextNode?, nodes: [PageNode], windowFrame: CGRect?, scalarLimit: Int,
                              clips: inout [Int: CGRect]) -> (text: String, cut: Bool) {
        let index = Dictionary(nodes.indices.map { (nodes[$0].id, $0) }, uniquingKeysWith: { first, _ in first })
        var children = [[Int]](repeating: [], count: nodes.count), roots: [Int] = []
        for (k, item) in nodes.enumerated() {
            if let parent = index[item.parent] { children[parent].append(k) } else { roots.append(k) }
        }
        var stack: [(index: Int, clip: CGRect?)] = roots.reversed().map { ($0, clips[nodes[$0].parent] ?? windowFrame) }
        var text: [TextNode] = [], rest: [TextNode] = []
        while let entry = stack.popLast() {
            let item = nodes[entry.index]
            var inner = entry.clip
            if item.node.role == "AXScrollArea", let frame = item.frame, !frame.isEmpty {
                inner = entry.clip.map { $0.intersection(frame) } ?? frame
            }
            if let inner, inner != windowFrame { clips[item.id] = inner }
            stack.append(contentsOf: children[entry.index].reversed().map { ($0, inner) })
            if let frame = item.frame {
                guard frame.width > 1, frame.height > 1 else { continue }
                if !frame.isEmpty, let clip = entry.clip, !clip.intersects(frame) { continue }
            }
            var node = item.node
            if node.description == node.title { node.description = nil }
            if textRoles.contains(node.role) {
                node.description = nil
                text.append(node)
            } else {
                rest.append(node)
            }
        }
        var lines = Lines(limit: scalarLimit)
        lines.focused(focused)
        for node in text + rest where !node.secure {
            lines.add("标签", node.title)
            lines.add("说明", node.description)
            if valueRoles.contains(node.role) { lines.add("可见文字", node.value) }
        }
        return (lines.text, lines.cut)
    }

    /// The text at the focused level: the focused control's role, labels and selection, never its value.
    static func focusedSummary(_ focused: TextNode?, scalarLimit: Int) -> (text: String, cut: Bool) {
        var lines = Lines(limit: scalarLimit)
        lines.focused(focused)
        return (lines.text, lines.cut)
    }

    private struct Lines {
        var remaining: Int
        var parts: [String] = []
        var seen: Set<String> = []
        var cut = false

        init(limit: Int) { remaining = limit }

        var text: String { parts.joined(separator: "\n") }

        mutating func add(_ label: String, _ value: String?) {
            guard let value, !value.isEmpty else { return }
            let line = "\(label): \(value)"
            guard !seen.contains(line) else { return }
            guard remaining > 0 else {
                cut = true
                return
            }
            seen.insert(line)
            let clipped = String(String.UnicodeScalarView(line.unicodeScalars.prefix(remaining)))
            if clipped.unicodeScalars.count < line.unicodeScalars.count { cut = true }
            parts.append(clipped)
            remaining -= clipped.unicodeScalars.count + 1
        }

        mutating func focused(_ node: TextNode?) {
            guard let node, !node.secure else { return }
            add("焦点控件", node.role)
            add("标签", node.title)
            add("说明", node.description)
            add("选中", node.selection)
        }
    }

    /// `cursor_reset` alone still reads the whole window.
    static func status(nodes: Int, chars: Int, reasons: [String]) -> String {
        if reasons.contains(where: { $0 != "cursor_reset" }) { return "partial" }
        return nodes == 0 && chars == 0 ? "empty" : "complete"
    }

    // MARK: the op

    static func read(_ params: [String: Any], cancelled: @escaping () -> Bool) -> Outcome {
        guard AX.trusted else { return AX.denied }
        guard let pid = AX.livePid(params["pid"]) else { return AX.gone }
        guard !AX.skipped(pid) else { return AX.timeout(AX.text) }
        let focusedLevel = params["level"] as? String == "focused"
        let maxNodes = JSON.int(params["max_nodes"]) ?? C12Ops.Limits.axWindowTextMaxNodes
        let maxScalars = JSON.int(params["max_scalars"])
            ?? (focusedLevel ? C12Ops.Limits.axWindowTextFocusedMaxScalars : C12Ops.Limits.axWindowTextMaxScalars)
        let scope = focusedLevel ? "focused_control" : "visible_window"
        var reasons: [String] = []
        var walk: TextWalk?
        if let cursor = params["cursor"] as? String {
            walk = take(cursor).flatMap { $0.pid == pid && $0.focusedLevel == focusedLevel && $0.stillCurrent() ? $0 : nil }
            if walk == nil {
                // stillCurrent timed out: the app is on the skip list now.
                if AX.skipped(pid) { return AX.timeout(AX.text) }
                reasons.append("cursor_reset")
            }
        }
        if walk == nil {
            let reader = AXReader(pid: pid, limit: AX.text)
            let app = reader.app()
            let window: AXUIElement?
            if let bounds = rectParam(params["window_bounds"]) {
                let windows = reader.elements(app, kAXWindowsAttribute)
                window = AXRules.matchWindow(frames: windows.map { reader.frame($0) }, target: bounds).map { windows[$0] }
            } else {
                window = reader.element(app, kAXFocusedWindowAttribute)
            }
            if reader.timedOut { return AX.timeout(AX.text) }
            if window == nil, reader.failure != nil {
                return .failure(code: "ax_unavailable", message: "the app does not answer AX reads of its windows")
            }
            guard let window else {
                return .success(["snapshot_id": nextId(), "matched": false, "text": "", "nodes": [],
                                 "coverage": ["status": "empty", "scope": scope, "reasons": reasons, "captured_nodes": 0, "captured_chars": 0]])
            }
            walk = TextWalk(id: nextId(), pid: pid, window: window, focusedLevel: focusedLevel, pinned: params["window_bounds"] != nil)
        }
        let w = walk!
        let page = w.next(maxNodes: maxNodes, maxScalars: maxScalars, cancelled: cancelled)
        if page.timedOutFirst { return AX.timeout(AX.text) }
        reasons += page.reasons
        let (text, cut) = focusedLevel ? focusedSummary(page.focused, scalarLimit: maxScalars)
            : windowSummary(focused: page.focused, nodes: page.nodes, windowFrame: w.frame, scalarLimit: maxScalars, clips: &w.clips)
        if cut && !reasons.contains("char_budget") { reasons.append("char_budget") }
        let nodes: [[String: Any]] = page.nodes.map { n in
            ["id": n.id, "parent": n.parent, "role": n.node.role, "native_role": n.node.role,
             "label": JSON.optional(n.node.title ?? n.node.description), "value": JSON.optional(n.node.value),
             "selection": JSON.optional(n.node.selection), "bounds": n.frame.map(rectJSON) ?? NSNull()]
        }
        let chars = text.unicodeScalars.count
        var coverage: [String: Any] = ["status": status(nodes: nodes.count, chars: chars, reasons: reasons), "scope": scope,
                                       "reasons": reasons, "captured_nodes": nodes.count, "captured_chars": chars]
        if w.complete { coverage["next_cursor"] = NSNull() } else {
            coverage["next_cursor"] = w.id
            keep(w)
        }
        return .success(["snapshot_id": w.id, "matched": true, "text": text, "nodes": nodes, "coverage": coverage])
    }

    private static func nextId() -> String {
        lock.withLock {
            made += 1
            return "s-\(made)"
        }
    }

    /// The walk of `cursor`, taken out of the kept ones so that one request at a time continues it.
    private static func take(_ cursor: String) -> TextWalk? {
        lock.withLock {
            guard let k = walks.firstIndex(where: { $0.id == cursor }) else { return nil }
            return walks.remove(at: k)
        }
    }

    private static func keep(_ walk: TextWalk) {
        lock.withLock {
            walks.append(walk)
            if walks.count > keptWalks { walks.removeFirst(walks.count - keptWalks) }
        }
    }
}

/// One snapshot's walk of one window. Pages are read with a 0.5 s slice and 250 ms messages.
final class TextWalk {
    private enum Entry {
        case node(AXUIElement, parent: Int)
        case children(AXUIElement, parent: Int, offset: Int)
    }

    struct Page {
        var focused: TextNode?
        var nodes: [PageNode] = []
        var reasons: [String] = []
        /// Nothing was read: the app timed out on the first message.
        var timedOutFirst = false
    }

    private static let sliceSeconds: TimeInterval = 0.5
    private static let childBatch = 128
    let id: String
    let pid: Int32
    let focusedLevel: Bool
    let frame: CGRect?
    private let window: AXUIElement
    private let pinned: Bool
    private let identity: String
    private var focused: TextNode?
    private var queue: [Entry] = []
    private var head = 0
    private var visited: Set<CFHashCode> = []
    private var made = 0
    /// The texts of a node the scalar budget cut that did not fit, sent first on the next page under the same id.
    private var rest: PageNode?
    /// The scroll-area clips of the nodes of earlier pages, for `WindowText.windowSummary`.
    var clips: [Int: CGRect] = [:]

    var complete: Bool { head >= queue.count && rest == nil }

    init(id: String, pid: Int32, window: AXUIElement, focusedLevel: Bool, pinned: Bool) {
        self.id = id
        self.pid = pid
        self.window = window
        self.focusedLevel = focusedLevel
        self.pinned = pinned
        let reader = AXReader(pid: pid, limit: AX.text)
        let frame = reader.frame(window)
        self.frame = frame
        identity = Self.identity(window, reader)
        let app = reader.app()
        if let element = reader.element(app, kAXFocusedUIElementAttribute),
           let owner = reader.element(element, kAXWindowAttribute), CFEqual(owner, window) {
            focused = Self.node(element, focused: true, keep: frame, reader: reader).node
        }
        if !focusedLevel { queue = [.node(window, parent: -1)] }
    }

    private static func identity(_ window: AXUIElement, _ reader: AXReader) -> String {
        (reader.string(window, kAXTitleAttribute) ?? "") + "\n" + (reader.string(window, kAXDocumentAttribute) ?? "")
    }

    /// The window is still the one this walk started in: still open (pinned) or still focused, with the same title and
    /// document.
    func stillCurrent() -> Bool {
        let reader = AXReader(pid: pid, limit: AX.text)
        let app = reader.app()
        if pinned {
            guard reader.elements(app, kAXWindowsAttribute).contains(where: { CFEqual($0, window) }) else { return false }
        } else {
            guard let current = reader.element(app, kAXFocusedWindowAttribute), CFEqual(current, window) else { return false }
        }
        return Self.identity(window, reader) == identity
    }

    func next(maxNodes: Int, maxScalars: Int, cancelled: () -> Bool) -> Page {
        let reader = AXReader(pid: pid, limit: AX.text, deadline: Date().addingTimeInterval(Self.sliceSeconds))
        var page = Page()
        if made == 0 && head == 0 { page.focused = focused }
        var budget = TextBudget(scalars: maxScalars)
        var unreadable = false, nodeBudget = false
        if var left = rest, !budget.exhausted {
            rest = Self.fit(&left, &budget)
            page.nodes.append(left)
        }
        while rest == nil, head < queue.count, !reader.expired, !budget.exhausted, !cancelled() {
            if page.nodes.count >= maxNodes {
                nodeBudget = true
                break
            }
            let entry = queue[head]
            head += 1
            switch entry {
            case let .node(element, parent):
                if visited.contains(CFHash(element)) { continue }
                let read = Self.node(element, focused: false, keep: frame, reader: reader)
                if reader.expired {
                    head -= 1
                    break
                }
                visited.insert(CFHash(element))
                guard let node = read.node else {
                    unreadable = true
                    continue
                }
                if read.partial { unreadable = true }
                var item = PageNode(id: made, parent: parent, node: node, frame: read.frame)
                rest = Self.fit(&item, &budget)
                page.nodes.append(item)
                queue.append(.children(element, parent: made, offset: 0))
                made += 1
            case let .children(element, parent, offset):
                guard let children = reader.elements(element, kAXVisibleChildrenAttribute, offset: offset, limit: Self.childBatch)
                        ?? reader.elements(element, kAXChildrenAttribute, offset: offset, limit: Self.childBatch) else {
                    if reader.expired { head -= 1 }
                    continue
                }
                queue.append(contentsOf: children.map { .node($0, parent: parent) })
                if children.count == Self.childBatch { queue.append(.children(element, parent: parent, offset: offset + Self.childBatch)) }
            }
        }
        if reader.timedOut && made == 0 && page.nodes.isEmpty && !focusedLevel { page.timedOutFirst = true }
        if !complete && !cancelled() {
            if nodeBudget { page.reasons.append("node_budget") }
            else if budget.exhausted { page.reasons.append("char_budget") }
            else { page.reasons.append("ax_time_slice") }
        }
        if budget.cut && !page.reasons.contains("char_budget") { page.reasons.append("char_budget") }
        if unreadable { page.reasons.append("ax_unreadable_nodes_or_text") }
        return page
    }

    /// Cuts `item`'s texts to `budget`; what was cut off, as the same node holding only that, or nil.
    private static func fit(_ item: inout PageNode, _ budget: inout TextBudget) -> PageNode? {
        var left = item, cut = false
        for field in [\TextNode.title, \TextNode.description, \TextNode.value] {
            let text = item.node[keyPath: field]
            let kept = budget.take(text)
            item.node[keyPath: field] = kept
            let dropped = (text?.unicodeScalars.count ?? 0) - (kept?.unicodeScalars.count ?? 0)
            left.node[keyPath: field] = dropped > 0 ? text.map { String(String.UnicodeScalarView($0.unicodeScalars.suffix(dropped))) } : nil
            cut = cut || dropped > 0
        }
        return cut ? left : nil
    }

    /// Nil for a hidden, secure or role-less node or one outside `keep`; `partial` when only the
    /// visible part of a text area could be read.
    private static func node(_ element: AXUIElement, focused: Bool, keep: CGRect?, reader: AXReader)
        -> (node: TextNode?, frame: CGRect?, partial: Bool) {
        let v = reader.attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                            kAXHiddenAttribute, kAXPositionAttribute, kAXSizeAttribute])
        guard (v[4] as? Bool) != true, let role = v[0] as? String else { return (nil, nil, false) }
        var node = TextNode(role: role, subrole: v[1] as? String, title: v[2] as? String, description: v[3] as? String)
        guard !node.secure else { return (nil, nil, false) }
        let frame = AXReader.rect(v[5], v[6])
        if let keep, let frame, !frame.isEmpty, !keep.intersects(frame) { return (nil, nil, false) }
        var partial = false
        if focused {
            node.selection = reader.string(element, kAXSelectedTextAttribute)
        } else {
            (node.value, partial) = visibleText(element, role: role, reader: reader)
        }
        return (node, frame, partial)
    }

    /// The whole AX text buffer; the visible range only as a fallback, which counts as partial.
    private static func visibleText(_ element: AXUIElement, role: String, reader: AXReader) -> (String?, Bool) {
        if role == "AXStaticText" || role == "AXTextField" { return (reader.string(element, kAXValueAttribute), false) }
        guard role == "AXTextArea" else { return (nil, false) }
        if let length = (reader.value(element, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue, length > 0 {
            var range = CFRange(location: 0, length: length)
            if let parameter = AXValueCreate(.cfRange, &range),
               let text = reader.parameterized(element, kAXStringForRangeParameterizedAttribute, parameter) as? String {
                return (text, false)
            }
        }
        if let text = reader.string(element, kAXValueAttribute) { return (text, false) }
        return (reader.string(element, kAXVisibleTextAttribute), true)
    }
}
