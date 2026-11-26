import AppKit

/// `clipboard.read`: items in the order file, then URL, then text, the concealed rule, and every item's
/// types, with no drop limits of its own.
enum Clipboard {
    /// nspasteboard.org markers of a password or a one-off item.
    static let skippedTypes: Set<String> = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"]

    /// Test runs name a private pasteboard here, so that they neither read the user's clipboard nor meet the system's
    /// paste-privacy prompt.
    static let pasteboardName = ProcessInfo.processInfo.environment["AC_HELPER_PASTEBOARD"]

    /// Main thread.
    static func read(_ params: [String: Any]) -> Outcome {
        let pasteboard = pasteboardName.map { NSPasteboard(name: NSPasteboard.Name($0)) } ?? .general
        return .success(read(pasteboard, params))
    }

    static func read(_ pasteboard: NSPasteboard, _ params: [String: Any]) -> [String: Any] {
        let all = pasteboard.pasteboardItems ?? []
        if all.contains(where: { !skippedTypes.isDisjoint(with: $0.types.map(\.rawValue)) }) {
            return ["items": [Any](), "concealed": true, "truncated": false]
        }
        var limit = JSON.int(params["max_items"]) ?? Int.max
        if flag(params, "first_only") { limit = min(limit, 1) }
        let maxText = JSON.int(params["max_text_bytes"])
        var truncated = all.count > (JSON.int(params["max_items"]) ?? Int.max)
        let items: [[String: Any]] = all.prefix(limit).map { item in
            var entry: [String: Any] = ["types": item.types.map(\.rawValue)]
            if let s = item.string(forType: NSPasteboard.PasteboardType("public.file-url")), let url = URL(string: s) {
                // A file reference URL (file:///.file/id=…) resolves to its path without opening the file.
                let path = ((url as NSURL).filePathURL ?? url).path
                if !path.isEmpty { entry["file"] = path }
            } else if let s = item.string(forType: NSPasteboard.PasteboardType("public.url")), !s.isEmpty {
                entry["url"] = s
            } else if let s = item.string(forType: NSPasteboard.PasteboardType("public.utf8-plain-text")), !s.isEmpty {
                if let maxText, s.utf8.count > maxText {
                    entry["text"] = clipped(s, bytes: maxText)
                    truncated = true
                } else {
                    entry["text"] = s
                }
            }
            return entry
        }
        return ["items": items, "concealed": false, "truncated": truncated]
    }

    /// The longest prefix within `bytes` UTF-8 bytes that ends on a Unicode scalar boundary.
    static func clipped(_ text: String, bytes: Int) -> String {
        var end = text.utf8.index(text.utf8.startIndex, offsetBy: bytes)
        while String.Index(end, within: text) == nil { end = text.utf8.index(before: end) }
        return String(text[..<end])
    }
}
