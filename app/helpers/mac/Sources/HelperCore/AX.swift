import AppKit
import ApplicationServices

/// The AX limits of CONTRACT §5.3: every message has its own timeout (50 ms for probes, 250 ms for reading text), and
/// an app that timed out answers `ax_timeout` for 2 s without being asked.
enum AX {
    static let probe: Float = 0.05
    static let text: Float = 0.25
    private static let skipSeconds: TimeInterval = 2
    private static let lock = NSLock()
    private static var skipUntil: [Int32: Date] = [:]
    /// Test runs set it to take the no-grant path on a Mac that has the grant.
    private static let deniedForTests = ProcessInfo.processInfo.environment["AC_HELPER_AX_DENIED"] != nil

    /// The non-prompting check only.
    static var trusted: Bool { !deniedForTests && AXIsProcessTrusted() }

    static func skipped(_ pid: Int32) -> Bool { lock.withLock { (skipUntil[pid] ?? .distantPast) > Date() } }

    static func timedOut(_ pid: Int32) { lock.withLock { skipUntil[pid] = Date().addingTimeInterval(skipSeconds) } }

    static let denied = Outcome.failure(code: "permission_denied", message: "the helper lacks the Accessibility grant")
    static let gone = Outcome.failure(code: "process_gone", message: "no process has that pid")

    static func timeout(_ limit: Float) -> Outcome {
        .failure(code: "ax_timeout", message: "the app did not answer within \(Int(limit * 1000)) ms", retryable: true)
    }

    /// A pid of params as a pid_t of a process that exists, else nil.
    static func livePid(_ value: Any?) -> Int32? {
        guard let pid = JSON.int(value), pid <= Int(Int32.max), Apps.alive(Int32(pid)) else { return nil }
        return Int32(pid)
    }
}

/// One request's AX reads of one app. The first timeout puts the app on the skip list and ends the reads: every later
/// call answers nil at once, and the op answers `ax_timeout`.
final class AXReader {
    let pid: Int32
    private let limit: Float
    private let deadline: Date?
    private(set) var timedOut = false
    /// The last failure other than a timeout or a missing value.
    private(set) var failure: AXError?

    /// `deadline` ends the reads too, and shortens each message to the time left.
    init(pid: Int32, limit: Float, deadline: Date? = nil) {
        self.pid = pid
        self.limit = limit
        self.deadline = deadline
    }

    var expired: Bool { timedOut || deadline.map { Date() >= $0 } ?? false }

    func app() -> AXUIElement { AXUIElementCreateApplication(pid) }

    private func prepare(_ element: AXUIElement) -> Bool {
        guard !expired else { return false }
        let left = deadline.map { Float(max(0.001, $0.timeIntervalSinceNow)) } ?? limit
        AXUIElementSetMessagingTimeout(element, min(limit, left))
        return true
    }

    /// Records the status; true on success.
    @discardableResult
    func note(_ status: AXError) -> Bool {
        switch status {
        case .success: return true
        case .cannotComplete:
            timedOut = true
            AX.timedOut(pid)
        case .noValue, .attributeUnsupported, .parameterizedAttributeUnsupported: break
        default: failure = status
        }
        return false
    }

    func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        guard prepare(element) else { return nil }
        var value: CFTypeRef?
        return note(AXUIElementCopyAttributeValue(element, attribute as CFString, &value)) ? value : nil
    }

    func element(_ parent: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = value(parent, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    func elements(_ parent: AXUIElement, _ attribute: String) -> [AXUIElement] {
        (value(parent, attribute) as? [AXUIElement]) ?? []
    }

    func string(_ element: AXUIElement, _ attribute: String) -> String? { value(element, attribute) as? String }

    /// Up to `limit` items of an array attribute from `offset`.
    func elements(_ parent: AXUIElement, _ attribute: String, offset: Int, limit: Int) -> [AXUIElement]? {
        guard prepare(parent) else { return nil }
        var values: CFArray?
        guard note(AXUIElementCopyAttributeValues(parent, attribute as CFString, offset, limit, &values)) else { return nil }
        return (values as? [AXUIElement]) ?? []
    }

    /// One message for several attributes; a missing one is nil.
    func attributes(_ element: AXUIElement, _ names: [String]) -> [CFTypeRef?] {
        let missing = [CFTypeRef?](repeating: nil, count: names.count)
        guard prepare(element) else { return missing }
        var values: CFArray?
        guard note(AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)),
              let items = values as [AnyObject]? else { return missing }
        return names.indices.map { k -> CFTypeRef? in
            guard k < items.count else { return nil }
            let item = items[k]
            if CFGetTypeID(item) == AXValueGetTypeID(), AXValueGetType(item as! AXValue) == .axError { return nil }
            return item
        }
    }

    func parameterized(_ element: AXUIElement, _ attribute: String, _ parameter: CFTypeRef) -> CFTypeRef? {
        guard prepare(element) else { return nil }
        var value: CFTypeRef?
        return note(AXUIElementCopyParameterizedAttributeValue(element, attribute as CFString, parameter, &value)) ? value : nil
    }

    /// Role, subrole and frame in CG global points, from one message.
    func describe(_ element: AXUIElement) -> (role: String?, subrole: String?, frame: CGRect?) {
        let v = attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute])
        return (v[0] as? String, v[1] as? String, AXReader.rect(v[2], v[3]))
    }

    func frame(_ element: AXUIElement) -> CGRect? {
        let v = attributes(element, [kAXPositionAttribute, kAXSizeAttribute])
        return AXReader.rect(v[0], v[1])
    }

    static func rect(_ position: CFTypeRef?, _ size: CFTypeRef?) -> CGRect? {
        guard let position, CFGetTypeID(position) == AXValueGetTypeID(), let size, CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return CGRect(origin: origin, size: dimensions)
    }
}

