// ac-helper.exe: the Windows platform helper of protocol/C12-platform-helper. This file is the session layer:
// NDJSON on stdin and stdout (CONTRACT §2), errors (§3), hello (§4), cancel (§5) and exit (§6).
#define NOMINMAX
#include <windows.h>

#include <cstdio>
#include <cstring>
#include <exception>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "json.h"
#include "ops.h"

namespace {

constexpr size_t kMaxLineBytes = 16777216;  // ops.json max_line_bytes, the newline included
constexpr int64_t kProtocol = 1;
constexpr const char* kHelperVersion = "0.1.0";

HANDLE g_stdout = nullptr;
// Held while writing to stdout and while reading or changing g_running and g_ready, so that an answer is written
// at most once and nothing follows the shutdown answer.
std::mutex g_lock;
std::map<int64_t, std::string> g_running;  // id -> op of each request whose handler has not answered yet
bool g_ready = false;                      // hello answered
int64_t g_seq = 0;                         // the last event's seq
int64_t g_last_id = 0;                     // the highest request id read so far; only the stdin loop uses it

bool is_session_op(const char* name) {
    return std::strcmp(name, "hello") == 0 || std::strcmp(name, "cancel") == 0 || std::strcmp(name, "shutdown") == 0;
}

// False when the line would be longer than max_line_bytes; then nothing is written.
bool write_message(const json::Value& message) {
    std::string line = json::dump(message);
    line += '\n';
    if (line.size() > kMaxLineBytes) return false;
    const char* data = line.data();
    size_t left = line.size();
    while (left > 0) {
        DWORD wrote = 0;
        DWORD chunk = static_cast<DWORD>(left < (1u << 30) ? left : (1u << 30));
        if (!WriteFile(g_stdout, data, chunk, &wrote, nullptr)) return true;  // the main process is gone
        data += wrote;
        left -= wrote;
    }
    return true;
}

void answer(int64_t id, const Outcome& out) {
    json::Value message = json::object();
    message.set("v", json::integer(1));
    message.set("id", json::integer(id));
    message.set("ok", json::boolean(out.ok));
    if (out.ok) {
        message.set("result", out.result);
    } else {
        json::Value error = json::object();
        error.set("code", json::str(out.code));
        error.set("message", json::str(out.message));
        if (out.retryable) error.set("retryable", json::boolean(true));
        message.set("error", std::move(error));
    }
    if (!write_message(message)) answer(id, failure("internal", "the answer is longer than max_line_bytes"));
}

// Exit code 2 after one line on stderr (CONTRACT §6.2).
[[noreturn]] void protocol_error(const char* why) {
    std::lock_guard<std::mutex> hold(g_lock);
    std::fprintf(stderr, "ac-helper: protocol error: %s\n", why);
    std::fflush(stderr);
    ExitProcess(2);
}

std::string os_version() {
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    RTL_OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof info;
    auto get = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
    if (!get || get(&info) != 0) return "Windows";
    std::string build = std::to_string(info.dwBuildNumber);
    if (info.dwMajorVersion == 10) return (info.dwBuildNumber >= 22000 ? "Windows 11 " : "Windows 10 ") + build;
    return "Windows " + std::to_string(info.dwMajorVersion) + "." + std::to_string(info.dwMinorVersion) + " " + build;
}

std::string arch() {
    USHORT process = 0, native = 0;
    if (IsWow64Process2(GetCurrentProcess(), &process, &native)) {
        if (native == IMAGE_FILE_MACHINE_ARM64) return "arm64";
        if (native == IMAGE_FILE_MACHINE_AMD64) return "x64";
        if (native == IMAGE_FILE_MACHINE_I386) return "x86";
    }
    return "unknown";
}

// Callers hold g_lock.
void hello(int64_t id, const json::Value& params) {
    int64_t asked = params.get("protocol")->i;
    if (asked != kProtocol) {
        answer(id, failure("protocol_mismatch", "this helper speaks protocol 1"));
        std::fprintf(stderr, "ac-helper: hello asked for protocol %lld; this helper speaks 1\n",
                     static_cast<long long>(asked));
        std::fflush(stderr);
        ExitProcess(3);
    }
    json::Value ops = json::array();
    for (const OpSpec& op : op_specs()) {
        if (is_session_op(op.name) || (op.windows && find_handler(op.name))) ops.push(json::str(op.name));
    }
    json::Value result = json::object();
    result.set("protocol", json::integer(kProtocol));
    result.set("platform", json::str("windows"));
    result.set("helper_version", json::str(kHelperVersion));
    result.set("os_version", json::str(os_version()));
    result.set("arch", json::str(arch()));
    result.set("pid", json::integer(GetCurrentProcessId()));
    result.set("ops", std::move(ops));
    json::Value events = json::array();
    for (const char* event : event_names()) events.push(json::str(event));
    result.set("events", std::move(events));
    g_ready = true;
    answer(id, success(std::move(result)));
}

// Callers hold g_lock.
void cancel(int64_t id, int64_t target) {
    bool running = g_running.erase(target) > 0;
    if (running) answer(target, failure("cancelled", "cancelled by request " + std::to_string(id)));
    json::Value result = json::object();
    result.set("cancelled", json::boolean(running));
    answer(id, success(std::move(result)));
}

// Callers hold g_lock. Every request in flight gets its one answer before the shutdown answer (CONTRACT §6.1).
[[noreturn]] void shutdown(int64_t id) {
    for (const auto& running : g_running) answer(running.first, failure("cancelled", "the helper is shutting down"));
    g_running.clear();
    answer(id, success(json::object()));
    ExitProcess(0);
}

void run(int64_t id, Handler handler, json::Value params) {
    {
        std::lock_guard<std::mutex> hold(g_lock);
        if (!g_running.count(id)) return;  // cancelled before it started
    }
    Outcome out;
    try {
        out = handler(params);
    } catch (const std::exception&) {
        out = failure("internal", "the op threw an exception");
    }
    std::lock_guard<std::mutex> hold(g_lock);
    if (!g_running.erase(id)) return;
    answer(id, out);
    if (out.ok && out.answered) out.answered();
}

void dispatch(int64_t id, const std::string& name, const json::Value* params) {
    std::lock_guard<std::mutex> hold(g_lock);
    if (!g_ready && name != "hello") return answer(id, failure("not_ready", "the hello request has not been answered"));
    const OpSpec* op = find_op(name);
    if (!op) return answer(id, failure("unknown_op", "this helper does not know the op"));
    if (!params || params->type != json::Type::Obj) return answer(id, failure("bad_request", "params is not an object"));
    std::string problem = params_error(*op, *params);
    if (!problem.empty()) return answer(id, failure("bad_request", problem));
    if (name == "hello") return hello(id, *params);
    if (name == "cancel") return cancel(id, params->get("target")->i);
    if (name == "shutdown") shutdown(id);
    if (!op->windows) return answer(id, failure("unsupported", name + " is macOS only"));
    Handler handler = find_handler(name);
    if (!handler) return answer(id, failure("unsupported", name + " is not implemented in the Windows helper yet"));
    g_running[id] = name;
    try {
        std::thread(run, id, handler, *params).detach();
    } catch (const std::exception&) {
        g_running.erase(id);
        answer(id, failure("internal", "cannot start a thread for the op"));
    }
}

void handle_line(const std::string& line) {
    if (line.find_first_not_of(" \t\r") == std::string::npos) return;
    json::Value message;
    if (!json::parse(line, message)) protocol_error("a line is not JSON");
    if (message.type != json::Type::Obj) protocol_error("a line is not a JSON object");
    const json::Value* v = message.get("v");
    if (!v || !v->is_number() || v->n != 1) protocol_error("a message has no \"v\": 1");
    const json::Value* op = message.get("op");
    if (!op || op->type != json::Type::Str || message.get("ok") || message.get("event")) {
        protocol_error("a message from the main process is not a request");
    }
    const json::Value* id = message.get("id");
    if (!id || id->type != json::Type::Int || id->i <= 0) protocol_error("a request id is not a positive integer");
    if (id->i <= g_last_id) protocol_error("a request id is not above every earlier one");
    g_last_id = id->i;
    dispatch(id->i, op->s, message.get("params"));
}

}  // namespace

