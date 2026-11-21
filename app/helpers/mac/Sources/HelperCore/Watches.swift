import AppKit
import ApplicationServices
import Carbon
import CoreGraphics

/// Observer tokens of one watch, on the main thread.
private final class Observers {
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []

    func add(_ center: NotificationCenter, _ name: Notification.Name, _ body: @escaping (Notification) -> Void) {
        tokens.append((center, center.addObserver(forName: name, object: nil, queue: .main, using: body)))
    }

    func removeAll() {
        for (center, token) in tokens { center.removeObserver(token) }
        tokens.removeAll()
    }
}

/// CONTRACT §7.2 `workspace.watch`: the front app, the Space and the displays.
enum Workspace {
    static let state = WatchState()
    private static let observers = Observers()
    private static var started = 0
    private static var screensPending = false

    /// Main thread.
    static func watch(_ params: [String: Any]) -> Outcome {
        let enabled = flag(params, "enabled")
        let answer = result(enabled: enabled, frontPid: enabled ? NSWorkspace.shared.frontmostApplication?.processIdentifier : nil)
        guard enabled != state.on else { return .success(answer) }
        if enabled {
            started = state.start()
            let center = NSWorkspace.shared.notificationCenter
            observers.add(center, NSWorkspace.didActivateApplicationNotification) { note in
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                send("front_app", app?.processIdentifier)
            }
            observers.add(center, NSWorkspace.activeSpaceDidChangeNotification) { _ in
                send("space", NSWorkspace.shared.frontmostApplication?.processIdentifier)
            }
            // NSApplication's screen notification needs an NSApplication; the display callback needs only the run loop.
            CGDisplayRegisterReconfigurationCallback(displayChanged, nil)
            if WatchState.probe { send("front_app", NSWorkspace.shared.frontmostApplication?.processIdentifier) }
        } else {
            state.stop()
            observers.removeAll()
            CGDisplayRemoveReconfigurationCallback(displayChanged, nil)
        }
        return .success(answer)
    }

    /// The answer: turned on, it carries the front app at that moment.
    static func result(enabled: Bool, frontPid: pid_t?) -> [String: Any] {
        guard enabled else { return ["watching": false] }
        return ["watching": true, "front_pid": frontPid.flatMap { $0 > 0 ? Int($0) : nil } ?? NSNull()]
    }

    private static func send(_ reason: String, _ pid: pid_t?) {
        let generation = started
        state.send("workspace.changed", ["reason": reason, "front_pid": pid.flatMap { $0 > 0 ? Int($0) : nil } ?? NSNull()],
                   generation)
    }

    /// One event per reconfiguration, however many displays it touched.
    private static let displayChanged: CGDisplayReconfigurationCallBack = { _, flags, _ in
        guard !flags.contains(.beginConfigurationFlag), !screensPending else { return }
        screensPending = true
        DispatchQueue.main.async {
            screensPending = false
            send("screens", NSWorkspace.shared.frontmostApplication?.processIdentifier)
        }
    }
}

/// CONTRACT §7.3 `presence.watch`: the lock, sleep and display notifications, sent as they come.
enum Presence {
    static let state = WatchState()
    private static let observers = Observers()

    /// Main thread.
    static func watch(_ params: [String: Any]) -> Outcome {
        let enabled = flag(params, "enabled")
        guard enabled != state.on else { return .success(["watching": enabled]) }
        if enabled {
            let generation = state.start()
            let workspace = NSWorkspace.shared.notificationCenter
            // com.apple.screenIsLocked/Unlocked are undocumented; the session notifications cover fast user switching.
            let edges: [(NotificationCenter, Notification.Name, String)] = [
                (workspace, NSWorkspace.sessionDidResignActiveNotification, "lock"),
                (workspace, NSWorkspace.sessionDidBecomeActiveNotification, "unlock"),
                (DistributedNotificationCenter.default(), Notification.Name("com.apple.screenIsLocked"), "lock"),
                (DistributedNotificationCenter.default(), Notification.Name("com.apple.screenIsUnlocked"), "unlock"),
                (workspace, NSWorkspace.willSleepNotification, "sleep"),
                (workspace, NSWorkspace.didWakeNotification, "wake"),
                (workspace, NSWorkspace.screensDidSleepNotification, "display_sleep"),
                (workspace, NSWorkspace.screensDidWakeNotification, "display_wake"),
            ]
            for (center, name, edge) in edges {
                observers.add(center, name) { _ in state.send("presence.edge", ["edge": edge], generation) }
            }
            if WatchState.probe { state.send("presence.edge", ["edge": "wake"], generation) }
        } else {
            state.stop()
            observers.removeAll()
        }
        return .success(["watching": enabled])
    }
}

