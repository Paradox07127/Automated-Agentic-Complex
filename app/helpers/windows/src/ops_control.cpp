// control.listen and control.respond of CONTRACT §7.8, with the control.request event (§8): a named pipe whose DACL
// admits this user alone, local clients only, and a token file with the same DACL. Each connection carries one
// request of at most 64 KiB from a process of this user with the token; at most 4 connections read their request at
// once. The request goes to the main process without its token; control.respond writes the answer and closes it.
#define _CRT_RAND_S
#define NOMINMAX
#include <windows.h>
#include <sddl.h>
#include <stdlib.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cwchar>
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

constexpr size_t kMaxLineBytes = 65536;
constexpr int kMaxReading = 4;
constexpr ULONGLONG kIoMs = 1500;  // under control.respond's timeout_ms, so that a stuck client answers conn_gone
constexpr DWORD kPipeBuffer = 65536;
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\";

// A connection whose request went out and waits for control.respond; done is set once the answer is written.
struct Waiting {
    HANDLE pipe;
    HANDLE done;
};

std::atomic<bool> g_live{false};  // control.request events go out
// Held while reading or changing everything below.
std::mutex g_lock;
bool g_taken = false;  // a control.listen succeeded or is past its first check
std::wstring g_name, g_token_file;
std::string g_token;
std::vector<BYTE> g_user;                  // this process's TOKEN_USER
PSECURITY_DESCRIPTOR g_security = nullptr;  // this user only; kept for every pipe instance
HANDLE g_first = nullptr;                   // control.listen's instance until the accept thread takes it
HANDLE g_stop = nullptr;                    // set by control_stop
int g_reading = 0;
int64_t g_last_conn = 0;
std::map<int64_t, Waiting> g_waiting;

Outcome unavailable(std::string why) { return failure("endpoint_unavailable", std::move(why)); }

std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    int count = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(count > 0 ? count : 0), L'\0');
    if (count > 0) MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), count);
    return out;
}

// \\.\pipe\ and a name without a backslash, 256 characters in all (CreateNamedPipe's rules).
bool pipe_name(const std::wstring& name) {
    size_t prefix = std::wcslen(kPipePrefix);
    return name.size() > prefix && name.size() <= 256 && _wcsnicmp(name.c_str(), kPipePrefix, prefix) == 0 &&
           name.find(L'\\', prefix) == std::wstring::npos && name.find(L'\0') == std::wstring::npos;
}

// A drive-absolute file path: X:\ and a file name.
bool file_path(const std::wstring& path) {
    return path.size() > 3 && ((path[0] | 0x20) >= L'a' && (path[0] | 0x20) <= L'z') && path[1] == L':' &&
           path[2] == L'\\' && path.back() != L'\\' && path.find(L'\0') == std::wstring::npos;
}

// The TOKEN_USER of process's token; empty when it cannot be read.
std::vector<BYTE> token_user(HANDLE process) {
    std::vector<BYTE> user;
    HANDLE token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return user;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    user.resize(size);
    if (size == 0 || !GetTokenInformation(token, TokenUser, user.data(), size, &size)) user.clear();
    CloseHandle(token);
    return user;
}

PSID sid_of(const std::vector<BYTE>& user) {
    return reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid;
}

// A protected DACL with one ACE, user, with all access; nullptr when it cannot be made.
PSECURITY_DESCRIPTOR only_user(const std::vector<BYTE>& user) {
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(sid_of(user), &sid)) return nullptr;
    std::wstring sddl = std::wstring(L"D:P(A;;GA;;;") + sid + L")";
    LocalFree(sid);
    PSECURITY_DESCRIPTOR security = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &security, nullptr)) {
        return nullptr;
    }
    return security;
}

// INVALID_HANDLE_VALUE on failure, GetLastError telling why.
HANDLE make_instance(const std::wstring& name, PSECURITY_DESCRIPTOR security, bool first) {
    SECURITY_ATTRIBUTES attributes{sizeof attributes, security, FALSE};
    return CreateNamedPipeW(name.c_str(),
                            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
                            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                            PIPE_UNLIMITED_INSTANCES, kPipeBuffer, kPipeBuffer, 0, &attributes);
}

// 32 random bytes as lower-case hex; empty when rand_s fails.
std::string fresh_token() {
    std::string text;
    for (int k = 0; k < 8; ++k) {
        unsigned int word = 0;
        if (rand_s(&word) != 0) return {};
        char hex[9];
        std::snprintf(hex, sizeof hex, "%08x", word);
        text += hex;
    }
    return text;
}

