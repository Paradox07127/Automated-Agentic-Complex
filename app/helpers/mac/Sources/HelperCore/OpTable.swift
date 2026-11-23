import Foundation

/// One field of a params object: its name and its ops.json type (`int+`, `arr<str>`, `rect?` …).
struct Field {
    let name: String
    let kind: String

    init(_ name: String, _ kind: String) {
        self.name = name
        self.kind = kind
    }
}

/// One op of ops.json: its params, params_optional and params_one_of. Every op there lists macos in its platforms.
struct OpSpec {
    let name: String
    let params: [Field]
    let optional: [Field]
    let oneOf: [String]

    init(_ name: String, _ params: [Field] = [], _ optional: [Field] = [], oneOf: [String] = []) {
        self.name = name
        self.params = params
        self.optional = optional
        self.oneOf = oneOf
    }
}

enum OpTable {
    /// ops.json "ops" in its order; tests/replay.py's sweep fails when this disagrees with it about required params.
    static let specs: [OpSpec] = [
        OpSpec("hello", [Field("protocol", "int+"), Field("client", "str+")], [Field("client_version", "str")]),
        OpSpec("cancel", [Field("target", "int+")]),
        OpSpec("shutdown"),
        OpSpec("screens.list"),
        OpSpec("windows.list", [], [Field("pid", "int+"), Field("layer0_only", "bool"), Field("include_titles", "bool"),
                                    Field("limit", "int+")]),
        OpSpec("windows.at_point", [Field("point", "point")],
               [Field("exclude_pids", "arr<int+>"), Field("layer0_only", "bool"), Field("include_titles", "bool")]),
        OpSpec("workspace.watch", [Field("enabled", "bool")]),
        OpSpec("attention.sample", [], [Field("include_titles", "bool"), Field("include_input", "bool"),
                                        Field("include_audio", "bool")]),
        OpSpec("presence.watch", [Field("enabled", "bool")]),
        OpSpec("browser.front_tab", [Field("app_id", "str+")]),
        OpSpec("input.modifiers"),
        OpSpec("input.watch", [Field("enabled", "bool")]),
        OpSpec("input.actions", [Field("enabled", "bool")]),
        OpSpec("ax.focused", [], [Field("pid", "int+")]),
        OpSpec("ax.dialog_buttons", [Field("pid", "int+")]),
        OpSpec("ax.overlays"),
        OpSpec("ax.hit_chain", [Field("point", "point")], [Field("exclude_pids", "arr<int+>")]),
        OpSpec("ax.window_text", [Field("pid", "int+"), Field("level", "enum(focused|window)")],
               [Field("window_bounds", "rect"), Field("cursor", "str"), Field("max_nodes", "int+"),
                Field("max_scalars", "int+")]),
        OpSpec("ax.window_tree", [Field("pid", "int+")],
               [Field("window_bounds", "rect"), Field("previous", "str+"), Field("max_lines", "int+"), Field("max_scalars", "int+")]),
        OpSpec("ax.selected_text", [Field("pid", "int+")]),
        OpSpec("ax.video_rect", [Field("pid", "int+")]),
        OpSpec("ax.watch", [Field("pid", "int+?"), Field("notifications", "arr<enum(focus|window|title|value|selection)>")],
               [Field("read_selected_text", "bool"), Field("read_value", "bool"), Field("manual_accessibility", "bool"),
                Field("watch_id", "str+")]),
        OpSpec("capture.window", [Field("window_id", "int+")],
               [Field("format", "enum(png|jpeg)"), Field("max_long_side", "int+"), Field("max_bytes", "int+")]),
        OpSpec("capture.ambient", [Field("source", "enum(screen|wallpaper)"), Field("side", "int+")],
               [Field("rect", "rect"), Field("exclude_pids", "arr<int+>"), Field("display_id", "uint")]),
        OpSpec("ocr.languages"),
        OpSpec("ocr.recognize", [], [Field("window_id", "int+"), Field("image", "image"), Field("languages", "arr<str>")],
               oneOf: ["window_id", "image"]),
        OpSpec("speech.locales"),
        OpSpec("mic.start", [Field("session", "str+"), Field("locale", "str+")],
               [Field("transcribe", "bool"), Field("level_events", "bool")]),
        OpSpec("mic.stop", [Field("session", "str+")], [Field("discard", "bool")]),
        OpSpec("ptt.register", [Field("combo", "str+")]),
        OpSpec("ptt.unregister"),
        OpSpec("control.observe", [Field("pid", "int+"), Field("window_id", "int+")],
               [Field("include_text", "bool"), Field("include_image", "bool"), Field("max_elements", "int+"),
                Field("max_text_scalars", "int+")]),
        OpSpec("control.act", [Field("snapshot_id", "str+"), Field("action", "enum(press|set_value|type|click|scroll)")],
               [Field("element_id", "str+"), Field("text", "str"), Field("x", "num"), Field("y", "num"), Field("delta_y", "int")]),
        OpSpec("control.read", [Field("snapshot_id", "str+"), Field("element_id", "str+")]),
        OpSpec("control.listen", [Field("endpoint", "str+"), Field("token_file", "str+")]),
        OpSpec("control.respond", [Field("conn", "int+"), Field("response", "obj")]),
        OpSpec("permissions.status"),
        OpSpec("permissions.request",
               [Field("kind", "enum(accessibility|screenRecording|microphone|automation|inputMonitoring|notifications)")]),
        OpSpec("clipboard.read", [], [Field("first_only", "bool"), Field("max_items", "int+"), Field("max_text_bytes", "int+")]),
        OpSpec("apps.running", [], [Field("regular_only", "bool")]),
        OpSpec("apps.installed"),
        OpSpec("apps.activate", [], [Field("pid", "int+"), Field("app_id", "str+"), Field("ancestors", "bool")],
               oneOf: ["pid", "app_id"]),
        OpSpec("terminal.focus", [Field("app", "enum(terminal|iterm|ghostty)")], [Field("tty", "str+"), Field("cwd", "str+")],
               oneOf: ["tty", "cwd"]),
        OpSpec("process.usage", [Field("pids", "arr<int+>")]),
    ]