/// At most one key or scroll input.activity per 100 ms; every mouse press and release goes, so that the main process
/// knows whether a button is down (CONTRACT §7.3).
struct ActivityThrottle {
    static let interval: TimeInterval = 0.1
    private var last: [String: TimeInterval] = [:]

    mutating func allow(_ kind: String, at now: TimeInterval) -> Bool {
        if kind == "mouse_down" || kind == "mouse_up" { return true }
        if let then = last[kind], now - then < Self.interval - 1e-9 { return false }
        last[kind] = now
        return true
    }
}

/// CONTRACT §7.3 `input.watch`: a listen-only event tap for the input kinds computer control watches and the mouse
/// releases. It reads the event type and the generated-event marker only, never a key code or a position.
enum InputWatch {
    /// The marker `control.act` sets on the events it generates.
    static let marker: Int64 = 0x454E44464355
    static let state = WatchState()
    private static var tap: CFMachPort?
    private static var source: CFRunLoopSource?
    private static var started = 0
    private static var throttle = ActivityThrottle()
    static let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .rightMouseUp,
                                       .otherMouseUp, .scrollWheel]

    static func kind(_ type: CGEventType) -> String {
        switch type {
        case .keyDown: return "key"
        case .scrollWheel: return "scroll"
        case .leftMouseUp, .rightMouseUp, .otherMouseUp: return "mouse_up"
        default: return "mouse_down"
        }
    }

    /// Main thread; the tap's callback runs there too.
    static func watch(_ params: [String: Any]) -> Outcome {
        let enabled = flag(params, "enabled")
        guard enabled != state.on else { return .success(["watching": enabled]) }
        guard enabled else {
            state.stop()
            if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
            if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
            tap = nil
            source = nil
            return .success(["watching": false])
        }
        // Checked before the tap: creating one without a grant can show the Input Monitoring prompt.
        guard AX.trusted else { return AX.denied }
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                              eventsOfInterest: mask, callback: tapped, userInfo: nil) else {
            return AX.denied
        }
        started = state.start()
        throttle = ActivityThrottle()
        tap = created
        source = CFMachPortCreateRunLoopSource(nil, created, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        if WatchState.probe { state.send("input.activity", ["kind": "key"], started) }
        return .success(["watching": true])
    }

    private static let tapped: CGEventTapCallBack = { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard event.getIntegerValueField(.eventSourceUserData) != marker else { return Unmanaged.passUnretained(event) }
        let kind = kind(type)
        if throttle.allow(kind, at: ProcessInfo.processInfo.systemUptime) { state.send("input.activity", ["kind": kind], started) }
        return Unmanaged.passUnretained(event)
    }
}

/// Repeated clicks on one control within 150 ms are one input.action (CONTRACT §7.3).
struct ClickThrottle {
    static let interval: TimeInterval = 0.15
    private var last: (key: String, at: TimeInterval)?

    mutating func allow(_ key: String, at now: TimeInterval) -> Bool {
        if let last, last.key == key, now - last.at < Self.interval - 1e-9 { return false }
        last = (key, now)
        return true
    }
}

/// CONTRACT §7.3 `input.actions`: a listen-only event tap of its own for clicks, context-menu presses, shortcuts and
/// Return, each sent with the control it went to. It reads a click's position and a key press's modifiers and key code;
/// the character only of a shortcut, never of plain typing.
enum ActionWatch {
    struct KeyAction: Equatable {
        let kind: String
        let keys: String
    }