void send_event(const char* name, json::Value data, const std::atomic<bool>& live) {
    std::lock_guard<std::mutex> hold(g_lock);
    if (!live) return;
    json::Value message = json::object();
    message.set("v", json::integer(1));
    message.set("event", json::str(name));
    message.set("seq", json::integer(++g_seq));
    message.set("data", std::move(data));
    if (!write_message(message)) {
        --g_seq;
        std::fprintf(stderr, "ac-helper: dropped a %s event that is longer than max_line_bytes\n", name);
        std::fflush(stderr);
    }
}

int main() {
    // Window and screen coordinates in physical pixels (CONTRACT §2.8).
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    start_watches();
    g_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    std::string pending;
    size_t scanned = 0;  // pending[0, scanned) holds no newline
    std::vector<char> chunk(1 << 16);
    for (;;) {
        size_t newline = pending.find('\n', scanned);
        if (newline == std::string::npos) {
            if (pending.size() >= kMaxLineBytes) protocol_error("a line is longer than max_line_bytes");
            scanned = pending.size();
            DWORD got = 0;
            if (!ReadFile(input, chunk.data(), static_cast<DWORD>(chunk.size()), &got, nullptr) || got == 0) break;
            pending.append(chunk.data(), got);
            continue;
        }
        if (newline + 1 > kMaxLineBytes) protocol_error("a line is longer than max_line_bytes");
        std::string line = pending.substr(0, newline);
        pending.erase(0, newline + 1);
        scanned = 0;
        handle_line(line);
    }
    if (pending.find_first_not_of(" \t\r") != std::string::npos) protocol_error("the last line has no newline");
    // stdin closed: a shutdown without an answer (CONTRACT §6.1).
    std::lock_guard<std::mutex> hold(g_lock);
    ExitProcess(0);
}