    static func find(_ name: String) -> OpSpec? { specs.first { $0.name == name } }

    /// ops.json "types" that params use.
    private static let namedTypes: [String: [Field]] = [
        "rect": [Field("x", "num"), Field("y", "num"), Field("width", "num"), Field("height", "num")],
        "point": [Field("x", "num"), Field("y", "num")],
        "image": [Field("format", "enum(png|jpeg)"), Field("width", "int+"), Field("height", "int+"), Field("data", "b64")],
    ]

    /// validate.py's check of a request's params: nil when they pass, else the first problem.
    static func paramsError(_ op: OpSpec, _ params: [String: Any]) -> String? {
        if let problem = fieldsError(params, op.params, op.optional, "\(op.name).params") { return problem }
        guard !op.oneOf.isEmpty else { return nil }
        let given = op.oneOf.filter { params[$0] != nil }.count
        return given == 1 ? nil : "\(op.name).params needs exactly one of \(op.oneOf.joined(separator: ", "))"
    }

    private static func fieldsError(_ value: [String: Any], _ required: [Field], _ optional: [Field], _ path: String) -> String? {
        for field in required {
            guard let found = value[field.name] else { return "\(path).\(field.name) missing" }
            if let problem = typeError(found, field.kind, "\(path).\(field.name)") { return problem }
        }
        for field in optional {
            guard let found = value[field.name] else { continue }
            if let problem = typeError(found, field.kind, "\(path).\(field.name)") { return problem }
        }
        return nil
    }

    /// validate.py's type_error.
    static func typeError(_ value: Any, _ kind: String, _ path: String) -> String? {
        var kind = kind
        if kind.hasSuffix("?") {
            if value is NSNull { return nil }
            kind.removeLast()
        }
        let ok: Bool
        switch kind {
        case "any": ok = true
        case "str": ok = value is String
        case "str+": ok = (value as? String).map { !$0.isEmpty } ?? false
        case "int": ok = JSON.int(value) != nil
        case "int+": ok = (JSON.int(value) ?? 0) > 0
        case "uint": ok = (JSON.int(value) ?? -1) >= 0
        case "num": ok = JSON.number(value) != nil
        case "bool": ok = JSON.bool(value) != nil
        case "obj": ok = value is [String: Any]
        case "b64": ok = (value as? String).map(isBase64) ?? false
        default:
            if kind.hasPrefix("enum("), kind.hasSuffix(")") {
                let choices = kind.dropFirst(5).dropLast().split(separator: "|").map(String.init)
                ok = (value as? String).map(choices.contains) ?? false
            } else if kind.hasPrefix("arr<"), kind.hasSuffix(">") {
                guard let items = value as? [Any] else { return "\(path) not \(kind)" }
                let item = String(kind.dropFirst(4).dropLast())
                for (k, element) in items.enumerated() {
                    if let problem = typeError(element, item, "\(path)[\(k)]") { return problem }
                }
                return nil
            } else if let fields = namedTypes[kind] {
                guard let object = value as? [String: Any] else { return "\(path) not \(kind)" }
                return fieldsError(object, fields, [], path)
            } else {
                return "\(path): unknown type \(kind)"
            }
        }
        return ok ? nil : "\(path) not \(kind)"
    }

    /// Python's base64.b64decode(validate=True): the standard alphabet, padded to a multiple of 4.
    static func isBase64(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count % 4 == 0 else { return false }
        var padding = 0
        for c in bytes {
            if c == UInt8(ascii: "=") {
                padding += 1
                continue
            }
            let letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 43 || c == 47
            if !letter || padding > 0 { return false }
        }
        return padding <= 2
    }
}