    static let state = WatchState()
    private static var tap: CFMachPort?
    private static var source: CFRunLoopSource?
    private static var started = 0
    /// The AX reads run here, off the main thread that runs the tap's callback, in the events' order.
    private static let reads = DispatchQueue(label: "ac-helper.input-actions")
    /// On `reads`.
    private static var throttle = ClickThrottle()
    static let types: [CGEventType] = [.leftMouseUp, .rightMouseDown, .keyDown]
    private static let returnKeys: Set<Int64> = [36, 76]
    private static let named: [Int64: String] = [36: "return", 76: "return", 48: "tab", 49: "space", 51: "delete", 53: "escape",
                                                 117: "forward_delete", 123: "left", 124: "right", 125: "down", 126: "up"]
    private static let modifiers: [(CGEventFlags, String)] = [(.maskControl, "ctrl"), (.maskAlternate, "alt"), (.maskShift, "shift"),
                                                             (.maskCommand, "cmd")]

    /// Scalars of a clicked static text's label (the timeline keeps 200 of a target field).
    private static let textLabel = 200

    static func mouseKind(_ type: CGEventType) -> String { type == .rightMouseDown ? "context_menu" : "click" }

    /// A shortcut (with command, control or option) or a submit (Return or Enter without them); nil for every other key,
    /// whose character is not read.
    static func keyAction(flags: CGEventFlags, keyCode: Int64, character: () -> String?) -> KeyAction? {
        guard flags.contains(.maskControl) || flags.contains(.maskAlternate) || flags.contains(.maskCommand) else {
            // Shift-Return is a line break in most message fields.
            return returnKeys.contains(keyCode) && !flags.contains(.maskShift) ? KeyAction(kind: "submit", keys: "return") : nil
        }
        let key = named[keyCode] ?? character().flatMap(printable) ?? "key\(keyCode)"
        return KeyAction(kind: "shortcut", keys: (modifiers.filter { flags.contains($0.0) }.map(\.1) + [key]).joined(separator: "+"))
    }

    private static func printable(_ text: String) -> String? {
        let lower = text.lowercased()
        return lower.isEmpty || lower.unicodeScalars.contains { $0.properties.generalCategory == .control || $0.properties.isWhitespace }
            ? nil : lower
    }

    static func actionData(kind: String, pid: Int32, target: [String: Any]?, keys: String?) -> [String: Any] {
        var data: [String: Any] = ["kind": kind, "pid": Int(pid), "target": JSON.optional(target)]
        if let keys { data["keys"] = keys }
        return data
    }

    /// Main thread; the tap's callback runs there too.
    static func watch(_ params: [String: Any]) -> Outcome {
        let enabled = flag(params, "enabled")
        guard enabled != state.on else { return .success(["watching": enabled]) }
        guard enabled else {
            state.stop()
            if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
            if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
            tap = nil
            source = nil
            return .success(["watching": false])
        }
        // Checked before the tap: creating one without a grant can show the Input Monitoring prompt.
        guard AX.trusted else { return AX.denied }
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                              eventsOfInterest: mask, callback: tapped, userInfo: nil) else {
            return AX.denied
        }
        started = state.start()
        reads.async { throttle = ClickThrottle() }
        tap = created
        source = CFMachPortCreateRunLoopSource(nil, created, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        if WatchState.probe { state.send("input.action", actionData(kind: "click", pid: getpid(), target: nil, keys: nil), started) }
        return .success(["watching": true])
    }

