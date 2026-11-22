// The C12 ops this helper implements with plain Win32 and COM: CONTRACT §7.2 (screens, windows), §7.9 (permissions),
// §7.10 (clipboard.read, text only) and §7.11 (apps.running, apps.installed, apps.activate, process.usage).
#define NOMINMAX
#include <windows.h>
#include <appmodel.h>
#include <audioclient.h>
#include <dwmapi.h>
#include <knownfolders.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include <psapi.h>
#include <shellscalingapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <tlhelp32.h>
#include <winver.h>

#include <cstdint>
#include <cwchar>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "json.h"
#include "ops.h"
#include "uia.h"
#include "win32.h"

namespace {

using namespace win32;

std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    int chars = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(chars > 0 ? chars : 0), L'\0');
    if (chars > 0) MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), chars);
    return out;
}

// A window the taskbar shows: visible, uncloaked, not the desktop, and unowned and not a tool window, or marked
// as an app window.
bool is_app_window(HWND hwnd) {
    if (!IsWindowVisible(hwnd) || is_cloaked(hwnd) || is_desktop(hwnd)) return false;
    LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if (ex & WS_EX_APPWINDOW) return true;
    return !GetWindow(hwnd, GW_OWNER) && !(ex & WS_EX_TOOLWINDOW);
}

std::set<DWORD> pids_with_app_windows() {
    std::set<DWORD> pids;
    EnumWindows([](HWND hwnd, LPARAM into) -> BOOL {
        if (is_app_window(hwnd)) reinterpret_cast<std::set<DWORD>*>(into)->insert(owner_pid(hwnd));
        return TRUE;
    }, reinterpret_cast<LPARAM>(&pids));
    return pids;
}

// The front-most app window of pid, or nullptr.
HWND app_window(DWORD pid) {
    std::pair<DWORD, HWND> search{pid, nullptr};
    EnumWindows([](HWND hwnd, LPARAM into) -> BOOL {
        auto* s = reinterpret_cast<std::pair<DWORD, HWND>*>(into);
        if (owner_pid(hwnd) != s->first || !is_app_window(hwnd)) return TRUE;
        s->second = hwnd;
        return FALSE;
    }, reinterpret_cast<LPARAM>(&search));
    return search.second;
}

DWORD current_session() {
    DWORD session = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), &session);
    return session;
}

// Every process in this helper's session: (pid, parent pid, executable name).
struct Process {
    DWORD pid, parent;
    std::wstring exe;
};

std::vector<Process> session_processes() {
    std::vector<Process> found;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return found;
    DWORD session = current_session();
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof entry;
    for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry)) {
        DWORD theirs = 0;
        if (!entry.th32ProcessID || !ProcessIdToSessionId(entry.th32ProcessID, &theirs) || theirs != session) continue;
        found.push_back({entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile});
    }
    CloseHandle(snapshot);
    return found;
}

// A process that exists; one this helper may not open still exists.
bool alive(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return GetLastError() == ERROR_ACCESS_DENIED;
    DWORD code = 0;
    bool running = GetExitCodeProcess(process, &code) && code == STILL_ACTIVE;
    CloseHandle(process);
    return running;
}

// The process's start in FILETIME ticks, or UINT64_MAX when it cannot be read.
uint64_t started(DWORD pid) {
    uint64_t at = UINT64_MAX;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return at;
    FILETIME created, exited, kernel, user;
    if (GetProcessTimes(process, &created, &exited, &kernel, &user)) at = ticks(created);
    CloseHandle(process);
    return at;
}

Outcome screens_list(const json::Value&) {
    json::Value screens = json::array();
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR monitor, HDC, LPRECT, LPARAM into) -> BOOL {
        MONITORINFO info{};
        info.cbSize = sizeof info;
        if (!GetMonitorInfoW(monitor, &info)) return TRUE;
        UINT dpi_x = 96, dpi_y = 96;
        if (FAILED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpi_x, &dpi_y))) dpi_x = 96;
        json::Value screen = json::object();
        screen.set("display_id", handle_id(monitor));
        screen.set("frame", rect(info.rcMonitor));
        screen.set("visible", rect(info.rcWork));
        screen.set("scale", json::number(dpi_x / 96.0));
        screen.set("primary", json::boolean((info.dwFlags & MONITORINFOF_PRIMARY) != 0));
        reinterpret_cast<json::Value*>(into)->push(std::move(screen));
        return TRUE;
    }, reinterpret_cast<LPARAM>(&screens));
    json::Value result = json::object();
    result.set("screens", std::move(screens));
    return success(std::move(result));
}

