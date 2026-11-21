// Just enough JSON for C12: one value type, a strict parser and a compact writer.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace json {

enum class Type { Null, Bool, Int, Num, Str, Arr, Obj };

struct Value {
    Type type = Type::Null;
    bool b = false;
    int64_t i = 0;     // Int
    double n = 0;      // Num, and Int as a double
    std::string s;     // Str
    std::vector<std::string> keys;  // Obj, in order
    std::vector<Value> values;      // Arr items, or Obj values parallel to keys

    bool is_number() const { return type == Type::Int || type == Type::Num; }
    // The last field named key (a repeated key keeps its last value, as Python's json does), or nullptr.
    const Value* get(const std::string& key) const;
    // Replaces the field named key, or appends it.
    Value& set(const std::string& key, Value value);
    Value& push(Value value);
};

Value null();
Value boolean(bool b);
// A number written without fraction or exponent; validate.py's int.
Value integer(int64_t i);
Value number(double n);
Value str(std::string s);
Value array();
Value object();

// False when text is not exactly one JSON value (RFC 8259; no NaN or Infinity).
bool parse(const std::string& text, Value& out);
// One line: no whitespace, UTF-8 passed through, control characters escaped.
std::string dump(const Value& value);

}  // namespace json
