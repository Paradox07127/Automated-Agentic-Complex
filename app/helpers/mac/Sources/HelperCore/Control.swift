import AppKit
import ApplicationServices
import Carbon

/// The window an observation was made of; compared again before every act and read.
struct ControlTarget: Equatable {
    let pid: Int32
    let appId: String
    let windowId: Int
    let bounds: CGRect
    let launchedAt: Double

    var json: [String: Any] {
        ["pid": Int(pid), "app_id": appId, "window_id": windowId, "bounds": rectJSON(bounds), "launched_at": launchedAt]
    }
}

/// The observations `control.act` and `control.read` name (the grants stay in the
/// main process): each lives 15 s, at most 16 are kept, and any action ends all of them. Ids carry a prefix drawn per
/// process, so an id from an earlier helper is stale here (CONTRACT §6.5).
final class ControlSnapshots: @unchecked Sendable {
    static let lifetime: TimeInterval = 15
    static let most = 16

    struct Snapshot {
        let target: ControlTarget
        let elements: [String: AXUIElement]
        let at: TimeInterval
    }

    private let lock = NSLock()
    private let prefix: String
    private var counter = 0
    private var kept: [String: Snapshot] = [:]

    init(prefix: String = String(UInt32.random(in: 1...UInt32.max), radix: 36)) { self.prefix = prefix }

    func add(_ target: ControlTarget, _ elements: [String: AXUIElement], now: TimeInterval) -> String {
        lock.withLock {
            kept = kept.filter { now - $0.value.at < Self.lifetime }
            if kept.count >= Self.most, let oldest = kept.min(by: { $0.value.at < $1.value.at })?.key { kept[oldest] = nil }
            counter += 1
            let id = "o-\(prefix)-\(counter)"
            kept[id] = Snapshot(target: target, elements: elements, at: now)
            return id
        }
    }

    func find(_ id: String, now: TimeInterval) -> Snapshot? {
        lock.withLock {
            guard let found = kept[id], now >= found.at, now - found.at < Self.lifetime else { return nil }
            return found
        }
    }

    func invalidate() { lock.withLock { kept.removeAll() } }
}

/// `max_text_scalars` of CONTRACT §7.8 across one observation, with caps per field.
struct ControlTextBudget {
    private(set) var left: Int
    private(set) var clipped = false

    init(_ scalars: Int) { left = scalars }

    mutating func take(_ text: String, most: Int) -> String {
        let room = max(0, min(most, left))
        let scalars = text.unicodeScalars
        guard scalars.count > room else {
            left -= scalars.count
            return text
        }
        clipped = true
        left -= room
        var kept = String.UnicodeScalarView()
        kept.append(contentsOf: scalars.prefix(room))
        return String(kept)
    }
}

/// The events `control.act` posts for `click` and `scroll`, each marked so that `input.watch` skips it. Under
/// AC_HELPER_INPUT_RECORD they are written to stderr and kept in `recorded` instead of posted: the tests' switch, so that
/// no test sends input into the user's session.
enum ControlInput {
    static let scrollLimit = 600
    static var record = ProcessInfo.processInfo.environment["AC_HELPER_INPUT_RECORD"] != nil
    private static let lock = NSLock()
    private static var kept: [CGEvent] = []

    static var recorded: [CGEvent] { lock.withLock { kept } }

    static func clampScroll(_ deltaY: Int) -> Int { max(-scrollLimit, min(scrollLimit, deltaY)) }

    /// A left click (down and up) or one pixel-unit scroll of `deltaY`, clamped, at `point` in CG global points.
    static func events(_ action: String, at point: CGPoint, deltaY: Int = 0) -> [CGEvent]? {
        let source = CGEventSource(stateID: .privateState)
        let events: [CGEvent]
        if action == "click" {
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
            else { return nil }
            events = [down, up]
        } else {
            guard let scroll = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1,
                                       wheel1: Int32(clampScroll(deltaY)), wheel2: 0, wheel3: 0) else { return nil }
            scroll.location = point
            events = [scroll]
        }
        for event in events { event.setIntegerValueField(.eventSourceUserData, value: InputWatch.marker) }
        return events
    }

    static func post(_ events: [CGEvent], to pid: pid_t) {
        guard record else { return events.forEach { $0.postToPid(pid) } }
        for event in events {
            let line = "ac-helper: recorded input type=\(event.type.rawValue) x=\(event.location.x) y=\(event.location.y) "
                + "delta_y=\(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)) "
                + "marker=\(event.getIntegerValueField(.eventSourceUserData)) pid=\(pid)\n"
            FileHandle.standardError.write(Data(line.utf8))
            lock.withLock { kept.append(event) }
        }
    }
}