Outcome windows_list(const json::Value& params) {
    const json::Value* pid = params.get("pid");
    const json::Value* limit = params.get("limit");
    bool layer0 = flag(params, "layer0_only"), titles = flag(params, "include_titles");
    Apps apps;
    json::Value windows = json::array();
    for (const Window& w : screen_windows()) {
        if (limit && static_cast<int64_t>(windows.values.size()) >= limit->i) break;
        if ((pid && w.pid != pid->i) || (layer0 && w.layer != 0)) continue;
        windows.push(window_json(w, titles, apps));
    }
    json::Value result = json::object();
    result.set("windows", std::move(windows));
    return success(std::move(result));
}

Outcome windows_at_point(const json::Value& params) {
    const json::Value& point = *params.get("point");
    double x = point.get("x")->n, y = point.get("y")->n;
    std::set<int64_t> excluded;
    if (const json::Value* pids = params.get("exclude_pids")) {
        for (const json::Value& pid : pids->values) excluded.insert(pid.i);
    }
    bool layer0 = flag(params, "layer0_only");
    Apps apps;
    json::Value window = json::null();
    for (const Window& w : screen_windows()) {
        if (excluded.count(w.pid) || (layer0 && w.layer != 0)) continue;
        if (x >= w.bounds.left && x < w.bounds.right && y >= w.bounds.top && y < w.bounds.bottom) {
            window = window_json(w, flag(params, "include_titles"), apps);
            break;
        }
    }
    json::Value result = json::object();
    result.set("window", std::move(window));
    return success(std::move(result));
}

std::string format_name(UINT format) {
    static const std::map<UINT, const char*> standard = {
        {CF_TEXT, "CF_TEXT"}, {CF_BITMAP, "CF_BITMAP"}, {CF_METAFILEPICT, "CF_METAFILEPICT"}, {CF_SYLK, "CF_SYLK"},
        {CF_DIF, "CF_DIF"}, {CF_TIFF, "CF_TIFF"}, {CF_OEMTEXT, "CF_OEMTEXT"}, {CF_DIB, "CF_DIB"},
        {CF_PALETTE, "CF_PALETTE"}, {CF_PENDATA, "CF_PENDATA"}, {CF_RIFF, "CF_RIFF"}, {CF_WAVE, "CF_WAVE"},
        {CF_UNICODETEXT, "CF_UNICODETEXT"}, {CF_ENHMETAFILE, "CF_ENHMETAFILE"}, {CF_HDROP, "CF_HDROP"},
        {CF_LOCALE, "CF_LOCALE"}, {CF_DIBV5, "CF_DIBV5"}};
    auto found = standard.find(format);
    if (found != standard.end()) return found->second;
    wchar_t name[256] = {};
    int length = GetClipboardFormatNameW(format, name, 256);
    return length > 0 ? utf8(name, static_cast<size_t>(length)) : "#" + std::to_string(format);
}

// CONTRACT §7.10: monitors must not read a clipboard marked private.
bool clipboard_concealed() {
    UINT exclude = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
    if (exclude && IsClipboardFormatAvailable(exclude)) return true;
    UINT history = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
    if (!history || !IsClipboardFormatAvailable(history)) return false;
    HANDLE data = GetClipboardData(history);
    const void* value = data ? GlobalLock(data) : nullptr;
    if (!value) return false;
    bool refused = GlobalSize(data) >= sizeof(DWORD) && *static_cast<const DWORD*>(value) == 0;
    GlobalUnlock(data);
    return refused;
}

// At most max bytes of text, cut at a character boundary.
std::string cut_utf8(const std::string& text, size_t max) {
    if (text.size() <= max) return text;
    while (max > 0 && (static_cast<unsigned char>(text[max]) & 0xC0) == 0x80) --max;
    return text.substr(0, max);
}

