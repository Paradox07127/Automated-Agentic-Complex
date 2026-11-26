import Foundation

/// What a running handler asks its session about its request.
struct Request {
    /// The request was cancelled meanwhile; its answer is dropped then.
    let cancelled: () -> Bool
    /// The handler's step right before a side effect: false when the request was cancelled, else a cancel is too late from
    /// now on and the handler's own answer is written.
    let commit: () -> Bool
}

/// An implemented op. `params` has passed the ops.json check, so required fields are there with their types.
struct Handler {
    /// AppKit's ops (NSScreen, NSWorkspace, NSPasteboard), the push-to-talk key and the watches run on the main thread; the others on a
    /// concurrent queue.
    let onMain: Bool
    let run: ([String: Any], Request) -> Outcome
    /// Runs under the session's lock right after a success answer is written, so that events can follow it.
    var answered: (([String: Any]) -> Void)?

    /// An op that does not stop part way commits as it starts.
    init(onMain: Bool, run: @escaping ([String: Any]) -> Outcome, answered: (([String: Any]) -> Void)? = nil) {
        self.onMain = onMain
        self.run = { params, request in request.commit() ? run(params) : .cancelled }
        self.answered = answered
    }

    /// An op without side effects, which stops when cancelled.
    init(onMain: Bool, cancellable: @escaping ([String: Any], @escaping () -> Bool) -> Outcome) {
        self.onMain = onMain
        run = { params, request in cancellable(params, request.cancelled) }
    }

    /// An op that commits right before its side effect, or takes back what it opened when its commit finds it cancelled.
    init(onMain: Bool, committing: @escaping ([String: Any], Request) -> Outcome, answered: (([String: Any]) -> Void)? = nil) {
        self.onMain = onMain
        run = committing
        self.answered = answered
    }
}

enum Ops {
    /// The ops this helper implements. `hello` lists exactly these; the other ops of ops.json answer `unsupported`.
    static let handlers: [String: Handler] = {
        var table: [String: Handler] = [
            "screens.list": Handler(onMain: true, run: Screens.list),
            "windows.list": Handler(onMain: false, run: Windows.list),
            "windows.at_point": Handler(onMain: false, run: Windows.atPoint),
            "workspace.watch": Handler(onMain: true, run: Workspace.watch, answered: Workspace.state.answered),
            "attention.sample": Handler(onMain: false, run: Attention.sample),
            "presence.watch": Handler(onMain: true, run: Presence.watch, answered: Presence.state.answered),
            "browser.front_tab": Handler(onMain: false, run: Browser.frontTab),
            "input.modifiers": Handler(onMain: false, run: Modifiers.read),
            "input.watch": Handler(onMain: true, run: InputWatch.watch, answered: InputWatch.state.answered),
            "input.actions": Handler(onMain: true, run: ActionWatch.watch, answered: ActionWatch.state.answered),
            "ax.focused": Handler(onMain: false, run: AXOps.focused),
            "ax.dialog_buttons": Handler(onMain: false, run: AXOps.dialogButtons),
            "ax.overlays": Handler(onMain: false, run: AXOps.overlays),
            "ax.hit_chain": Handler(onMain: false, run: AXOps.hitChain),
            "ax.window_text": Handler(onMain: false, cancellable: WindowText.read),
            "ax.window_tree": Handler(onMain: false, cancellable: WindowTree.read),
            "ax.selected_text": Handler(onMain: false, run: AXOps.selectedText),
            "ax.video_rect": Handler(onMain: false, cancellable: AXOps.videoRect),
            "ax.watch": Handler(onMain: false, committing: AXWatch.watch, answered: AXWatch.answered),
            "capture.window": Handler(onMain: false, cancellable: Capture.window),
            "capture.ambient": Handler(onMain: false, cancellable: Capture.ambient),
            "ocr.languages": Handler(onMain: false, run: OCR.languages),
            "ocr.recognize": Handler(onMain: false, cancellable: OCR.recognize),
            "ptt.register": Handler(onMain: true, run: PushToTalk.register),
            "ptt.unregister": Handler(onMain: true, run: PushToTalk.unregister),
            "control.observe": Handler(onMain: false, cancellable: Control.observe),
            "control.act": Handler(onMain: false, committing: Control.act),
            "control.read": Handler(onMain: false, cancellable: Control.read),
            "control.listen": Handler(onMain: false, committing: ControlListen.listen, answered: ControlListen.answered),
            "control.respond": Handler(onMain: false, run: ControlListen.respond),
            "clipboard.read": Handler(onMain: true, run: Clipboard.read),
            "apps.running": Handler(onMain: true, run: Apps.running),
            "apps.installed": Handler(onMain: false, run: Apps.installed),
            "apps.activate": Handler(onMain: true, run: Apps.activate),
            "terminal.focus": Handler(onMain: false, run: { Terminal.focus($0, .live) }),
            "process.usage": Handler(onMain: false, run: Processes.usage),
            "permissions.status": Handler(onMain: false, run: Permissions.status),
            "permissions.request": Handler(onMain: false, run: { Permissions.request($0, .live) }),
        ]
        // SpeechAnalyzer is macOS 26 and later; below it hello leaves these ops out and they answer unsupported.
        if #available(macOS 26, *) {
            table["speech.locales"] = Handler(onMain: false, run: Mic.locales)
            table["mic.start"] = Handler(onMain: false, committing: Mic.start, answered: Mic.answered)
            table["mic.stop"] = Handler(onMain: false, run: Mic.stop)
        }
        return table
    }()

    /// ops.json "events" in its order, each with the op that turns it on.
    static let events: [(event: String, op: String)] = [
        ("workspace.changed", "workspace.watch"), ("presence.edge", "presence.watch"), ("input.activity", "input.watch"),
        ("input.action", "input.actions"), ("ax.notification", "ax.watch"), ("mic.level", "mic.start"), ("speech.partial", "mic.start"),
        ("ptt.down", "ptt.register"), ("ptt.up", "ptt.register"), ("ptt.typed", "ptt.register"),
        ("speech.download", "mic.start"), ("control.request", "control.listen"),
    ]

    static func handler(_ name: String) -> Handler? { handlers[name] }
}

func rectJSON(_ r: CGRect) -> [String: Any] {
    ["x": Double(r.origin.x), "y": Double(r.origin.y), "width": Double(r.size.width), "height": Double(r.size.height)]
}

/// A `rect` of params, which passed the ops.json check.
func rectParam(_ value: Any?) -> CGRect? {
    guard let r = value as? [String: Any], let x = JSON.number(r["x"]), let y = JSON.number(r["y"]),
          let width = JSON.number(r["width"]), let height = JSON.number(r["height"]) else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

func flag(_ params: [String: Any], _ key: String) -> Bool { JSON.bool(params[key]) ?? false }