    private static let tapped: CGEventTapCallBack = { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard event.getIntegerValueField(.eventSourceUserData) != InputWatch.marker else { return Unmanaged.passUnretained(event) }
        let generation = started
        if type == .keyDown {
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else { return Unmanaged.passUnretained(event) }
            guard let action = keyAction(flags: event.flags, keyCode: code, character: { plainCharacter(code) }),
                  let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return Unmanaged.passUnretained(event) }
            reads.async {
                guard state.live(generation) else { return }
                let reader = AXReader(pid: pid, limit: AX.probe)
                let focused = AX.skipped(pid) ? nil : reader.element(reader.app(), kAXFocusedUIElementAttribute)
                state.send("input.action", actionData(kind: action.kind, pid: pid, target: focused.flatMap { target($0, pid: pid) },
                                                      keys: action.keys), generation)
            }
        } else {
            let kind = mouseKind(type), point = event.location, now = ProcessInfo.processInfo.systemUptime
            reads.async {
                guard state.live(generation), let hit = clicked(point) else { return }
                if kind == "click", !throttle.allow("\(hit.pid):\(CFHash(hit.element))", at: now) { return }
                state.send("input.action", actionData(kind: kind, pid: hit.pid, target: target(hit.element, pid: hit.pid), keys: nil),
                           generation)
            }
        }
        return Unmanaged.passUnretained(event)
    }

    /// The element under a click, from the system-wide element: it answers for the window that took the click.
    private static func clicked(_ point: CGPoint) -> (pid: Int32, element: AXUIElement)? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, AX.probe)
        var hit: AXUIElement?
        var pid: pid_t = 0
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success, let hit,
              AXUIElementGetPid(hit, &pid) == .success, pid > 0 else { return nil }
        return (pid, hit)
    }

    /// `element` as an `ax_element`, never with its value; nil when the app did not answer. Static text, which has no
    /// title, is labelled by its first `textLabel` characters.
    private static func target(_ element: AXUIElement, pid: Int32) -> [String: Any]? {
        guard !AX.skipped(pid) else { return nil }
        let reader = AXReader(pid: pid, limit: AX.probe)
        let v = reader.attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                            kAXPlaceholderValueAttribute])
        let text = v[0] as? String == kAXStaticTextRole
            ? reader.string(element, kAXValueAttribute).map { String(String.UnicodeScalarView($0.unicodeScalars.prefix(textLabel))) } : nil
        let w = reader.element(element, kAXWindowAttribute).map { reader.attributes($0, [kAXTitleAttribute, kAXDocumentAttribute]) }
        let info = AXWatch.elementJSON(role: v[0] as? String, subrole: v[1] as? String, title: v[2] as? String, description: v[3] as? String,
                                       placeholder: AXRules.label([v[4] as? String, text]), key: String(CFHash(element)),
                                       window: (w?[0] as? String, AXRules.doc(w?[1] as? String)),
                                       valueLength: { (reader.value(element, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue },
                                       selected: nil, value: nil, secureInput: IsSecureEventInputEnabled())
        return reader.timedOut ? nil : info
    }

    /// The key's character on the current keyboard layout without modifiers.
    private static func plainCharacter(_ keyCode: Int64) -> String? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData),
              let bytes = CFDataGetBytePtr(Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()) else { return nil }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        var dead: UInt32 = 0, length = 0
        var chars = [UniChar](repeating: 0, count: 4)
        guard UCKeyTranslate(layout, UInt16(truncatingIfNeeded: keyCode), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                             OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars) == noErr,
              length > 0 else { return nil }
        return String(utf16CodeUnits: chars, count: length)
    }
}

/// CONTRACT §7.4 `ax.watch`: one AXObserver on one app per watch id. Each notification sends the focused element, with the
/// value's length, and its text only when asked.
enum AXWatch {
    /// One watch id's observer and what its notifications read.
    private struct Subscription {
        let id: String
        let observer: AXObserver
        let pid: Int32
        let generation: Int
        let selected: Bool
        let value: Bool
    }

    private static let lock = NSLock()
    /// Held through a whole ax.watch, so that a stop or a second start of the same id waits for one under way.
    private static let replacing = NSLock()
    private static var states: [String: WatchState] = [:]
    private static var subscriptions: [String: Subscription] = [:]
    /// Element reads run here, off the main thread that delivers the notifications, in their order.
    private static let reads = DispatchQueue(label: "ac-helper.ax-watch")
    private static let names: [String: [String]] = [
        "focus": [kAXFocusedUIElementChangedNotification],
        "window": [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification],
        "title": [kAXTitleChangedNotification],
        "value": [kAXValueChangedNotification],
        "selection": [kAXSelectedTextChangedNotification],
    ]