// The Windows clipboard holds one item; it carries text when CF_UNICODETEXT is on it.
Outcome clipboard_read(const json::Value& params) {
    const json::Value* max_text = params.get("max_text_bytes");
    bool open = false;
    for (int attempt = 0; attempt < 10 && !(open = OpenClipboard(nullptr) != 0); ++attempt) Sleep(20);
    if (!open) return failure("internal", "another program holds the clipboard open", true);
    json::Value items = json::array();
    bool concealed = clipboard_concealed(), truncated = false;
    if (!concealed) {
        json::Value types = json::array();
        for (UINT format = EnumClipboardFormats(0); format; format = EnumClipboardFormats(format)) {
            types.push(json::str(format_name(format)));
        }
        if (!types.values.empty()) {
            json::Value item = json::object();
            item.set("types", std::move(types));
            HANDLE data = IsClipboardFormatAvailable(CF_UNICODETEXT) ? GetClipboardData(CF_UNICODETEXT) : nullptr;
            const wchar_t* chars = data ? static_cast<const wchar_t*>(GlobalLock(data)) : nullptr;
            if (chars) {
                std::string text = utf8(chars, wcsnlen(chars, GlobalSize(data) / sizeof(wchar_t)));
                GlobalUnlock(data);
                if (max_text && text.size() > static_cast<uint64_t>(max_text->i)) {
                    text = cut_utf8(text, static_cast<size_t>(max_text->i));
                    truncated = true;
                }
                item.set("text", json::str(std::move(text)));
            }
            items.push(std::move(item));
        }
    }
    CloseClipboard();
    json::Value result = json::object();
    result.set("items", std::move(items));
    result.set("concealed", json::boolean(concealed));
    result.set("truncated", json::boolean(truncated));
    return success(std::move(result));
}

// The processes of this helper's session; regular ones have a window the taskbar shows.
Outcome apps_running(const json::Value& params) {
    bool regular_only = flag(params, "regular_only");
    std::set<DWORD> regular = pids_with_app_windows();
    Apps apps;
    json::Value list = json::array();
    for (const Process& process : session_processes()) {
        bool is_regular = regular.count(process.pid) > 0;
        if (regular_only && !is_regular) continue;
        const App& app = apps.get(process.pid, process.exe);
        json::Value entry = json::object();
        entry.set("pid", json::integer(process.pid));
        entry.set("name", app.name);
        entry.set("app_id", app.app_id);
        entry.set("path", app.path);
        entry.set("launched_at", app.launched_at);
        entry.set("regular", json::boolean(is_regular));
        list.push(std::move(entry));
    }
    json::Value result = json::object();
    result.set("apps", std::move(list));
    return success(std::move(result));
}

bool has_extension(const std::wstring& path, const wchar_t* extension) {
    std::wstring name = lower(base_name(path));
    size_t length = std::wcslen(extension);
    return name.size() > length && name.compare(name.size() - length, length, extension) == 0;
}

// The .lnk files under dir and its subfolders; folders that are links are not followed.
void find_shortcuts(const std::wstring& dir, std::vector<std::wstring>& into) {
    WIN32_FIND_DATAW entry;
    HANDLE find = FindFirstFileExW((dir + L"\\*").c_str(), FindExInfoBasic, &entry, FindExSearchNameMatch, nullptr,
                                   FIND_FIRST_EX_LARGE_FETCH);
    if (find == INVALID_HANDLE_VALUE) return;
    do {
        std::wstring name = entry.cFileName, full = dir + L"\\" + entry.cFileName;
        if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (name != L"." && name != L".." && !(entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
                find_shortcuts(full, into);
            }
        } else if (has_extension(name, L".lnk")) {
            into.push_back(full);
        }
    } while (FindNextFileW(find, &entry));
    FindClose(find);
}

std::wstring known_folder(const KNOWNFOLDERID& id) {
    PWSTR raw = nullptr;
    std::wstring path;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &raw))) path = raw;
    CoTaskMemFree(raw);
    return path;
}

// The file a shortcut points at, or empty: shortcuts to packaged apps and advertised installer entries have none.
// Not IShellLink::Resolve, which may search the disk or show a window.
std::wstring shortcut_target(IShellLinkW* link, IPersistFile* file, const std::wstring& shortcut) {
    wchar_t target[MAX_PATH] = {};
    if (FAILED(file->Load(shortcut.c_str(), STGM_READ)) || link->GetPath(target, MAX_PATH, nullptr, 0) != S_OK) {
        return {};
    }
    return target;
}

// CONTRACT §7.11: the shortcuts of the current user's and all users' Start menu. The name is that of the exe a
// shortcut starts; a shortcut that starts no exe is named by its own file name.
Outcome apps_installed(const json::Value&) {
    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IShellLinkW* link = nullptr;
    IPersistFile* file = nullptr;
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) ||
        FAILED(link->QueryInterface(IID_PPV_ARGS(&file)))) {
        if (link) link->Release();
        if (SUCCEEDED(com)) CoUninitialize();
        return failure("internal", "cannot create a shell link object");
    }
    std::vector<std::wstring> shortcuts;
    for (const KNOWNFOLDERID* folder : {&FOLDERID_StartMenu, &FOLDERID_CommonStartMenu}) {
        std::wstring dir = known_folder(*folder);
        if (!dir.empty()) find_shortcuts(dir, shortcuts);
    }
    json::Value apps = json::array();
    for (const std::wstring& shortcut : shortcuts) {
        std::wstring target = shortcut_target(link, file, shortcut), name;
        if (has_extension(target, L".exe")) {
            name = file_description(target);
            if (name.empty()) name = stem(base_name(target));
        }
        if (name.empty()) name = stem(base_name(shortcut));
        json::Value entry = json::object();
        entry.set("path", json::str(utf8(shortcut)));
        entry.set("name", json::str(utf8(name)));
        apps.push(std::move(entry));
    }
    file->Release();
    link->Release();
    if (SUCCEEDED(com)) CoUninitialize();
    json::Value result = json::object();
    result.set("apps", std::move(apps));
    return success(std::move(result));
}

