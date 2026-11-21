#include "json.h"

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <utility>

namespace json {

const Value* Value::get(const std::string& key) const {
    for (size_t k = keys.size(); k-- > 0;) {
        if (keys[k] == key) return &values[k];
    }
    return nullptr;
}

Value& Value::set(const std::string& key, Value value) {
    for (size_t k = 0; k < keys.size(); ++k) {
        if (keys[k] == key) return values[k] = std::move(value);
    }
    keys.push_back(key);
    values.push_back(std::move(value));
    return values.back();
}

Value& Value::push(Value value) {
    values.push_back(std::move(value));
    return values.back();
}

Value null() { return Value(); }

Value boolean(bool b) {
    Value v;
    v.type = Type::Bool;
    v.b = b;
    return v;
}

Value integer(int64_t i) {
    Value v;
    v.type = Type::Int;
    v.i = i;
    v.n = static_cast<double>(i);
    return v;
}

Value number(double n) {
    Value v;
    v.type = Type::Num;
    v.n = n;
    return v;
}

Value str(std::string s) {
    Value v;
    v.type = Type::Str;
    v.s = std::move(s);
    return v;
}

Value array() {
    Value v;
    v.type = Type::Arr;
    return v;
}

Value object() {
    Value v;
    v.type = Type::Obj;
    return v;
}

namespace {

// Deeper nesting is refused so that a hostile line cannot exhaust the stack.
constexpr int kMaxDepth = 512;

void put_utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

class Parser {
public:
    explicit Parser(const std::string& text) : text_(text) {}

    bool document(Value& out) {
        if (!value(out)) return false;
        space();
        return at_ == text_.size();
    }

private:
    void space() {
        while (at_ < text_.size() &&
               (text_[at_] == ' ' || text_[at_] == '\t' || text_[at_] == '\n' || text_[at_] == '\r')) {
            ++at_;
        }
    }

    bool eat(char c) {
        if (at_ < text_.size() && text_[at_] == c) {
            ++at_;
            return true;
        }
        return false;
    }

    bool word(const char* w) {
        size_t length = std::strlen(w);
        if (text_.compare(at_, length, w) != 0) return false;
        at_ += length;
        return true;
    }

    bool digit() const { return at_ < text_.size() && text_[at_] >= '0' && text_[at_] <= '9'; }

    void digits() {
        while (digit()) ++at_;
    }

    bool hex4(uint32_t& out) {
        if (at_ + 4 > text_.size()) return false;
        out = 0;
        for (int k = 0; k < 4; ++k) {
            char c = text_[at_++];
            out <<= 4;
            if (c >= '0' && c <= '9') out |= static_cast<uint32_t>(c - '0');
            else if (c >= 'a' && c <= 'f') out |= static_cast<uint32_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') out |= static_cast<uint32_t>(c - 'A' + 10);
            else return false;
        }
        return true;
    }

    // After the opening quote.
    bool string(std::string& out) {
        for (;;) {
            if (at_ >= text_.size()) return false;
            unsigned char c = static_cast<unsigned char>(text_[at_++]);
            if (c == '"') return true;
            if (c < 0x20) return false;
            if (c != '\\') {
                out += static_cast<char>(c);
                continue;
            }
            if (at_ >= text_.size()) return false;
            char escape = text_[at_++];
            switch (escape) {
            case '"': case '\\': case '/': out += escape; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u': {
                uint32_t cp = 0;
                if (!hex4(cp)) return false;
                if (cp >= 0xD800 && cp < 0xDC00 && text_.compare(at_, 2, "\\u") == 0) {
                    size_t back = at_;
                    uint32_t low = 0;
                    at_ += 2;
                    if (hex4(low) && low >= 0xDC00 && low < 0xE000) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    } else {
                        at_ = back;
                    }
                }
                // A lone surrogate has no UTF-8 form.
                if (cp >= 0xD800 && cp < 0xE000) cp = 0xFFFD;
                put_utf8(out, cp);
                break;
            }
            default:
                return false;
            }
        }
    }

