// Win32 helpers that more than one ops file uses: text conversion, process names and app ids (CONTRACT §2.9,
// §7.11), and the on-screen window list of §7.2.
#pragma once

#define NOMINMAX
#include <windows.h>
#include <appmodel.h>
#include <dwmapi.h>
#include <winver.h>

#include <cstdint>
#include <cwchar>
#include <map>
#include <string>
#include <vector>

#include "json.h"

namespace win32 {

inline std::string utf8(const wchar_t* text, size_t length) {
    if (length == 0) return {};
    int bytes = WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(bytes > 0 ? bytes : 0), '\0');
    if (bytes > 0) WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(length), out.data(), bytes, nullptr, nullptr);
    return out;
}

inline std::string utf8(const std::wstring& text) { return utf8(text.data(), text.size()); }

inline json::Value rect(const RECT& r) {
    json::Value v = json::object();
    v.set("x", json::integer(r.left));
    v.set("y", json::integer(r.top));
    v.set("width", json::integer(r.right - r.left));
    v.set("height", json::integer(r.bottom - r.top));
    return v;
}

inline bool flag(const json::Value& params, const char* key) {
    const json::Value* v = params.get(key);
    return v && v->b;
}

inline json::Value handle_id(const void* handle) {
    return json::integer(static_cast<int64_t>(reinterpret_cast<uintptr_t>(handle)));
}

inline uint64_t ticks(const FILETIME& t) {
    return (static_cast<uint64_t>(t.dwHighDateTime) << 32) | t.dwLowDateTime;
}

// FILETIME counts 100 ns from 1601-01-01.
inline double unix_seconds(const FILETIME& t) {
    return (static_cast<double>(ticks(t)) - 116444736000000000.0) / 1e7;
}

inline std::wstring base_name(const std::wstring& path) {
    size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? path : path.substr(slash + 1);
}

inline std::wstring stem(const std::wstring& name) {
    size_t dot = name.find_last_of(L'.');
    return dot == std::wstring::npos || dot == 0 ? name : name.substr(0, dot);
}

inline std::wstring lower(std::wstring text) {
    if (!text.empty()) CharLowerBuffW(text.data(), static_cast<DWORD>(text.size()));
    return text;
}

inline std::wstring image_path(HANDLE process) {
    std::wstring path(32768, L'\0');
    DWORD size = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process, 0, path.data(), &size)) return {};
    path.resize(size);
    return path;
}

// The AUMID of a packaged app's process; empty for other processes.
inline std::wstring package_app_id(HANDLE process) {
    UINT32 length = 0;
    if (GetApplicationUserModelId(process, &length, nullptr) != ERROR_INSUFFICIENT_BUFFER) return {};
    std::wstring id(length, L'\0');
    if (GetApplicationUserModelId(process, &length, id.data()) != ERROR_SUCCESS) return {};
    id.resize(wcsnlen(id.c_str(), id.size()));
    return id;
}

inline std::wstring file_description(const std::wstring& path) {
    DWORD ignored = 0;
    DWORD size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (!size) return {};
    std::vector<BYTE> data(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return {};
    struct Language { WORD language, code_page; };
    Language* languages = nullptr;
    UINT bytes = 0;
    if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&languages), &bytes) ||
        bytes < sizeof(Language)) {
        return {};
    }
    wchar_t key[64];
    swprintf(key, 64, L"\\StringFileInfo\\%04x%04x\\FileDescription", languages[0].language, languages[0].code_page);
    wchar_t* text = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(data.data(), key, reinterpret_cast<void**>(&text), &length) || !length) return {};
    std::wstring description(text, wcsnlen(text, length));
    size_t last = description.find_last_not_of(L' ');
    return last == std::wstring::npos ? std::wstring() : description.substr(0, last + 1);
}

// CONTRACT §2.9: the AUMID of a packaged app, else the lower-case executable name.
inline std::wstring app_id_of(HANDLE process, const std::wstring& exe) {
    std::wstring id = process ? package_app_id(process) : std::wstring();
    return id.empty() ? lower(exe) : id;
}

struct App {
    json::Value name, app_id, path, launched_at;
};