// The process in this session whose app id is app_id, preferring one with an app window; 0 when none runs.
DWORD running_app(const std::string& app_id) {
    std::wstring wanted = wide(app_id);
    DWORD fallback = 0;
    for (const Process& process : session_processes()) {
        HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process.pid);
        std::wstring id = app_id_of(handle, process.exe);
        if (handle) CloseHandle(handle);
        if (CompareStringOrdinal(id.c_str(), -1, wanted.c_str(), -1, TRUE) != CSTR_EQUAL) continue;
        if (app_window(process.pid)) return process.pid;
        if (!fallback) fallback = process.pid;
    }
    return fallback;
}

// The nearest ancestor of pid with an app window, or 0. Ancestors started after their child are a reused pid.
DWORD app_ancestor(DWORD pid, HWND& window) {
    std::map<DWORD, DWORD> parents;
    for (const Process& process : session_processes()) parents[process.pid] = process.parent;
    uint64_t born = started(pid);
    for (int step = 0; step < 64; ++step) {
        auto up = parents.find(pid);
        if (up == parents.end() || !up->second) return 0;
        uint64_t parent_born = started(up->second);
        if (parent_born == UINT64_MAX || parent_born > born) return 0;
        pid = up->second;
        born = parent_born;
        if ((window = app_window(pid)) != nullptr) return pid;
    }
    return 0;
}

// Brings the app's front-most window forward; the foreground lock may refuse, which is activated: false.
Outcome apps_activate(const json::Value& params) {
    DWORD pid = 0;
    if (const json::Value* given = params.get("pid")) {
        if (given->i > static_cast<int64_t>(MAXDWORD) || !alive(static_cast<DWORD>(given->i))) {
            return failure("process_gone", "no process has that pid");
        }
        pid = static_cast<DWORD>(given->i);
    } else {
        pid = running_app(params.get("app_id")->s);
    }
    HWND window = pid ? app_window(pid) : nullptr;
    if (!window && pid && flag(params, "ancestors")) pid = app_ancestor(pid, window);
    json::Value result = json::object();
    if (!window) {
        result.set("activated", json::boolean(false));
        result.set("pid", json::null());
        return success(std::move(result));
    }
    if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
    bool activated = SetForegroundWindow(window) && GetForegroundWindow() == window;
    result.set("activated", json::boolean(activated));
    result.set("pid", json::integer(pid));
    return success(std::move(result));
}

// Processes that are gone, or that this helper may not open, are left out.
Outcome process_usage(const json::Value& params) {
    json::Value usage = json::array();
    std::set<int64_t> seen;
    for (const json::Value& pid : params.get("pids")->values) {
        if (pid.i > static_cast<int64_t>(MAXDWORD) || !seen.insert(pid.i).second) continue;
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid.i));
        if (!process) continue;
        DWORD code = 0;
        FILETIME created, exited, kernel, user;
        PROCESS_MEMORY_COUNTERS memory{};
        if (GetExitCodeProcess(process, &code) && code == STILL_ACTIVE &&
            GetProcessTimes(process, &created, &exited, &kernel, &user) &&
            GetProcessMemoryInfo(process, &memory, sizeof memory)) {
            json::Value entry = json::object();
            entry.set("pid", json::integer(pid.i));
            entry.set("cpu_time_ns", json::integer(static_cast<int64_t>((ticks(kernel) + ticks(user)) * 100)));
            entry.set("resident_bytes", json::integer(static_cast<int64_t>(memory.WorkingSetSize)));
            usage.push(std::move(entry));
        }
        CloseHandle(process);
    }
    json::Value result = json::object();
    result.set("usage", std::move(usage));
    return success(std::move(result));
}

bool registry_denies(HKEY root, const wchar_t* key) {
    wchar_t value[16] = {};
    DWORD size = sizeof value;
    if (RegGetValueW(root, key, L"Value", RRF_RT_REG_SZ, nullptr, value, &size) != ERROR_SUCCESS) return false;
    return std::wcscmp(value, L"Deny") == 0;
}