/// CONTRACT §7.8 `control.observe`, `control.act` and `control.read`: observe, act and verify
/// without the grants, the blacklist and the redaction, which the main process does.
enum Control {
    static let snapshots = ControlSnapshots()
    static let maxTextBytes = 4096
    static let actionGap: TimeInterval = 0.25
    static let imageBytes = 2_500_000
    /// The walk's own limit, under the op's 5 s with a capture after it.
    static let walkSeconds: TimeInterval = 1
    private static let valueRoles: Set<String> = ["AXStaticText", "AXTextField", "AXTextArea"]
    /// One action at a time, at least `actionGap` apart, in system uptime.
    private static let acting = NSLock()
    private static var lastAction: TimeInterval = 0

    private static var now: TimeInterval { Date().timeIntervalSince1970 }
    /// The tests' switch: secure event input is a session-wide state they do not turn on.
    static var secureInputOn: () -> Bool = { IsSecureEventInputEnabled() }

    private static func fail(_ code: String, _ message: String) -> Outcome { .failure(code: code, message: message) }
    private static let stale = fail("stale_snapshot", "no live snapshot has that id; observe again")
    private static let secureInput = fail("secure_input", "secure event input is on")
    private static let cancelledOutcome = fail("cancelled", "the request was cancelled")
    private static let timedOut = Outcome.failure(code: "timeout", message: "the app did not answer within its AX limit", retryable: true)

    /// The window as it is on screen now; nil when it is gone, belongs to another process or is not a normal window.
    static func target(pid: Int32, windowId: Int) -> ControlTarget? {
        guard let window = Windows.onScreen().first(where: { $0.id == windowId }), window.pid == pid, window.layer == 0 else { return nil }
        let app = NSRunningApplication(processIdentifier: pid)
        return ControlTarget(pid: pid, appId: app?.bundleIdentifier ?? "", windowId: windowId, bounds: window.bounds,
                             launchedAt: app?.launchDate?.timeIntervalSince1970 ?? 0)
    }

    /// The target's AX window: the one window whose frame is within 2 points of its bounds.
    static func axWindow(_ reader: AXReader, _ target: ControlTarget) -> AXUIElement? {
        let windows = reader.elements(reader.app(), kAXWindowsAttribute)
        return AXRules.matchWindow(frames: windows.map { reader.frame($0) }, target: target.bounds).map { windows[$0] }
    }

