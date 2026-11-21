import AppKit
import ApplicationServices

/// Items `first`...`last` (from 1) of `total` are on screen.
struct TreeRange: Equatable {
    var first: Int
    var last: Int
    var total: Int
}

/// What one element gives its line.
struct TreeNode {
    var role: String
    var subrole: String? = nil
    var title: String? = nil
    var description: String? = nil
    var value: String? = nil
    var selected = false
    var disabled = false
    var expanded: Bool? = nil
    /// Set when only part of the children are on screen; the walk gets only those.
    var shown: TreeRange? = nil

    var secure: Bool { AXRules.isSecure(role: role, subrole: subrole, title: title, description: description) }
}

/// One line of a tree: `head` is the role and the title, `tail` the value, the description and the states.
struct TreeLine: Equatable {
    let depth: Int
    let id: Int
    let head: String
    let tail: String

    var text: String { String(repeating: "\t", count: depth) + "\(id) \(head)\(tail)" }
    /// The line without its number, which every line above an added or removed one shifts.
    var key: String { "\(depth)\u{1F}\(head)\u{1F}\(tail)" }
    /// What a `~` line keeps.
    var place: String { "\(depth)\u{1F}\(head)" }
}

/// CONTRACT §7.4 `ax.window_tree`: one window's elements as indented lines in preorder, and against a kept version only
/// the lines that changed. The text is not redacted (the main process does that).
enum WindowTree {
    static let defaultLines = 800
    static let defaultScalars = 32000
    static let valueScalars = 500
    /// The whole read, the window lookup included.
    static let seconds: TimeInterval = 0.25
    /// Above this many old-by-new line pairs the changed middle is all `-` then all `+`.
    private static let diffCells = 4_000_000
    private static let valueRoles: Set<String> = ["AXStaticText", "AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox",
                                                  "AXRadioButton", "AXPopUpButton"]
    private static let foldRoles: Set<String> = ["AXGroup", "AXUnknown", "AXLayoutArea", "AXLayoutItem", "AXSplitGroup"]
    private static let attributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                     kAXHiddenAttribute, kAXSelectedAttribute, kAXEnabledAttribute, kAXExpandedAttribute,
                                     kAXVisibleRowsAttribute, kAXRowsAttribute, kAXVisibleChildrenAttribute, kAXChildrenAttribute]

    private struct Version {
        let id: String
        let window: String
        let lines: [TreeLine]
    }

    /// Versions kept for `previous`, oldest first.
    private static let lock = NSLock()
    private static var versions: [Version] = []
    private static var made = 0
    private static let keptTrees = 8

    // MARK: lines

    /// `AXStaticText` → `static text`.
    static func roleName(_ role: String) -> String {
        var name = "", previous: Character?
        for c in role.hasPrefix("AX") ? String(role.dropFirst(2)) : role {
            if c.isUppercase, let p = previous, p.isLowercase || p.isNumber { name.append(" ") }
            name += c.lowercased()
            previous = c
        }
        return name
    }

    static func range(first: Int?, shown: Int, total: Int) -> TreeRange? {
        guard shown > 0, shown < total else { return nil }
        let start = first ?? 0
        return TreeRange(first: start + 1, last: min(start + shown, total), total: total)
    }

    static func describe(_ node: TreeNode) -> (head: String, tail: String) {
        let title = present(node.title), description = present(node.description)
        var head = roleName(node.role)
        if let label = title ?? description { head += " " + flat(label) }
        var tail = ""
        if !node.secure, valueRoles.contains(node.role), let value = present(node.value) {
            tail += ", Value: " + flat(String(String.UnicodeScalarView(value.unicodeScalars.prefix(valueScalars))))
        }
        if title != nil, let description, description != title { tail += ", Description: " + flat(description) }
        if node.selected { tail += " (selected)" }
        if node.disabled { tail += " (disabled)" }
        if let expanded = node.expanded { tail += expanded ? " (expanded)" : " (collapsed)" }
        if let shown = node.shown { tail += " (showing \(shown.first)-\(shown.last) of \(shown.total) items)" }
        return (head, tail)
    }

    private static func present(_ text: String?) -> String? { text.flatMap { $0.isEmpty ? nil : $0 } }

    /// One line per element: line breaks are written as `\n`, tabs as spaces.
    private static func flat(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\\n").replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\n").replacingOccurrences(of: "\t", with: " ")
    }

    /// A container with nothing of its own and one child gives no line; the child takes its place.
    private static func folds(_ node: TreeNode, children: Int) -> Bool {
        children == 1 && foldRoles.contains(node.role) && present(node.title) == nil && present(node.description) == nil
            && present(node.value) == nil && !node.selected && !node.disabled && node.expanded == nil && node.shown == nil
    }

    /// Preorder from `root`. `read` gives a node and the children to walk, nil for one to leave out with what is under it;
    /// `stop` is checked before each read. A line that does not fit `maxScalars` (each line with its newline) is left out.
    static func walk<Node>(_ root: Node, read: (Node) -> (node: TreeNode, children: [Node])?, maxLines: Int, maxScalars: Int,
                           stop: () -> Bool) -> (lines: [TreeLine], truncated: Bool, secure: Bool) {
        var lines: [TreeLine] = [], scalars = 0, truncated = false, secure = false
        var stack: [(node: Node, depth: Int)] = [(root, 0)]
        while let entry = stack.popLast() {
            if stop() || lines.count >= maxLines {
                truncated = true
                break
            }
            guard let item = read(entry.node) else { continue }
            if folds(item.node, children: item.children.count) {
                stack.append((item.children[0], entry.depth))
                continue
            }
            let (head, tail) = describe(item.node)
            let line = TreeLine(depth: entry.depth, id: lines.count, head: head, tail: tail)
            let cost = line.text.unicodeScalars.count + 1
            guard scalars + cost <= maxScalars else {
                truncated = true
                break
            }
            scalars += cost
            secure = secure || item.node.secure
            lines.append(line)
            stack.append(contentsOf: item.children.reversed().map { ($0, entry.depth + 1) })
        }
        return (lines, truncated, secure)
    }

    // MARK: diff

    /// `+` added and `-` removed lines; a removed and an added line at the same place with the same depth, role and title
    /// are one `~` line with the new text. Unchanged lines are left out.
    static func diff(_ old: [TreeLine], _ new: [TreeLine]) -> [String] {
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix].key == new[prefix].key { prefix += 1 }
        var suffix = 0
        while suffix < old.count - prefix, suffix < new.count - prefix, old[old.count - 1 - suffix].key == new[new.count - 1 - suffix].key {
            suffix += 1
        }
        let a = Array(old[prefix..<(old.count - suffix)]), b = Array(new[prefix..<(new.count - suffix)])
        var out: [String] = [], i = 0, j = 0
        for (mi, mj) in commonLines(a.map(\.key), b.map(\.key)) + [(a.count, b.count)] {
            let gone = a[i..<mi], came = b[j..<mj]
            for k in 0..<max(gone.count, came.count) {
                let was = k < gone.count ? gone[gone.startIndex + k] : nil, now = k < came.count ? came[came.startIndex + k] : nil
                if let was, let now, was.place == now.place {
                    out.append("~" + now.text)
                    continue
                }
                if let was { out.append("-" + was.text) }
                if let now { out.append("+" + now.text) }
            }
            i = mi + 1
            j = mj + 1
        }
        return out
    }

    /// The index pairs of a longest common subsequence of `a` and `b`.
    private static func commonLines(_ a: [String], _ b: [String]) -> [(Int, Int)] {
        guard !a.isEmpty, !b.isEmpty, a.count * b.count <= diffCells else { return [] }
        var codes: [String: Int] = [:]
        for key in a where codes[key] == nil { codes[key] = codes.count }
        let x = a.map { codes[$0]! }, y = b.map { codes[$0] ?? -1 }
        let width = y.count + 1
        var lengths = [Int32](repeating: 0, count: (x.count + 1) * width)
        for i in stride(from: x.count - 1, through: 0, by: -1) {
            for j in stride(from: y.count - 1, through: 0, by: -1) {
                lengths[i * width + j] = x[i] == y[j] ? lengths[(i + 1) * width + j + 1] + 1
                    : max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
            }
        }
        var pairs: [(Int, Int)] = [], i = 0, j = 0
        while i < x.count, j < y.count {
            if x[i] == y[j] {
                pairs.append((i, j))
                i += 1
                j += 1
            } else if lengths[(i + 1) * width + j] >= lengths[i * width + j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return pairs
    }

    // MARK: the op

    /// The answer for a walked window, kept as a new version; against `previous` when it is a kept version of `window` and
    /// this walk was not truncated, whose unread lines a diff would give as removed.
    static func answer(lines: [TreeLine], truncated: Bool, secure: Bool, window: String, previous: String?) -> [String: Any] {
        let (id, old) = lock.withLock { () -> (String, [TreeLine]?) in
            made += 1
            let id = "t-\(made)"
            let old = previous.flatMap { asked in versions.first { $0.id == asked && $0.window == window }?.lines }
            versions.append(Version(id: id, window: window, lines: lines))
            if versions.count > keptTrees { versions.removeFirst(versions.count - keptTrees) }
            return (id, old)
        }
        var mode = "full", text = lines.map(\.text)
        if let old, !truncated {
            text = diff(old, lines)
            mode = text.isEmpty ? "no_change" : "diff"
        }
        return ["matched": true, "tree_id": id, "mode": mode, "text": text.joined(separator: "\n"), "lines": lines.count,
                "truncated": truncated, "secure": secure]
    }

    static func read(_ params: [String: Any], cancelled: @escaping () -> Bool) -> Outcome {
        guard AX.trusted else { return AX.denied }
        guard let pid = AX.livePid(params["pid"]) else { return AX.gone }
        guard !AX.skipped(pid) else { return AX.timeout(AX.text) }
        let reader = AXReader(pid: pid, limit: AX.text, deadline: Date().addingTimeInterval(seconds))
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
            let id = lock.withLock { () -> String in
                made += 1
                return "t-\(made)"
            }
            return .success(["matched": false, "tree_id": id, "mode": "full", "text": "", "lines": 0, "truncated": false, "secure": false])
        }
        var visited: Set<CFHashCode> = []
        let walked = walk(window, read: { element in visited.insert(CFHash(element)).inserted ? node(element, reader) : nil },
                          maxLines: JSON.int(params["max_lines"]) ?? defaultLines,
                          maxScalars: JSON.int(params["max_scalars"]) ?? defaultScalars, stop: { reader.expired || cancelled() })
        if reader.timedOut && walked.lines.isEmpty { return AX.timeout(AX.text) }
        return .success(answer(lines: walked.lines, truncated: walked.truncated, secure: walked.secure,
                               window: "\(pid):\(CFHash(window))", previous: params["previous"] as? String))
    }

    /// What a node is walked through, all and on screen: its rows when it gives some and visible rows, else its children
    /// (Chromium's web area gives empty rows beside its children).
    static func items<T>(rows: [T]?, visibleRows: [T]?, children: [T]?, visibleChildren: [T]?) -> (all: [T], visible: [T]?) {
        if let rows, !rows.isEmpty, let visibleRows { return (rows, visibleRows) }
        return (children ?? [], visibleChildren)
    }

    /// Nil for a hidden or role-less element. A secure one's value is never read.
    private static func node(_ element: AXUIElement, _ reader: AXReader) -> (node: TreeNode, children: [AXUIElement])? {
        let v = reader.attributes(element, attributes)
        guard (v[4] as? Bool) != true, let role = v[0] as? String else { return nil }
        var node = TreeNode(role: role, subrole: v[1] as? String, title: v[2] as? String, description: v[3] as? String,
                            selected: (v[5] as? Bool) == true, disabled: (v[6] as? Bool) == false, expanded: v[7] as? Bool)
        let (all, visible) = items(rows: v[9] as? [AXUIElement], visibleRows: v[8] as? [AXUIElement],
                                   children: v[11] as? [AXUIElement], visibleChildren: v[10] as? [AXUIElement])
        if let visible, let head = visible.first {
            node.shown = range(first: all.firstIndex { CFEqual($0, head) }, shown: visible.count, total: all.count)
        }
        if valueRoles.contains(role), !node.secure {
            let value = reader.value(element, kAXValueAttribute)
            node.value = value as? String ?? (value as? NSNumber)?.stringValue
        }
        return (node, visible ?? all)
    }
}