// The token file made anew in its directory, which is made when missing; both get only this user's DACL when made.
bool write_token(const std::wstring& path, const std::string& token, PSECURITY_DESCRIPTOR security) {
    SECURITY_ATTRIBUTES attributes{sizeof attributes, security, FALSE};
    std::wstring dir = path.substr(0, path.rfind(L'\\'));
    if (dir.size() > 2 && !CreateDirectoryW(dir.c_str(), &attributes) && GetLastError() != ERROR_ALREADY_EXISTS) {
        return false;
    }
    // An existing file would keep its own DACL: CreateFile applies attributes only to a file it creates.
    DeleteFileW(path.c_str());
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD wrote = 0;
    bool ok = WriteFile(file, token.data(), static_cast<DWORD>(token.size()), &wrote, nullptr) && wrote == token.size();
    CloseHandle(file);
    if (!ok) DeleteFileW(path.c_str());
    return ok;
}

// One overlapped read or write that must finish by deadline (GetTickCount64); false on failure or the time running
// out, which cancels it.
bool transfer(HANDLE pipe, HANDLE event, bool write, void* data, DWORD size, ULONGLONG deadline, DWORD& moved) {
    OVERLAPPED io{};
    io.hEvent = event;
    ResetEvent(event);
    moved = 0;
    BOOL done = write ? WriteFile(pipe, data, size, nullptr, &io) : ReadFile(pipe, data, size, nullptr, &io);
    if (!done && GetLastError() != ERROR_IO_PENDING) return false;
    ULONGLONG now = GetTickCount64();
    DWORD wait = now < deadline ? static_cast<DWORD>(deadline - now) : 0;
    if (WaitForSingleObject(event, wait) != WAIT_OBJECT_0) CancelIoEx(pipe, &io);
    return GetOverlappedResult(pipe, &io, &moved, TRUE) != 0;
}

bool write_all(HANDLE pipe, HANDLE event, std::string bytes, ULONGLONG deadline) {
    size_t offset = 0;
    while (offset < bytes.size()) {
        DWORD chunk = static_cast<DWORD>(bytes.size() - offset < kPipeBuffer ? bytes.size() - offset : kPipeBuffer);
        DWORD wrote = 0;
        if (!transfer(pipe, event, true, bytes.data() + offset, chunk, deadline, wrote) || wrote == 0) return false;
        offset += wrote;
    }
    return true;
}

// One line of at most kMaxLineBytes before its newline, within kIoMs; false on a longer line, the time running out or
// the end of the stream.
bool read_line(HANDLE pipe, HANDLE event, std::string& line) {
    ULONGLONG deadline = GetTickCount64() + kIoMs;
    std::string data;
    char buffer[4096];
    for (;;) {
        size_t newline = data.find('\n');
        if (newline != std::string::npos) {
            if (newline > kMaxLineBytes) return false;
            line = data.substr(0, newline);
            return true;
        }
        if (data.size() > kMaxLineBytes) return false;
        DWORD got = 0;
        if (!transfer(pipe, event, false, buffer, sizeof buffer, deadline, got) || got == 0) return false;
        data.append(buffer, got);
    }
}

// The client is a process of this user.
bool same_user(HANDLE pipe, const std::vector<BYTE>& user) {
    ULONG pid = 0;
    if (!GetNamedPipeClientProcessId(pipe, &pid)) return false;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return false;
    std::vector<BYTE> theirs = token_user(process);
    CloseHandle(process);
    return !theirs.empty() && EqualSid(sid_of(theirs), sid_of(user));
}

// Equal bytes, in time that depends on the length only.
bool constant_time_equal(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    unsigned char diff = 0;
    for (size_t k = 0; k < a.size(); ++k) diff |= static_cast<unsigned char>(a[k] ^ b[k]);
    return diff == 0;
}

void stop_reading(HANDLE pipe, HANDLE event) {
    CloseHandle(pipe);
    CloseHandle(event);
    std::lock_guard<std::mutex> hold(g_lock);
    --g_reading;
}

