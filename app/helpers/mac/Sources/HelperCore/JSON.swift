import Foundation

/// JSON as JSONSerialization reads and writes it. C12 tells `1` from `1.0` (validate.py's `int` against `num`), which an
/// NSNumber keeps: JSONSerialization reads `1.0` as a floating-point number and `true` as a CFBoolean.
enum JSON {
    static func isBool(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    static func bool(_ value: Any?) -> Bool? {
        guard let value, isBool(value) else { return nil }
        return (value as! NSNumber).boolValue
    }

    /// An integer that fits in Int; not a boolean and not a number written with a fraction or an exponent.
    static func int(_ value: Any?) -> Int? {
        guard let value, let number = value as? NSNumber, !isBool(value), !(value is NSDecimalNumber),
              !CFNumberIsFloatType(number as CFNumber) else { return nil }
        return Int(exactly: number)
    }

    static func number(_ value: Any?) -> Double? {
        guard let value, let number = value as? NSNumber, !isBool(value) else { return nil }
        return number.doubleValue
    }

    /// The value of one line, or nil when the bytes are not one JSON value (a JSON null is NSNull).
    static func parse(_ bytes: ArraySlice<UInt8>) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(bytes), options: [.fragmentsAllowed])
    }

    /// One line without its newline; nil when the value holds something JSON cannot write (NaN, infinity).
    static func dump(_ value: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        return try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])
    }

    static func optional(_ value: Any?) -> Any { value ?? NSNull() }
}