/// The rules of the AX ops that need no AX, all in CG global points.
enum AXRules {
    static let editableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]
    static let editableSubroles: Set<String> = ["AXSearchField", "AXSecureTextField"]
    static let caretMargin: CGFloat = 40
    static let bannerWidth: ClosedRange<CGFloat> = 200...600
    static let bannerHeight: ClosedRange<CGFloat> = 40...400
    /// Her window level: IME windows at or above it are above her already.
    static let ownLayer = 25

    /// CONTRACT §7.4: these nodes are never read.
    static func isSecure(role: String?, subrole: String?, title: String?, description: String?) -> Bool {
        let identity = [role ?? "", subrole ?? "", title ?? "", description ?? ""].joined(separator: " ").lowercased()
        return C12Ops.secureKeywords.contains(where: identity.contains)
    }

    /// A secure field counts too; its value is never read.
    static func isEditable(role: String?, subrole: String?) -> Bool {
        if let role, editableRoles.contains(role) { return true }
        if let subrole, editableSubroles.contains(subrole) { return true }
        return false
    }

    /// `bounds` from AXBoundsForRange; nil when it is no usable caret for `field`.
    static func caret(bounds: CGRect?, field: CGRect) -> CGRect? {
        guard let bounds, bounds.height >= 4, field.insetBy(dx: -caretMargin, dy: -caretMargin).contains(bounds) else { return nil }
        return CGRect(x: bounds.minX, y: bounds.minY, width: max(bounds.width, 2), height: bounds.height)
    }

    /// `buttons` are the default and cancel button frames of the focused window or its sheet.
    static func dialogButtons(windowSubrole: String?, hasSheet: Bool, buttons: [CGRect]) -> [CGRect] {
        guard hasSheet || windowSubrole == "AXDialog" || windowSubrole == "AXSystemDialog" else { return [] }
        return buttons
    }

    /// Notification Center element frames to banner frames; the full-screen container is not a banner.
    static func banners(_ frames: [CGRect], screen: CGRect) -> [CGRect] {
        frames.filter { bannerWidth.contains($0.width) && bannerHeight.contains($0.height) && screen.contains($0) }
    }

    /// Visible windows of input method processes below her layer.
    static func imeRects(_ windows: [Windows.Window], inputMethodPids: Set<Int32>) -> [CGRect] {
        windows.filter { inputMethodPids.contains($0.pid) && $0.layer < ownLayer && $0.alpha > 0 }.map(\.bounds)
    }

    /// The one frame within 2 points of `target`; nil when none or several are.
    static func matchWindow(frames: [CGRect?], target: CGRect, tolerance: CGFloat = 2) -> Int? {
        let matches = frames.indices.filter { k in
            guard let f = frames[k] else { return false }
            return abs(f.minX - target.minX) <= tolerance && abs(f.minY - target.minY) <= tolerance
                && abs(f.width - target.width) <= tolerance && abs(f.height - target.height) <= tolerance
        }
        return matches.count == 1 ? matches[0] : nil
    }

    /// `ancestors` runs from the focused element upward; the index of the first window or sheet.
    static func focusWindow(ancestors: [(role: String?, subrole: String?)]) -> Int? {
        ancestors.firstIndex { $0.role == "AXWindow" || $0.role == "AXSheet" }
    }

    static func label(_ candidates: [String?]) -> String? {
        candidates.lazy.compactMap { $0 }.first { !$0.isEmpty }
    }

    /// The `length` characters from AXStringForRange (`ranged`), else AXValue (`plain`).
    static func valueText(length: Int?, ranged: (Int) -> String?, plain: () -> String?) -> String? {
        if let length {
            if length == 0 { return "" }
            if let text = ranged(length) { return text }
        }
        return plain()
    }

    /// AXDocument as a path when it is a file URL.
    static func doc(_ raw: String?) -> String? {
        guard let raw else { return nil }
        if raw.hasPrefix("file://"), let url = URL(string: raw) { return url.path }
        return raw
    }
}