// Until control.respond has answered conn or the client hangs up first; more bytes from the client are dropped.
void wait_answer(int64_t conn, HANDLE pipe, HANDLE done, HANDLE event) {
    for (;;) {
        OVERLAPPED io{};
        io.hEvent = event;
        ResetEvent(event);
        char scratch[512];
        DWORD got = 0;
        BOOL read = ReadFile(pipe, scratch, sizeof scratch, nullptr, &io);
        if (read || GetLastError() == ERROR_IO_PENDING) {
            HANDLE either[2] = {event, done};
            if (WaitForMultipleObjects(2, either, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
                CancelIoEx(pipe, &io);
                GetOverlappedResult(pipe, &io, &got, TRUE);
                break;
            }
            if (GetOverlappedResult(pipe, &io, &got, FALSE) && got > 0) continue;
        }
        // Hung up: control.respond answers conn_gone from now on, unless it is writing already.
        bool answering;
        {
            std::lock_guard<std::mutex> hold(g_lock);
            answering = g_waiting.erase(conn) == 0;
        }
        if (answering) WaitForSingleObject(done, INFINITE);
        break;
    }
    CloseHandle(pipe);
    CloseHandle(done);
    CloseHandle(event);
}

void serve(HANDLE pipe) {
    std::vector<BYTE> user;
    std::string token;
    {
        std::lock_guard<std::mutex> hold(g_lock);
        user = g_user;
        token = g_token;
    }
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!event) {
        CloseHandle(pipe);
        std::lock_guard<std::mutex> hold(g_lock);
        --g_reading;
        return;
    }
    std::string line;
    json::Value request;
    if (!same_user(pipe, user) || !read_line(pipe, event, line) || !json::parse(line, request) ||
        request.type != json::Type::Obj) {
        return stop_reading(pipe, event);
    }
    const json::Value* sent = request.get("token");
    if (!sent || sent->type != json::Type::Str || !constant_time_equal(sent->s, token)) {
        json::Value error = json::object();
        error.set("code", json::str("unauthorized"));
        error.set("message", json::str("the token is not valid"));
        json::Value refusal = json::object();
        const json::Value* id = request.get("id");
        refusal.set("id", id ? *id : json::null());
        refusal.set("error", std::move(error));
        write_all(pipe, event, json::dump(refusal) + "\n", GetTickCount64() + kIoMs);
        return stop_reading(pipe, event);
    }
    json::Value forwarded = json::object();
    for (size_t k = 0; k < request.keys.size(); ++k) {
        if (request.keys[k] != "token") forwarded.set(request.keys[k], request.values[k]);
    }
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    int64_t conn = 0;
    {
        // The slot is for reading: the main process bounds the requests it runs and lets desktop_cancel past them.
        std::lock_guard<std::mutex> hold(g_lock);
        --g_reading;
        if (done && g_live) {
            conn = ++g_last_conn;
            g_waiting[conn] = Waiting{pipe, done};
        }
    }
    if (conn == 0) {
        if (done) CloseHandle(done);
        CloseHandle(pipe);
        CloseHandle(event);
        return;
    }
    json::Value data = json::object();
    data.set("conn", json::integer(conn));
    data.set("request", std::move(forwarded));
    send_event("control.request", std::move(data), g_live);
    wait_answer(conn, pipe, done, event);
}

// A connected instance is served on its own thread, or closed when kMaxReading connections read already.
void admit(HANDLE pipe) {
    {
        std::lock_guard<std::mutex> hold(g_lock);
        if (!g_live || g_reading >= kMaxReading) {
            CloseHandle(pipe);
            return;
        }
        ++g_reading;
    }
    try {
        std::thread(serve, pipe).detach();
    } catch (const std::exception&) {
        CloseHandle(pipe);
        std::lock_guard<std::mutex> hold(g_lock);
        --g_reading;
    }
}

void accept_loop(HANDLE pipe, std::wstring name, PSECURITY_DESCRIPTOR security, HANDLE stop) {
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    while (event && pipe != INVALID_HANDLE_VALUE) {
        OVERLAPPED io{};
        io.hEvent = event;
        ResetEvent(event);
        bool connected = ConnectNamedPipe(pipe, &io) != 0;
        DWORD error = connected ? ERROR_SUCCESS : GetLastError();
        if (error == ERROR_IO_PENDING) {
            HANDLE either[2] = {event, stop};
            DWORD moved = 0;
            if (WaitForMultipleObjects(2, either, FALSE, INFINITE) != WAIT_OBJECT_0) {
                CancelIoEx(pipe, &io);
                GetOverlappedResult(pipe, &io, &moved, TRUE);
                break;
            }
            connected = GetOverlappedResult(pipe, &io, &moved, FALSE) != 0;
        } else if (error == ERROR_PIPE_CONNECTED) {
            connected = true;
        }
        // The next instance before this one is handed on: the name keeps a listening instance of this helper.
        HANDLE next = make_instance(name, security, false);
        if (next == INVALID_HANDLE_VALUE) {
            std::fprintf(stderr, "ac-helper: control.listen could not make another pipe instance (%lu)\n",
                         GetLastError());
            std::fflush(stderr);
        }
        if (connected) {
            admit(pipe);
        } else {
            CloseHandle(pipe);
        }
        pipe = next;
    }
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
    if (event) CloseHandle(event);
}