    /// The default subscription is the empty id.
    static func watchId(_ params: [String: Any]) -> String { params["watch_id"] as? String ?? "" }

    /// One state per watch id for as long as the helper runs, so that a restarted watch drops its old generation's events.
    static func state(_ id: String) -> WatchState {
        lock.withLock {
            if let known = states[id] { return known }
            let made = WatchState()
            states[id] = made
            return made
        }
    }

    static func answered(_ params: [String: Any]) { state(watchId(params)).answered(params) }

    static func watch(_ params: [String: Any]) -> Outcome {
        replacing.withLock { replace(params) }
    }

    private static func replace(_ params: [String: Any]) -> Outcome {
        let id = watchId(params)
        guard let asked = JSON.int(params["pid"]) else {
            stop(id)
            return .success(result(pid: nil, watchId: id, element: nil, window: nil, manual: nil))
        }
        guard AX.trusted else { return AX.denied }
        guard let pid = AX.livePid(asked) else { return AX.gone }
        stop(id)
        var created: AXObserver?
        let status = AXObserverCreate(pid, notified, &created)
        guard status == .success, let created else {
            return status == .apiDisabled ? AX.denied
                : .failure(code: "internal", message: "AXObserverCreate failed with \(status.rawValue)")
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, AX.text)
        // For Electron and Chromium apps, which build their AX tree only when asked.
        let manual = flag(params, "manual_accessibility")
            ? AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success : nil
        let wanted = Set((params["notifications"] as? [String]) ?? [])
        for (kind, list) in names where wanted.contains(kind) {
            for name in list { AXObserverAddNotification(created, app, name as CFString, nil) }
        }
        let state = state(id)
        let generation = state.start()
        let subscription = Subscription(id: id, observer: created, pid: pid, generation: generation,
                                        selected: flag(params, "read_selected_text"), value: flag(params, "read_value"))
        lock.withLock { subscriptions[id] = subscription }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        if WatchState.probe {
            state.send("ax.notification", notificationData(pid: pid, kind: "focus", element: NSNull(), sourceKey: nil, window: nil, watchId: id),
                       generation)
        }
        // The focus and the window are read as soon as the watch subscribes.
        let skipped = AX.skipped(pid)
        let element = skipped ? nil : focusedElement(subscription)
        let window = skipped ? nil : AXOps.focusedWindow(pid)
        return .success(result(pid: pid, watchId: id, element: JSON.optional(element), window: JSON.optional(window.map(windowJSON)),
                               manual: manual))
    }