// The microphone is denied when the device switch, the user's switch or the desktop-apps switch is off.
bool microphone_denied() {
    const wchar_t* microphone =
        L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
    const wchar_t* desktop_apps =
        L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged";
    return registry_denies(HKEY_LOCAL_MACHINE, microphone) || registry_denies(HKEY_CURRENT_USER, microphone) ||
           registry_denies(HKEY_CURRENT_USER, desktop_apps);
}

// CONTRACT §7.9: Windows has no switch for the other four.
Outcome permissions_status(const json::Value&) {
    json::Value result = json::object();
    result.set("accessibility", json::str("notApplicable"));
    result.set("screenRecording", json::str("notApplicable"));
    result.set("microphone", json::str(microphone_denied() ? "denied" : "granted"));
    result.set("automation", json::str("notApplicable"));
    result.set("inputMonitoring", json::str("notApplicable"));
    return success(std::move(result));
}

// Starts and stops a shared-mode capture on the default microphone; without a device or access it does nothing.
void open_microphone_once() {
    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IMMDeviceEnumerator* devices = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* client = nullptr;
    WAVEFORMATEX* format = nullptr;
    const REFERENCE_TIME one_second = 10000000;  // in 100 ns
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices))) &&
        SUCCEEDED(devices->GetDefaultAudioEndpoint(eCapture, eConsole, &device)) &&
        SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client))) &&
        SUCCEEDED(client->GetMixFormat(&format)) &&
        SUCCEEDED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, one_second, 0, format, nullptr)) &&
        SUCCEEDED(client->Start())) {
        client->Stop();
    }
    CoTaskMemFree(format);
    if (client) client->Release();
    if (device) device->Release();
    if (devices) devices->Release();
    if (SUCCEEDED(com)) CoUninitialize();
}

// CONTRACT §7.9: the other four answer notApplicable at once. Opening the microphone lets a system with a per-app
// switch show its first-use prompt; the state is read after that.
Outcome permissions_request(const json::Value& params) {
    std::string state = "notApplicable";
    if (params.get("kind")->s == "microphone") {
        open_microphone_once();
        state = microphone_denied() ? "denied" : "granted";
    }
    json::Value result = json::object();
    result.set("state", json::str(state));
    return success(std::move(result));
}

}  // namespace

Handler find_handler(const std::string& name) {
    static const std::map<std::string, Handler> handlers = {
        {"screens.list", screens_list},
        {"windows.list", windows_list},
        {"windows.at_point", windows_at_point},
        {"clipboard.read", clipboard_read},
        {"apps.running", apps_running},
        {"apps.installed", apps_installed},
        {"apps.activate", apps_activate},
        {"process.usage", process_usage},
        {"permissions.status", permissions_status},
        {"permissions.request", permissions_request},
        {"workspace.watch", workspace_watch},
        {"attention.sample", attention_sample},
        {"presence.watch", presence_watch},
        {"browser.front_tab", browser_front_tab},
        {"input.modifiers", input_modifiers},
        {"input.watch", input_watch},
        {"input.actions", input_actions},
        {"capture.window", capture_window},
        {"capture.ambient", capture_ambient},
        {"ocr.languages", ocr_languages},
        {"ocr.recognize", ocr_recognize},
        {"ax.focused", ax_focused},
        {"ax.dialog_buttons", ax_dialog_buttons},
        {"ax.overlays", ax_overlays},
        {"ax.hit_chain", ax_hit_chain},
        {"ax.window_text", ax_window_text},
        {"ax.window_tree", ax_window_tree},
        {"ax.selected_text", ax_selected_text},
        {"ax.watch", ax_watch},
        {"control.observe", control_observe},
        {"control.act", control_act},
        {"control.read", control_read},
        {"control.listen", control_listen},
        {"control.respond", control_respond},
        {"speech.locales", speech_locales},
        {"mic.start", mic_start},
        {"mic.stop", mic_stop},
        {"ptt.register", ptt_register},
        {"ptt.unregister", ptt_unregister},
    };
    auto found = handlers.find(name);
    return found == handlers.end() ? nullptr : found->second;
}

const std::vector<const char*>& event_names() {
    static const std::vector<const char*> names = {"workspace.changed", "presence.edge", "input.activity",
                                                   "input.action", "ax.notification", "control.request", "ptt.down",
                                                   "ptt.up", "mic.level", "speech.partial", "speech.download"};
    return names;
}