    bool number(Value& out) {
        size_t start = at_;
        bool integral = true;
        eat('-');
        if (!eat('0')) {
            if (!digit()) return false;
            digits();
        }
        if (eat('.')) {
            integral = false;
            if (!digit()) return false;
            digits();
        }
        if (at_ < text_.size() && (text_[at_] == 'e' || text_[at_] == 'E')) {
            integral = false;
            ++at_;
            if (!eat('+')) eat('-');
            if (!digit()) return false;
            digits();
        }
        std::string literal = text_.substr(start, at_ - start);
        if (integral) {
            errno = 0;
            long long v = std::strtoll(literal.c_str(), nullptr, 10);
            if (errno != ERANGE) {
                out = integer(v);
                return true;
            }
        }
        out = json::number(std::strtod(literal.c_str(), nullptr));
        return true;
    }

    bool value(Value& out) {
        space();
        if (at_ >= text_.size()) return false;
        char c = text_[at_];
        if (c == '{' || c == '[') {
            if (++depth_ > kMaxDepth) return false;
            ++at_;
            bool ok = c == '{' ? members(out) : items(out);
            --depth_;
            return ok;
        }
        if (c == '"') {
            ++at_;
            std::string s;
            if (!string(s)) return false;
            out = str(std::move(s));
            return true;
        }
        if (word("true")) { out = boolean(true); return true; }
        if (word("false")) { out = boolean(false); return true; }
        if (word("null")) { out = null(); return true; }
        return number(out);
    }

    bool members(Value& out) {
        out = object();
        space();
        if (eat('}')) return true;
        for (;;) {
            space();
            if (!eat('"')) return false;
            std::string key;
            if (!string(key)) return false;
            space();
            if (!eat(':')) return false;
            Value item;
            if (!value(item)) return false;
            out.keys.push_back(std::move(key));
            out.values.push_back(std::move(item));
            space();
            if (eat('}')) return true;
            if (!eat(',')) return false;
        }
    }

    bool items(Value& out) {
        out = array();
        space();
        if (eat(']')) return true;
        for (;;) {
            Value item;
            if (!value(item)) return false;
            out.values.push_back(std::move(item));
            space();
            if (eat(']')) return true;
            if (!eat(',')) return false;
        }
    }

    const std::string& text_;
    size_t at_ = 0;
    int depth_ = 0;
};

void write_string(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
            if (c < 0x20) {
                char escaped[8];
                std::snprintf(escaped, sizeof escaped, "\\u%04x", c);
                out += escaped;
            } else {
                out += static_cast<char>(c);
            }
        }
    }
    out += '"';
}

void write_number(std::string& out, double n) {
    if (!std::isfinite(n)) {
        out += "null";
        return;
    }
    char text[40];
    // The shortest of these that reads back as n.
    for (int precision = 15; precision <= 17; ++precision) {
        std::snprintf(text, sizeof text, "%.*g", precision, n);
        if (std::strtod(text, nullptr) == n) break;
    }
    out += text;
    // Keeps a Num a float for the reader.
    if (!std::strpbrk(text, ".eE")) out += ".0";
}

void write(std::string& out, const Value& v) {
    switch (v.type) {
    case Type::Null: out += "null"; break;
    case Type::Bool: out += v.b ? "true" : "false"; break;
    case Type::Int: out += std::to_string(v.i); break;
    case Type::Num: write_number(out, v.n); break;
    case Type::Str: write_string(out, v.s); break;
    case Type::Arr:
        out += '[';
        for (size_t k = 0; k < v.values.size(); ++k) {
            if (k) out += ',';
            write(out, v.values[k]);
        }
        out += ']';
        break;
    case Type::Obj:
        out += '{';
        for (size_t k = 0; k < v.keys.size(); ++k) {
            if (k) out += ',';
            write_string(out, v.keys[k]);
            out += ':';
            write(out, v.values[k]);
        }
        out += '}';
        break;
    }
}

}  // namespace

bool parse(const std::string& text, Value& out) {
    return Parser(text).document(out);
}

std::string dump(const Value& value) {
    std::string out;
    write(out, value);
    return out;
}

}  // namespace json