// control.listen's answer is out: connections are taken from now on, so control.request follows it.
void start_accepting() {
    std::lock_guard<std::mutex> hold(g_lock);
    if (!g_first) return;
    g_live = true;
    try {
        std::thread(accept_loop, g_first, g_name, g_security, g_stop).detach();
        g_first = nullptr;
    } catch (const std::exception&) {
        g_live = false;
        std::fprintf(stderr, "ac-helper: control.listen could not start its accept thread\n");
        std::fflush(stderr);
    }
}

Outcome listen(const std::wstring& name, const std::wstring& token_file) {
    if (!pipe_name(name)) return unavailable("the endpoint is not a name \\\\.\\pipe\\<name>");
    if (!file_path(token_file)) return unavailable("the token file needs a drive-absolute path");
    std::vector<BYTE> user = token_user(GetCurrentProcess());
    PSECURITY_DESCRIPTOR security = user.empty() ? nullptr : only_user(user);
    if (!security) return unavailable("no DACL of this user could be made");
    HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE pipe = stop ? make_instance(name, security, true) : INVALID_HANDLE_VALUE;
    if (pipe == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if (stop) CloseHandle(stop);
        LocalFree(security);
        if (error == ERROR_ACCESS_DENIED || error == ERROR_PIPE_BUSY) {
            return failure("already_running", "another process listens on the endpoint");
        }
        return unavailable("the pipe could not be made (" + std::to_string(error) + ")");
    }
    // After the pipe: a second listener must not replace the first one's token.
    std::string token = fresh_token();
    if (token.empty() || !write_token(token_file, token, security)) {
        CloseHandle(pipe);
        CloseHandle(stop);
        LocalFree(security);
        return unavailable("the token file could not be written");
    }
    if (!commit(*this_request())) {
        DeleteFileW(token_file.c_str());
        CloseHandle(pipe);
        CloseHandle(stop);
        LocalFree(security);
        return failure("cancelled", "the request was answered before the endpoint took effect");
    }
    std::lock_guard<std::mutex> hold(g_lock);
    g_name = name;
    g_token_file = token_file;
    g_token = token;
    g_user = std::move(user);
    g_security = security;
    g_first = pipe;
    g_stop = stop;
    return success(json::object());
}

}  // namespace

Outcome control_listen(const json::Value& params) {
    {
        std::lock_guard<std::mutex> hold(g_lock);
        if (g_taken) return failure("already_running", "this helper listens already");
        g_taken = true;
    }
    const std::string& endpoint = params.get("endpoint")->s;
    Outcome out = listen(wide(endpoint), wide(params.get("token_file")->s));
    if (!out.ok) {
        std::lock_guard<std::mutex> hold(g_lock);
        g_taken = false;
        return out;
    }
    out.result.set("endpoint", json::str(endpoint));
    out.answered = start_accepting;
    return out;
}

Outcome control_respond(const json::Value& params) {
    int64_t conn = params.get("conn")->i;
    Waiting found{};
    {
        std::lock_guard<std::mutex> hold(g_lock);
        auto it = g_waiting.find(conn);
        if (it == g_waiting.end()) {
            return failure("conn_gone", "connection " + std::to_string(conn) + " is closed or already answered");
        }
        found = it->second;
        g_waiting.erase(it);
    }
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    bool wrote = event && write_all(found.pipe, event, json::dump(*params.get("response")) + "\n",
                                    GetTickCount64() + kIoMs);
    if (event) CloseHandle(event);
    SetEvent(found.done);  // the connection's thread closes it
    if (!wrote) return failure("conn_gone", "connection " + std::to_string(conn) + " hung up");
    json::Value result = json::object();
    result.set("sent", json::boolean(true));
    return success(std::move(result));
}

void control_stop() {
    std::lock_guard<std::mutex> hold(g_lock);
    g_live = false;
    if (g_stop) SetEvent(g_stop);
    if (!g_token_file.empty()) DeleteFileW(g_token_file.c_str());
}