    static func observe(_ params: [String: Any], cancelled: @escaping () -> Bool) -> Outcome {
        guard AX.trusted else { return AX.denied }
        let text = flag(params, "include_text"), image = flag(params, "include_image")
        if image && !ScreenGrant.granted { return ScreenGrant.denied }
        guard let pid = JSON.int(params["pid"]).flatMap(Int32.init(exactly:)),
              let target = target(pid: pid, windowId: JSON.int(params["window_id"])!) else {
            return fail("window_gone", "that process has no such window on screen")
        }
        guard !secureInputOn() else { return secureInput }
        guard !AX.skipped(pid) else { return AX.timeout(AX.probe) }
        let maxElements = JSON.int(params["max_elements"]) ?? C12Ops.Limits.controlObserveMaxElements
        let workLimit = maxElements > Int.max - 48 ? Int.max : maxElements + 48
        let reader = AXReader(pid: pid, limit: AX.probe, deadline: Date().addingTimeInterval(walkSeconds))
        guard let window = axWindow(reader, target) else {
            return reader.timedOut ? AX.timeout(AX.probe) : fail("window_gone", "no AX window of the app matches that window")
        }
        var budget = ControlTextBudget(JSON.int(params["max_text_scalars"]) ?? C12Ops.Limits.controlObserveMaxTextScalars)
        var elements: [[String: Any]] = [], refs: [String: AXUIElement] = [:], work = [window], head = 0
        var seen: Set<CFHashCode> = []
        while head < work.count, elements.count < maxElements, !reader.expired, !cancelled() {
            let node = work[head]
            head += 1
            guard seen.insert(CFHash(node)).inserted else { continue }
            let v = reader.attributes(node, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                             kAXHiddenAttribute, kAXEnabledAttribute, kAXPositionAttribute, kAXSizeAttribute])
            let title = v[2] as? String, description = v[3] as? String
            guard let role = v[0] as? String, !AXRules.isSecure(role: role, subrole: v[1] as? String, title: title, description: description),
                  (v[4] as? Bool) != true else { continue }
            let frame = AXReader.rect(v[6], v[7])
            if let frame, !frame.isEmpty, !target.bounds.intersects(frame) { continue }
            let id = "e\(elements.count)"
            var item: [String: Any] = ["element_id": id, "role": role, "native_role": role, "enabled": (v[5] as? Bool) ?? true]
            if text {
                item["title"] = budget.take(title ?? description ?? "", most: C12Ops.Limits.controlObserveTitleScalars)
                if valueRoles.contains(role) {
                    let value = reader.string(node, role == "AXTextArea" ? kAXVisibleTextAttribute : kAXValueAttribute)
                    item["value"] = budget.take(value ?? "", most: C12Ops.Limits.controlObserveValueScalars)
                }
            }
            if let frame { item["bounds"] = rectJSON(frame.offsetBy(dx: -target.bounds.minX, dy: -target.bounds.minY)) }
            var actions: CFArray?
            _ = AXUIElementCopyActionNames(node, &actions)
            item["actions"] = ((actions as? [String]) ?? []).filter { $0 == kAXPressAction }
            elements.append(item)
            refs[id] = node
            let room = min(80, workLimit - work.count)
            if room > 0 {
                work += reader.elements(node, kAXVisibleChildrenAttribute, offset: 0, limit: room)
                    ?? reader.elements(node, kAXChildrenAttribute, offset: 0, limit: room) ?? []
            }
        }
        if reader.timedOut { return AX.timeout(AX.probe) }
        if cancelled() { return cancelledOutcome }
        var result: [String: Any] = ["target": target.json, "elements": elements,
                                     "truncated": head < work.count || work.count >= workLimit || reader.expired,
                                     "text_truncated": budget.clipped]
        if image {
            switch Capture.windowImage(target.windowId) {
            case let .failure(failure):
                if case let .failure(code, message, retryable) = failure.outcome, code == "capture_failed" {
                    return .failure(code: "internal", message: message, retryable: retryable)
                }
                return failure.outcome
            case let .success((picture, _)):
                guard let encoded = Capture.encode(picture, jpeg: false, maxLongSide: nil) else {
                    return fail("internal", "the window image could not be encoded")
                }
                guard encoded.data.count <= imageBytes else {
                    return fail("too_large", "the window image has \(encoded.data.count) bytes, over 2.5 MB")
                }
                result["image"] = ["format": "png", "width": encoded.width, "height": encoded.height,
                                   "data": encoded.data.base64EncodedString()]
            }
        }
        result["snapshot_id"] = snapshots.add(target, refs, now: now)
        return .success(result)
    }

    /// The checks `control.act` makes on its params alone, before any AX call; nil when they pass.
    static func paramsProblem(_ params: [String: Any]) -> Outcome? {
        let action = params["action"] as? String ?? ""
        switch action {
        case "press":
            if params["element_id"] == nil { return fail("element_required", "press needs an element_id from the snapshot") }
        case "set_value", "type":
            if params["element_id"] == nil { return fail("element_required", "\(action) needs an element_id from the snapshot") }
            guard let text = params["text"] as? String, text.utf8.count <= maxTextBytes else {
                return fail("invalid_text", "\(action) needs a text of at most 4096 bytes")
            }
        default:
            guard JSON.number(params["x"])?.isFinite == true, JSON.number(params["y"])?.isFinite == true else {
                return fail("invalid_point", "\(action) needs x and y in the window")
            }
            if action == "scroll" && JSON.int(params["delta_y"]) == nil { return fail("invalid_scroll", "scroll needs an integer delta_y") }
        }
        return nil
    }

    /// The snapshot's element after the checks `control.act` and `control.read` share: it exists, it is in the target's
    /// window, which has not moved, and it is no password field.
    private static func element(_ snapshot: ControlSnapshots.Snapshot, _ id: String, _ reader: AXReader) -> Result<AXUIElement, Failure> {
        guard target(pid: snapshot.target.pid, windowId: snapshot.target.windowId) == snapshot.target else {
            return .failure(Failure(fail("target_changed", "the window moved, changed or closed since the snapshot")))
        }
        guard let element = snapshot.elements[id] else { return .failure(Failure(fail("element_gone", "the snapshot has no such element"))) }
        let v = reader.attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                            kAXWindowAttribute])
        guard let role = v[0] as? String else {
            return .failure(Failure(reader.timedOut ? timedOut : fail("element_gone", "the element no longer exists")))
        }
        guard let window = axWindow(reader, snapshot.target) else {
            return .failure(Failure(reader.timedOut ? timedOut : fail("target_changed", "the window has no AX window now")))
        }
        let owner = v[4].flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
        let belongs = role == "AXWindow" ? CFEqual(element, window) : owner.map { CFEqual($0, window) } ?? false
        guard belongs else { return .failure(Failure(fail("target_changed", "the element left the snapshot's window"))) }
        guard !AXRules.isSecure(role: role, subrole: v[1] as? String, title: v[2] as? String, description: v[3] as? String) else {
            return .failure(Failure(fail("secure_element", "the element is a password field")))
        }
        return .success(element)
    }

    struct Failure: Error {
        let outcome: Outcome

        init(_ outcome: Outcome) { self.outcome = outcome }
    }

    static func act(_ params: [String: Any], cancelled: @escaping () -> Bool) -> Outcome {
        if let problem = paramsProblem(params) { return problem }
        guard AX.trusted else { return AX.denied }
        acting.lock()
        defer { acting.unlock() }
        // The wait comes before the checks, so that the action goes out on what they saw.
        let wait = lastAction + actionGap - ProcessInfo.processInfo.systemUptime
        if wait > 0 { Thread.sleep(forTimeInterval: wait) }
        guard let snapshot = snapshots.find(params["snapshot_id"] as! String, now: now) else { return stale }
        guard !secureInputOn() else { return secureInput }
        let target = snapshot.target
        let reader = AXReader(pid: target.pid, limit: AX.text)
        var element: AXUIElement?
        if let id = params["element_id"] as? String {
            switch self.element(snapshot, id, reader) {
            case let .failure(failure): return failure.outcome
            case let .success(found): element = found
            }
        } else if self.target(pid: target.pid, windowId: target.windowId) != target {
            return fail("target_changed", "the window moved, changed or closed since the snapshot")
        }
        guard !cancelled() else { return cancelledOutcome }
        let action = params["action"] as! String
        switch action {
        case "press":
            guard let element else { return fail("element_required", "press needs an element_id from the snapshot") }
            begin()
            AXUIElementSetMessagingTimeout(element, 0.15)
            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
                return fail("action_refused", "the element did not take AXPress")
            }
            return .success(["effect": "unverifiable"])
        case "set_value", "type":
            guard let element else { return fail("element_required", "\(action) needs an element_id from the snapshot") }
            let text = params["text"] as! String
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
                return fail("action_refused", "the element's AXValue cannot be set")
            }
            begin()
            guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) == .success else {
                return fail("action_refused", "the element did not take the text")
            }
            return .success(["effect": reader.string(element, kAXValueAttribute) == text ? "confirmed" : "unverifiable"])
        default:
            let x = JSON.number(params["x"])!, y = JSON.number(params["y"])!
            guard CGRect(origin: .zero, size: target.bounds.size).contains(CGPoint(x: x, y: y)) else {
                return fail("invalid_point", "the point is outside the window")
            }
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else {
                return fail("foreground_required", "the target app is not the front app")
            }
            let point = CGPoint(x: target.bounds.minX + x, y: target.bounds.minY + y)
            guard hits(point, target, reader) else { return fail("occluded_target", "another window or element is at that point") }
            guard let events = ControlInput.events(action, at: point, deltaY: JSON.int(params["delta_y"]) ?? 0) else {
                return fail("internal", "the input events could not be made")
            }
            begin()
            ControlInput.post(events, to: target.pid)
            return .success(["effect": "unverifiable"])
        }
    }

    /// An action goes out: every snapshot ends (CONTRACT §7.8) and the next action waits `actionGap`.
    private static func begin() {
        snapshots.invalidate()
        lastAction = ProcessInfo.processInfo.systemUptime
    }

    /// The element at `point` is the target's window or in it, and no password field.
    private static func hits(_ point: CGPoint, _ target: ControlTarget, _ reader: AXReader) -> Bool {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, AX.probe)
        var hit: AXUIElement?
        var owner: pid_t = 0
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success, let hit,
              AXUIElementGetPid(hit, &owner) == .success, owner == target.pid, let window = axWindow(reader, target) else { return false }
        let v = reader.attributes(hit, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXWindowAttribute])
        let role = v[0] as? String
        guard !AXRules.isSecure(role: role, subrole: v[1] as? String, title: v[2] as? String, description: v[3] as? String) else { return false }
        if role == "AXWindow" { return CFEqual(hit, window) }
        guard let owned = v[4], CFGetTypeID(owned) == AXUIElementGetTypeID() else { return false }
        return CFEqual(owned, window)
    }

    static func read(_ params: [String: Any], cancelled: @escaping () -> Bool) -> Outcome {
        guard let snapshot = snapshots.find(params["snapshot_id"] as! String, now: now) else { return stale }
        guard !secureInputOn() else { return secureInput }
        let reader = AXReader(pid: snapshot.target.pid, limit: AX.text)
        switch element(snapshot, params["element_id"] as! String, reader) {
        case let .failure(failure):
            return failure.outcome
        case let .success(element):
            guard !cancelled() else { return cancelledOutcome }
            let v = reader.attributes(element, [kAXValueAttribute, kAXTitleAttribute])
            if reader.timedOut { return timedOut }
            return .success(["value": JSON.optional(v[0] as? String), "title": JSON.optional(v[1] as? String)])
        }
    }
}
