import Foundation

/// The ops.json checks of a request's params over the generated `C12Ops` table.
enum OpTable {
    static func find(_ name: String) -> C12Ops.Op? { C12Ops.ops.first { $0.name == name } }

    /// validate.py's check of a request's params: nil when they pass, else the first problem.
    static func paramsError(_ op: C12Ops.Op, _ params: [String: Any]) -> String? {
        if let problem = fieldsError(params, op.params, op.optional, "\(op.name).params") { return problem }
        guard !op.oneOf.isEmpty else { return nil }
        let given = op.oneOf.filter { params[$0] != nil }.count
        return given == 1 ? nil : "\(op.name).params needs exactly one of \(op.oneOf.joined(separator: ", "))"
    }

    private static func fieldsError(_ value: [String: Any], _ required: [(name: String, kind: String)],
                                    _ optional: [(name: String, kind: String)], _ path: String) -> String? {
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
            } else if let shape = C12Ops.paramTypes[kind] {
                guard let object = value as? [String: Any] else { return "\(path) not \(kind)" }
                return fieldsError(object, shape.fields, shape.optional, path)
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