    private static func stop(_ id: String) {
        state(id).stop()
        let old = lock.withLock { subscriptions.removeValue(forKey: id) }
        if let old { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(old.observer), .commonModes) }
    }

    /// The answer: `element` and `window` while watching, `watch_id` when one was given, `manual_accessibility` when asked.
    static func result(pid: Int32?, watchId: String, element: Any?, window: Any?, manual: Bool?) -> [String: Any] {
        var answer: [String: Any] = ["watching": pid != nil, "pid": pid.map { Int($0) } ?? NSNull()]
        if !watchId.isEmpty { answer["watch_id"] = watchId }
        if pid != nil {
            answer["element"] = element ?? NSNull()
            answer["window"] = window ?? NSNull()
        }
        if let manual { answer["manual_accessibility"] = manual }
        return answer
    }

    /// Window and title notifications carry the focused window.
    static func readsWindow(_ kind: String) -> Bool { kind == "window" || kind == "title" }

    static func notificationData(pid: Int32, kind: String, element: Any, sourceKey: String?, window: Any?, watchId: String) -> [String: Any] {
        var data: [String: Any] = ["pid": Int(pid), "notification": kind, "element": element]
        if let sourceKey { data["source_key"] = sourceKey }
        if let window { data["window"] = window }
        if !watchId.isEmpty { data["watch_id"] = watchId }
        return data
    }

    private static func windowJSON(_ window: (title: String?, doc: String?)) -> [String: Any] {
        ["title": JSON.optional(window.title), "doc": JSON.optional(window.doc)]
    }

    private static let notified: AXObserverCallback = { observer, source, name, _ in
        guard let current = lock.withLock({ subscriptions.values.first { CFEqual($0.observer, observer) } }),
              let kind = names.first(where: { $0.value.contains(name as String) })?.key else { return }
        // The element that sent it: the main process keeps value changes of the focused element only.
        let sourceKey = String(CFHash(source))
        reads.async {
            let state = state(current.id)
            guard state.live(current.generation) else { return }
            let skipped = AX.skipped(current.pid)
            let element = skipped ? nil : focusedElement(current)
            let window = readsWindow(kind) ? JSON.optional(skipped ? nil : AXOps.focusedWindow(current.pid).map(windowJSON)) : nil
            state.send("ax.notification", notificationData(pid: current.pid, kind: kind, element: element ?? NSNull(), sourceKey: sourceKey,
                                                           window: window, watchId: current.id), current.generation)
        }
    }

    /// The app's focused element as an `ax_element`.
    private static func focusedElement(_ subscription: Subscription) -> [String: Any]? {
        let reader = AXReader(pid: subscription.pid, limit: AX.text)
        let app = reader.app()
        guard let element = reader.element(app, kAXFocusedUIElementAttribute) else { return nil }
        let v = reader.attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                            kAXPlaceholderValueAttribute])
        let window = reader.element(element, kAXWindowAttribute) ?? reader.element(app, kAXFocusedWindowAttribute)
        let length = { (reader.value(element, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue }
        let value = { () -> String? in
            AXRules.valueText(length: length(), ranged: { count in
                var range = CFRange(location: 0, length: count)
                return AXValueCreate(.cfRange, &range).flatMap {
                    reader.parameterized(element, kAXStringForRangeParameterizedAttribute, $0) as? String
                }
            }, plain: { reader.string(element, kAXValueAttribute) })
        }
        let info = elementJSON(role: v[0] as? String, subrole: v[1] as? String, title: v[2] as? String, description: v[3] as? String,
                               placeholder: v[4] as? String, key: String(CFHash(element)),
                               window: (window.flatMap { reader.string($0, kAXTitleAttribute) },
                                        AXRules.doc(window.flatMap { reader.string($0, kAXDocumentAttribute) })),
                               valueLength: length, selected: subscription.selected ? { reader.string(element, kAXSelectedTextAttribute) } : nil,
                               value: subscription.value ? value : nil, secureInput: IsSecureEventInputEnabled())
        return reader.timedOut ? nil : info
    }

    /// An `ax_element`. A password node gives its roles, key and window only: none of the closures runs for it, and `value`
    /// is null when asked. While secure input is on, the selection and the value are null when asked and not read.
    static func elementJSON(role: String?, subrole: String?, title: String?, description: String?, placeholder: String?, key: String,
                            window: (title: String?, doc: String?), valueLength: () -> Int?, selected: (() -> String?)?,
                            value: (() -> String?)?, secureInput: Bool) -> [String: Any] {
        var info: [String: Any] = ["role": JSON.optional(role), "native_role": JSON.optional(role), "subrole": JSON.optional(subrole),
                                   "label": NSNull(), "value_length": NSNull(), "window_title": JSON.optional(window.title),
                                   "doc": JSON.optional(window.doc), "element_key": key]
        if AXRules.isSecure(role: role, subrole: subrole, title: title, description: description) {
            if value != nil { info["value"] = NSNull() }
            return info
        }
        info["label"] = JSON.optional(AXRules.label([title, description, placeholder]))
        info["value_length"] = JSON.optional(valueLength())
        if let selected { info["selected_text"] = secureInput ? NSNull() : JSON.optional(selected()) }
        if let value { info["value"] = secureInput ? NSNull() : JSON.optional(value()) }
        return info
    }
}
