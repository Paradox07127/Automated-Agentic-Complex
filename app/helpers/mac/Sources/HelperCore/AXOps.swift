import AppKit
import ApplicationServices

/// CONTRACT §7.4's probes, in CG global points. None reads a value but `ax.selected_text`, and none reads a
/// password node.
enum AXOps {
    private static let notificationCenter = "com.apple.notificationcenterui"
    private static let imeLock = NSLock()
    private static var inputMethod: [Int32: Bool] = [:]

    /// `ax.focused`: the focused element of `pid`, else of the app that has the system focus.
    static func focused(_ params: [String: Any]) -> Outcome {
        guard AX.trusted else { return AX.denied }
        let reader: AXReader
        let element: AXUIElement?
        // Nil when a pid was asked; else the app with the system focus, read with no focused element too.
        var appPid: Int32??
        if let asked = JSON.int(params["pid"]) {
            guard let pid = AX.livePid(asked) else { return .success(["focus": NSNull()]) }
            guard !AX.skipped(pid) else { return AX.timeout(AX.probe) }
            reader = AXReader(pid: pid, limit: AX.probe)
            element = reader.element(reader.app(), kAXFocusedUIElementAttribute)
        } else {
            // The system-wide element answers which app has the focus; its element then belongs to that app.
            let system = AXReader(pid: 0, limit: AX.probe)
            var app: pid_t = 0
            appPid = .some(system.element(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute)
                .flatMap { AXUIElementGetPid($0, &app) == .success && app > 0 ? app : nil })
            let found = system.element(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute)
            var owner: pid_t = 0
            guard let found, AXUIElementGetPid(found, &owner) == .success, owner > 0 else {
                return system.timedOut ? AX.timeout(AX.probe) : .success(focusedAnswer(NSNull(), appPid: appPid))
            }
            guard !AX.skipped(owner) else { return AX.timeout(AX.probe) }
            reader = AXReader(pid: owner, limit: AX.probe)
            element = found
        }
        guard let element else { return reader.timedOut ? AX.timeout(AX.probe) : .success(focusedAnswer(NSNull(), appPid: appPid)) }
        let v = reader.attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute,
                                            kAXTitleAttribute, kAXDescriptionAttribute])
        let role = v[0] as? String, subrole = v[1] as? String
        guard let frame = AXReader.rect(v[2], v[3]) else {
            return reader.timedOut ? AX.timeout(AX.probe) : .success(focusedAnswer(NSNull(), appPid: appPid))
        }
        let editable = AXRules.isEditable(role: role, subrole: subrole)
        let secure = AXRules.isSecure(role: role, subrole: subrole, title: v[4] as? String, description: v[5] as? String)
        let caret = editable && !secure ? caret(element, field: frame, reader: reader) : nil
        if reader.timedOut { return AX.timeout(AX.probe) }
        return .success(focusedAnswer([
            "pid": Int(reader.pid), "role": JSON.optional(role), "native_role": JSON.optional(role), "subrole": JSON.optional(subrole),
            "frame": rectJSON(frame), "caret": caret.map(rectJSON) ?? NSNull(), "editable": editable,
            "element_key": String(CFHash(element)),
        ] as [String: Any], appPid: appPid))
    }

    /// `ax.focused`'s result: `app_pid` only when no pid was asked (`appPid` nil), null when no app has the focus.
    static func focusedAnswer(_ focus: Any, appPid: Int32??) -> [String: Any] {
        var answer: [String: Any] = ["focus": focus]
        if let appPid { answer["app_pid"] = appPid.map { Int($0) } ?? NSNull() }
        return answer
    }

    /// The title and AXDocument path of the app's focused window; nil when it has none or did not answer.
    static func focusedWindow(_ pid: Int32) -> (title: String?, doc: String?)? {
        guard !AX.skipped(pid) else { return nil }
        let reader = AXReader(pid: pid, limit: AX.text)
        guard let window = reader.element(reader.app(), kAXFocusedWindowAttribute) else { return nil }
        let v = reader.attributes(window, [kAXTitleAttribute, kAXDocumentAttribute])
        return reader.timedOut ? nil : (v[0] as? String, AXRules.doc(v[1] as? String))
    }

    /// The caret at the selection start: a zero-length range first, then one character.
    private static func caret(_ element: AXUIElement, field: CGRect, reader: AXReader) -> CGRect? {
        var selection = CFRange()
        guard let value = reader.value(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID(),
              AXValueGetValue(value as! AXValue, .cfRange, &selection) else { return nil }
        for length in [0, 1] {
            var range = CFRange(location: selection.location, length: length)
            guard let parameter = AXValueCreate(.cfRange, &range) else { continue }
            var rect = CGRect.zero
            if let bounds = reader.parameterized(element, kAXBoundsForRangeParameterizedAttribute, parameter),
               CFGetTypeID(bounds) == AXValueGetTypeID(), AXValueGetValue(bounds as! AXValue, .cgRect, &rect),
               let caret = AXRules.caret(bounds: rect, field: field) {
                return caret
            }
            if reader.timedOut { return nil }
        }
        return nil
    }

    /// `ax.dialog_buttons`: the default and cancel buttons of the focused window when it is a dialog or has a sheet.
    static func dialogButtons(_ params: [String: Any]) -> Outcome {
        guard AX.trusted else { return AX.denied }
        guard let pid = AX.livePid(params["pid"]) else { return AX.gone }
        guard !AX.skipped(pid) else { return AX.timeout(AX.probe) }
        let reader = AXReader(pid: pid, limit: AX.probe)
        guard let window = reader.element(reader.app(), kAXFocusedWindowAttribute) else {
            return reader.timedOut ? AX.timeout(AX.probe) : .success(["buttons": []])
        }
        let subrole = reader.describe(window).subrole
        let sheet = reader.elements(window, kAXChildrenAttribute).first { reader.describe($0).role == kAXSheetRole }
        let owner = sheet ?? window
        let buttons = [kAXDefaultButtonAttribute, kAXCancelButtonAttribute].compactMap { name in
            reader.element(owner, name).flatMap { reader.describe($0).frame }
        }
        if reader.timedOut { return AX.timeout(AX.probe) }
        return .success(["buttons": AXRules.dialogButtons(windowSubrole: subrole, hasSheet: sheet != nil, buttons: buttons).map(rectJSON)])
    }

    /// `ax.overlays`: Notification Center banners and input method windows.
    static func overlays(_ params: [String: Any]) -> Outcome {
        guard AX.trusted else { return AX.denied }
        let windows = Windows.onScreen()
        guard let banners = banners(windows) else { return AX.timeout(AX.probe) }
        var pids = Set<Int32>()
        for w in windows {
            let known = imeLock.withLock { inputMethod[w.pid] }
            let isInputMethod = known ?? (NSRunningApplication(processIdentifier: w.pid)?.bundleURL?.path.contains("/Input Methods/") ?? false)
            if known == nil { imeLock.withLock { inputMethod[w.pid] = isInputMethod } }
            if isInputMethod { pids.insert(w.pid) }
        }
        return .success(["banners": banners.map(rectJSON), "ime": AXRules.imeRects(windows, inputMethodPids: pids).map(rectJSON)])
    }

    /// Banner frames, read only while a Notification Center window is on screen; nil when Notification Center timed out.
    private static func banners(_ windows: [Windows.Window]) -> [CGRect]? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: notificationCenter).first?.processIdentifier,
              windows.contains(where: { $0.pid == pid }) else { return [] }
        guard !AX.skipped(pid) else { return nil }
        let reader = AXReader(pid: pid, limit: AX.probe)
        var rects: [CGRect] = []
        for window in reader.elements(reader.app(), kAXWindowsAttribute) {
            guard let screen = reader.frame(window) else { continue }
            var frames: [CGRect] = []
            var level = reader.elements(window, kAXChildrenAttribute)
            for _ in 0..<4 where !level.isEmpty {
                frames += level.compactMap { reader.describe($0).frame }
                level = level.flatMap { reader.elements($0, kAXChildrenAttribute) }
            }
            rects += AXRules.banners(frames, screen: screen)
        }
        return reader.timedOut ? nil : rects
    }

    /// `ax.hit_chain`: the element under `point` and up to 3 ancestors, asked of the app whose window is under it.
    static func hitChain(_ params: [String: Any]) -> Outcome {
        guard AX.trusted else { return AX.denied }
        let point = params["point"] as! [String: Any]
        let p = CGPoint(x: JSON.number(point["x"])!, y: JSON.number(point["y"])!)
        let excluded = Set(((params["exclude_pids"] as? [Any]) ?? []).compactMap { JSON.int($0) })
        let windows = Windows.onScreen()
        var banners: [CGRect]??
        let owner = windows.first { w in
            guard !excluded.contains(Int(w.pid)), w.alpha > 0, w.bounds.contains(p) else { return false }
            // Notification Center's window covers the whole screen; only its banners are under the point.
            guard NSRunningApplication(processIdentifier: w.pid)?.bundleIdentifier == notificationCenter else { return true }
            if banners == nil { banners = .some(self.banners(windows)) }
            return banners??.contains { $0.contains(p) } ?? false
        }
        guard let pid = owner?.pid else { return .success(["pid": NSNull(), "chain": []]) }
        guard !AX.skipped(pid) else { return AX.timeout(AX.probe) }
        // Never the system-wide element: while she takes clicks it answers with her own window.
        let reader = AXReader(pid: pid, limit: AX.probe)
        let app = reader.app()
        AXUIElementSetMessagingTimeout(app, AX.probe)
        var hit: AXUIElement?
        guard reader.note(AXUIElementCopyElementAtPosition(app, Float(p.x), Float(p.y), &hit)), var element = hit else {
            return reader.timedOut ? AX.timeout(AX.probe) : .success(["pid": Int(pid), "chain": []])
        }
        var chain: [[String: Any]] = []
        for depth in 0..<4 {
            let d = reader.describe(element)
            chain.append(["role": JSON.optional(d.role), "native_role": JSON.optional(d.role), "subrole": JSON.optional(d.subrole),
                          "frame": d.frame.map(rectJSON) ?? NSNull()])
            guard depth < 3, let parent = reader.element(element, kAXParentAttribute) else { break }
            element = parent
        }
        if reader.timedOut { return AX.timeout(AX.probe) }
        return .success(["pid": Int(pid), "chain": chain])
    }

    /// `ax.selected_text`: the selection of the system-wide focused element when it belongs to `pid`.
    static func selectedText(_ params: [String: Any]) -> Outcome {
        guard AX.trusted else { return AX.denied }
        guard let pid = AX.livePid(params["pid"]) else { return .success(["text": NSNull()]) }
        guard !AX.skipped(pid) else { return AX.timeout(AX.text) }
        let reader = AXReader(pid: pid, limit: AX.text)
        var owner: pid_t = 0
        guard let element = reader.element(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute),
              AXUIElementGetPid(element, &owner) == .success, owner == pid else {
            return reader.timedOut ? AX.timeout(AX.text) : .success(["text": NSNull()])
        }
        let v = reader.attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
        let secure = AXRules.isSecure(role: v[0] as? String, subrole: v[1] as? String, title: v[2] as? String, description: v[3] as? String)
        let text = secure ? nil : reader.string(element, kAXSelectedTextAttribute)
        if reader.timedOut { return AX.timeout(AX.text) }
        return .success(["text": JSON.optional(text)])
    }

    /// `ax.video_rect`: the first AXVideo of the focused window, breadth first, at most 12 levels below it and 400 nodes.
    static func videoRect(_ params: [String: Any], cancelled: @escaping () -> Bool) -> Outcome {
        guard AX.trusted else { return AX.denied }
        guard let pid = AX.livePid(params["pid"]) else { return AX.gone }
        guard !AX.skipped(pid) else { return AX.timeout(AX.probe) }
        let deadline = Date().addingTimeInterval(videoSeconds)
        let reader = AXReader(pid: pid, limit: AX.probe)
        guard let window = reader.element(reader.app(), kAXFocusedWindowAttribute) else {
            return reader.timedOut ? AX.timeout(AX.probe) : .success(["rect": NSNull()])
        }
        let found = firstVideo(below: window, read: { element in
            let v = reader.attributes(element, [kAXSubroleAttribute, kAXChildrenAttribute])
            return reader.timedOut ? nil : (v[0] as? String, v[1] as? [AXUIElement] ?? [])
        }, cancelled: cancelled, deadline: deadline)
        switch found {
        case .timedOut: return AX.timeout(AX.probe)
        case .none: return .success(["rect": NSNull()])
        case let .found(element):
            let frame = reader.frame(element)
            return reader.timedOut ? AX.timeout(AX.probe) : .success(["rect": frame.map(rectJSON) ?? NSNull()])
        }
    }

    /// `ax.video_rect`'s walk, which leaves the rest of its 1 s for the frame and the answer.
    static let videoSeconds: TimeInterval = 0.75

    enum Walk<Node> {
        case found(Node), none, timedOut
    }

    /// The first node below `window` whose subrole is AXVideo, breadth first, at most 12 levels and 400 nodes. `read` is
    /// a node's subrole and children, nil when the app timed out; a cancelled walk finds none, one past `deadline` times out.
    static func firstVideo<Node>(below window: Node, read: (Node) -> (subrole: String?, children: [Node])?,
                                 cancelled: () -> Bool, deadline: Date, now: () -> Date = Date.init) -> Walk<Node> {
        var level = [window], visited = 0
        for _ in 0...12 where !level.isEmpty {
            var next: [Node] = []
            for node in level {
                guard visited < 400, !cancelled() else { return .none }
                guard now() < deadline else { return .timedOut }
                visited += 1
                guard let v = read(node) else { return .timedOut }
                if v.subrole == "AXVideo" { return .found(node) }
                next += v.children
            }
            level = next
        }
        return .none
    }
}