// Names, app ids and paths of processes, each looked up once per op.
class Apps {
public:
    // exe: the executable name when the caller has it (a process this helper may not open still has one).
    const App& get(DWORD pid, const std::wstring& exe = {}) {
        auto found = apps_.find(pid);
        if (found != apps_.end()) return found->second;
        return apps_[pid] = look_up(pid, exe);
    }

private:
    App look_up(DWORD pid, std::wstring exe) {
        App app;
        std::wstring path, id;
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (process) {
            path = image_path(process);
            FILETIME created, exited, kernel, user;
            if (GetProcessTimes(process, &created, &exited, &kernel, &user)) {
                app.launched_at = json::number(unix_seconds(created));
            }
        }
        if (!path.empty()) {
            exe = base_name(path);
            app.path = json::str(utf8(path));
        }
        if (process || !exe.empty()) id = app_id_of(process, exe);
        if (process) CloseHandle(process);
        if (!id.empty()) app.app_id = json::str(utf8(id));
        std::wstring name = path.empty() ? std::wstring() : description(path);
        if (name.empty()) name = stem(exe);
        if (!name.empty()) app.name = json::str(utf8(name));
        return app;
    }

    std::wstring description(const std::wstring& path) {
        auto found = descriptions_.find(path);
        if (found != descriptions_.end()) return found->second;
        return descriptions_[path] = file_description(path);
    }

    std::map<DWORD, App> apps_;
    std::map<std::wstring, std::wstring> descriptions_;
};

inline bool is_cloaked(HWND hwnd) {
    DWORD cloaked = 0;
    return SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof cloaked)) && cloaked;
}

// The desktop's own windows (wallpaper and icons).
inline bool is_desktop(HWND hwnd) {
    wchar_t name[32] = {};
    GetClassNameW(hwnd, name, 32);
    return std::wcscmp(name, L"Progman") == 0 || std::wcscmp(name, L"WorkerW") == 0;
}

inline DWORD owner_pid(HWND hwnd) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    return pid;
}

struct Window {
    HWND hwnd;
    DWORD pid;
    RECT bounds;
    int layer;
    double alpha;
};

// CONTRACT §7.2: visible, uncloaked top-level windows that are neither minimized nor the desktop, front to back.
inline std::vector<Window> screen_windows() {
    std::vector<Window> found;
    EnumWindows([](HWND hwnd, LPARAM into) -> BOOL {
        if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || is_cloaked(hwnd) || is_desktop(hwnd)) return TRUE;
        DWORD pid = owner_pid(hwnd);
        RECT r{};
        if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof r))) GetWindowRect(hwnd, &r);
        if (!pid || r.right <= r.left || r.bottom <= r.top) return TRUE;
        LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        double alpha = 1;
        BYTE level = 255;
        DWORD flags = 0;
        if ((ex & WS_EX_LAYERED) && GetLayeredWindowAttributes(hwnd, nullptr, &level, &flags) && (flags & LWA_ALPHA)) {
            alpha = level / 255.0;
        }
        reinterpret_cast<std::vector<Window>*>(into)->push_back({hwnd, pid, r, (ex & WS_EX_TOPMOST) ? 1 : 0, alpha});
        return TRUE;
    }, reinterpret_cast<LPARAM>(&found));
    return found;
}

inline json::Value window_json(const Window& w, bool titles, Apps& apps) {
    json::Value v = json::object();
    v.set("window_id", handle_id(w.hwnd));
    v.set("pid", json::integer(w.pid));
    v.set("bounds", rect(w.bounds));
    v.set("layer", json::integer(w.layer));
    v.set("alpha", json::number(w.alpha));
    if (titles) {
        // GetWindowTextW reads another process's caption without sending it a message, so a hung window cannot
        // block this.
        wchar_t title[1024] = {};
        int length = GetWindowTextW(w.hwnd, title, 1024);
        v.set("title", json::str(utf8(title, length > 0 ? static_cast<size_t>(length) : 0)));
        const App& app = apps.get(w.pid);
        v.set("app_name", app.name);
        v.set("app_id", app.app_id);
    }
    return v;
}

}  // namespace win32
