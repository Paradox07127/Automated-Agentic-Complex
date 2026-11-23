#include "ops.h"

#include <cstring>
#include <utility>

Outcome success(json::Value result) {
    Outcome out;
    out.result = std::move(result);
    return out;
}

Outcome failure(std::string code, std::string message, bool retryable) {
    Outcome out;
    out.ok = false;
    out.code = std::move(code);
    out.message = std::move(message);
    out.retryable = retryable;
    return out;
}

const OpSpec* find_op(const std::string& name) {
    for (const OpSpec& op : c12_generated::ops()) {
        if (name == op.name) return &op;
    }
    return nullptr;
}

namespace {

// ops.json "types" that params use.
const c12_generated::Type* named_type(const std::string& kind) {
    for (const c12_generated::Type& type : c12_generated::param_types()) {
        if (kind == type.name) return &type;
    }
    return nullptr;
}

// Python's base64.b64decode(validate=True): the standard alphabet, padded to a multiple of 4.
bool is_base64(const std::string& s) {
    if (s.size() % 4 != 0) return false;
    size_t padding = 0;
    for (size_t k = 0; k < s.size(); ++k) {
        char c = s[k];
        if (c == '=') {
            ++padding;
            continue;
        }
        bool letter = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/';
        if (!letter || padding) return false;
    }
    return padding <= 2;
}

std::string fields_error(const json::Value& value, const std::vector<Field>& required,
                         const std::vector<Field>& optional, const std::string& path);

// validate.py's type_error: empty when value has type kind.
std::string type_error(const json::Value& value, std::string kind, const std::string& path) {
    if (!kind.empty() && kind.back() == '?') {
        if (value.type == json::Type::Null) return {};
        kind.pop_back();
    }
    bool ok = false;
    if (kind == "any") ok = true;
    else if (kind == "str") ok = value.type == json::Type::Str;
    else if (kind == "str+") ok = value.type == json::Type::Str && !value.s.empty();
    else if (kind == "int") ok = value.type == json::Type::Int;
    else if (kind == "int+") ok = value.type == json::Type::Int && value.i > 0;
    else if (kind == "uint") ok = value.type == json::Type::Int && value.i >= 0;
    else if (kind == "num") ok = value.is_number();
    else if (kind == "bool") ok = value.type == json::Type::Bool;
    else if (kind == "obj") ok = value.type == json::Type::Obj;
    else if (kind == "b64") ok = value.type == json::Type::Str && is_base64(value.s);
    else if (kind.compare(0, 5, "enum(") == 0 && kind.back() == ')') {
        if (value.type == json::Type::Str) {
            std::string choices = kind.substr(5, kind.size() - 6);
            for (size_t start = 0; !ok && start <= choices.size();) {
                size_t end = choices.find('|', start);
                if (end == std::string::npos) end = choices.size();
                ok = choices.compare(start, end - start, value.s) == 0;
                start = end + 1;
            }
        }
    } else if (kind.compare(0, 4, "arr<") == 0 && kind.back() == '>') {
        if (value.type != json::Type::Arr) return path + " not " + kind;
        std::string item = kind.substr(4, kind.size() - 5);
        for (size_t k = 0; k < value.values.size(); ++k) {
            std::string problem = type_error(value.values[k], item, path + "[" + std::to_string(k) + "]");
            if (!problem.empty()) return problem;
        }
        return {};
    } else if (const c12_generated::Type* type = named_type(kind)) {
        if (value.type != json::Type::Obj) return path + " not " + kind;
        return fields_error(value, type->fields, type->optional, path);
    } else {
        return path + ": unknown type " + kind;
    }
    return ok ? std::string() : path + " not " + kind;
}

std::string fields_error(const json::Value& value, const std::vector<Field>& required,
                         const std::vector<Field>& optional, const std::string& path) {
    for (const Field& field : required) {
        const json::Value* found = value.get(field.name);
        if (!found) return path + "." + field.name + " missing";
        std::string problem = type_error(*found, field.kind, path + "." + field.name);
        if (!problem.empty()) return problem;
    }
    for (const Field& field : optional) {
        const json::Value* found = value.get(field.name);
        if (!found) continue;
        std::string problem = type_error(*found, field.kind, path + "." + field.name);
        if (!problem.empty()) return problem;
    }
    return {};
}

}  // namespace

std::string params_error(const OpSpec& op, const json::Value& params) {
    std::string problem = fields_error(params, op.params, op.optional, std::string(op.name) + ".params");
    if (!problem.empty() || op.one_of.empty()) return problem;
    int given = 0;
    std::string names;
    for (const char* key : op.one_of) {
        if (params.get(key)) ++given;
        names += (names.empty() ? "" : ", ") + std::string(key);
    }
    return given == 1 ? std::string() : std::string(op.name) + ".params needs exactly one of " + names;
}
