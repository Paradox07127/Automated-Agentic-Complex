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

const std::vector<OpSpec>& op_specs() {
    // ops.json "ops": name, windows in platforms, params, params_optional, params_one_of.
    static const std::vector<OpSpec> specs = {
        {"hello", true, {{"protocol", "int+"}, {"client", "str+"}}, {{"client_version", "str"}}, {}},
        {"cancel", true, {{"target", "int+"}}, {}, {}},
        {"shutdown", true, {}, {}, {}},
        {"screens.list", true, {}, {}, {}},
        {"windows.list", true, {},
         {{"pid", "int+"}, {"layer0_only", "bool"}, {"include_titles", "bool"}, {"limit", "int+"}}, {}},
        {"windows.at_point", true, {{"point", "point"}},
         {{"exclude_pids", "arr<int+>"}, {"layer0_only", "bool"}, {"include_titles", "bool"}}, {}},
        {"workspace.watch", true, {{"enabled", "bool"}}, {}, {}},
        {"attention.sample", true, {},
         {{"include_titles", "bool"}, {"include_input", "bool"}, {"include_audio", "bool"}}, {}},
        {"presence.watch", true, {{"enabled", "bool"}}, {}, {}},
        {"browser.front_tab", true, {{"app_id", "str+"}}, {}, {}},
        {"input.modifiers", true, {}, {}, {}},
        {"input.watch", true, {{"enabled", "bool"}}, {}, {}},
        {"input.actions", true, {{"enabled", "bool"}}, {}, {}},
        {"ax.focused", true, {}, {{"pid", "int+"}}, {}},
        {"ax.dialog_buttons", true, {{"pid", "int+"}}, {}, {}},
        {"ax.overlays", true, {}, {}, {}},
        {"ax.hit_chain", true, {{"point", "point"}}, {{"exclude_pids", "arr<int+>"}}, {}},
        {"ax.window_text", true, {{"pid", "int+"}, {"level", "enum(focused|window)"}},
         {{"window_bounds", "rect"}, {"clip", "rect"}, {"cursor", "str"}, {"max_nodes", "int+"},
          {"max_scalars", "int+"}}, {}},
        {"ax.window_tree", true, {{"pid", "int+"}},
         {{"window_bounds", "rect"}, {"previous", "str+"}, {"max_lines", "int+"}, {"max_scalars", "int+"}}, {}},
        {"ax.selected_text", true, {{"pid", "int+"}}, {}, {}},
        {"ax.video_rect", false, {{"pid", "int+"}}, {}, {}},
        {"ax.watch", true, {{"pid", "int+?"}, {"notifications", "arr<enum(focus|window|title|value|selection)>"}},
         {{"read_selected_text", "bool"}, {"read_value", "bool"}, {"manual_accessibility", "bool"},
          {"watch_id", "str+"}}, {}},
        {"capture.window", true, {{"window_id", "int+"}},
         {{"format", "enum(png|jpeg)"}, {"max_long_side", "int+"}, {"max_bytes", "int+"}}, {}},
        {"capture.ambient", true, {{"source", "enum(screen|wallpaper)"}, {"side", "int+"}},
         {{"rect", "rect"}, {"exclude_pids", "arr<int+>"}, {"display_id", "uint"}}, {}},
        {"ocr.languages", true, {}, {}, {}},
        {"ocr.recognize", true, {}, {{"window_id", "int+"}, {"image", "image"}, {"languages", "arr<str>"}},
         {"window_id", "image"}},
        {"speech.locales", true, {}, {}, {}},
        {"mic.start", true, {{"session", "str+"}, {"locale", "str+"}},
         {{"transcribe", "bool"}, {"level_events", "bool"}}, {}},
        {"mic.stop", true, {{"session", "str+"}}, {{"discard", "bool"}}, {}},
        {"ptt.register", true, {{"combo", "str+"}}, {}, {}},
        {"ptt.unregister", true, {}, {}, {}},
        {"control.observe", true, {{"pid", "int+"}, {"window_id", "int+"}},
         {{"include_text", "bool"}, {"include_image", "bool"}, {"max_elements", "int+"},
          {"max_text_scalars", "int+"}}, {}},
        {"control.act", true, {{"snapshot_id", "str+"}, {"action", "enum(press|set_value|type|click|scroll)"}},
         {{"element_id", "str+"}, {"text", "str"}, {"x", "num"}, {"y", "num"}, {"delta_y", "int"}}, {}},
        {"control.read", true, {{"snapshot_id", "str+"}, {"element_id", "str+"}}, {}, {}},
        {"control.listen", true, {{"endpoint", "str+"}, {"token_file", "str+"}}, {}, {}},
        {"control.respond", true, {{"conn", "int+"}, {"response", "obj"}}, {}, {}},
        {"permissions.status", true, {}, {}, {}},
        {"permissions.request", true,
         {{"kind", "enum(accessibility|screenRecording|microphone|automation|inputMonitoring)"}}, {}, {}},
        {"clipboard.read", true, {}, {{"first_only", "bool"}, {"max_items", "int+"}, {"max_text_bytes", "int+"}}, {}},
        {"apps.running", true, {}, {{"regular_only", "bool"}}, {}},
        {"apps.installed", true, {}, {}, {}},
        {"apps.activate", true, {}, {{"pid", "int+"}, {"app_id", "str+"}, {"ancestors", "bool"}}, {"pid", "app_id"}},
        {"terminal.focus", false, {{"app", "enum(terminal|iterm|ghostty)"}}, {{"tty", "str+"}, {"cwd", "str+"}},
         {"tty", "cwd"}},
        {"process.usage", true, {{"pids", "arr<int+>"}}, {}, {}},
    };
    return specs;
}

const OpSpec* find_op(const std::string& name) {
    for (const OpSpec& op : op_specs()) {
        if (name == op.name) return &op;
    }
    return nullptr;
}

namespace {

// ops.json "types" that params use.
const std::vector<Field>* named_type(const std::string& kind) {
    static const std::vector<Field> rect = {{"x", "num"}, {"y", "num"}, {"width", "num"}, {"height", "num"}};
    static const std::vector<Field> point = {{"x", "num"}, {"y", "num"}};
    static const std::vector<Field> image = {
        {"format", "enum(png|jpeg)"}, {"width", "int+"}, {"height", "int+"}, {"data", "b64"}};
    if (kind == "rect") return &rect;
    if (kind == "point") return &point;
    if (kind == "image") return &image;
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
    } else if (const std::vector<Field>* fields = named_type(kind)) {
        if (value.type != json::Type::Obj) return path + " not " + kind;
        return fields_error(value, *fields, {}, path);
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
