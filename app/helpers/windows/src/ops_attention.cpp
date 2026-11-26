// The attention ops (attention.sample, presence.watch, input.modifiers, input.watch) and
// workspace.watch, with their events. One hidden window on its own thread receives the session, power,
// display, foreground and Raw Input notifications of all three watches, and the actions of input.actions (uia.cpp).
#define NOMINMAX
#include <windows.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include <pdh.h>
#include <pdhmsg.h>
#include <shobjidl.h>
#include <wtsapi32.h>

#include <algorithm>
#include <atomic>
#include <bitset>
#include <cstdint>
#include <cstring>
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
#include "uia.h"
#include "win32.h"

namespace {

using namespace win32;

// GUID_CONSOLE_DISPLAY_STATE, spelled out so that no library has to define it.
constexpr GUID kConsoleDisplayState = {0x6fe69556, 0x704a, 0x47a0, {0x8f, 0x24, 0xc2, 0x8d, 0x93, 0x6f, 0xda, 0x47}};
constexpr uint64_t kActivityMs = 100;  // one key or scroll input.activity per 100 ms

std::atomic<bool> g_workspace{false}, g_presence{false}, g_input{false};  // each watch is on
std::atomic<bool> g_started{false};   // the watch window exists
std::atomic<bool> g_counting{false};  // Raw Input is registered to it
std::atomic<DWORD> g_front_pid{0};    // the front app workspace.changed last reported

// Counts since the helper started and the tick of the last input of each kind; never which key.
std::atomic<uint64_t> g_keys{0}, g_left_clicks{0}, g_right_clicks{0}, g_scrolls{0}, g_moves{0};
std::atomic<uint64_t> g_last_key{0}, g_last_pointer{0}, g_last_scroll{0}, g_last_click{0};

// Watch thread only.
uint64_t g_key_sent = 0, g_scroll_sent = 0;
bool g_display_off = false;
GUID g_desktop = GUID_NULL;
IVirtualDesktopManager* g_desktops = nullptr;

DWORD front_pid() {
    HWND front = GetForegroundWindow();
    return front ? owner_pid(front) : 0;
}

void edge(const char* name) {
    json::Value data = json::object();
    data.set("edge", json::str(name));
    send_event("presence.edge", std::move(data), g_presence);
}

void workspace_changed(const char* reason, DWORD pid) {
    json::Value data = json::object();
    data.set("reason", json::str(reason));
    data.set("front_pid", pid ? json::integer(pid) : json::null());
    send_event("workspace.changed", std::move(data), g_workspace);
}

// sent: the tick of the last event of a throttled kind, else nullptr.
void activity(const char* kind, uint64_t* sent, uint64_t now) {
    if (!g_input) return;
    if (sent) {
        if (now - *sent < kActivityMs) return;
        *sent = now;
    }
    json::Value data = json::object();
    data.set("kind", json::str(kind));
    send_event("input.activity", std::move(data), g_input);
}

// input.actions' view of the keyboard, watch thread only: the keys down, to tell a press from its auto-repeat, and the
// modifiers held.
std::bitset<256> g_down;
enum : unsigned { kLeftCtrl = 1, kRightCtrl = 2, kLeftAlt = 4, kRightAlt = 8, kLeftShift = 16, kRightShift = 32,
                  kWin = 64 };
unsigned g_modifiers = 0;

// The name of a shortcut's main key: the unmodified character on the foreground window's layout, else
// key<virtual key code>.
std::string key_name(unsigned vkey) {
    switch (vkey) {
    case VK_RETURN: return "return";
    case VK_TAB: return "tab";
    case VK_SPACE: return "space";
    case VK_BACK: return "delete";
    case VK_DELETE: return "forward_delete";
    case VK_ESCAPE: return "escape";
    case VK_LEFT: return "left";
    case VK_RIGHT: return "right";
    case VK_UP: return "up";
    case VK_DOWN: return "down";
    }
    HWND front = GetForegroundWindow();
    HKL layout = GetKeyboardLayout(front ? GetWindowThreadProcessId(front, nullptr) : 0);
    // The top bit marks a dead key.
    wchar_t c = static_cast<wchar_t>(MapVirtualKeyExW(vkey, MAPVK_VK_TO_CHAR, layout) & 0x7FFFFFFF);
    if (c <= L' ' || c == 0x7F || (c >= 0x80 && c < 0xA0) || (c >= 0xD800 && c <= 0xDFFF)) {
        return "key" + std::to_string(vkey);
    }
    CharLowerBuffW(&c, 1);
    return utf8(&c, 1);
}

// A shortcut (with Ctrl, Alt or the Windows key) or a submit (Return or keypad Enter without them or Shift) to
// input.actions; no other key's character is read. A synthetic key (SendInput: no device) is no action, but its
// modifiers count as held.
void key_action(const RAWKEYBOARD& key, bool synthetic) {
    unsigned vkey = key.VKey;
    if (vkey == 0 || vkey >= 255) return;
    bool up = (key.Flags & RI_KEY_BREAK) != 0, right = (key.Flags & RI_KEY_E0) != 0;
    bool repeat = !up && g_down[vkey];
    g_down[vkey] = !up;
    unsigned bit = 0;
    if (vkey == VK_CONTROL) bit = right ? kRightCtrl : kLeftCtrl;
    else if (vkey == VK_MENU) bit = right ? kRightAlt : kLeftAlt;
    else if (vkey == VK_SHIFT) bit = key.MakeCode == 0x36 ? kRightShift : kLeftShift;
    else if (vkey == VK_LWIN || vkey == VK_RWIN) bit = kWin;
    if (bit) {
        g_modifiers = up ? g_modifiers & ~bit : g_modifiers | bit;
        return;
    }
    if (up || repeat || synthetic || !uia::actions_on()) return;
    // AltGr sends a left Ctrl with the right Alt: that Ctrl is no modifier of its own.
    bool ctrl = (g_modifiers & kRightCtrl) || ((g_modifiers & kLeftCtrl) && !(g_modifiers & kRightAlt));
    bool alt = (g_modifiers & (kLeftAlt | kRightAlt)) != 0, shift = (g_modifiers & (kLeftShift | kRightShift)) != 0;
    bool win = (g_modifiers & kWin) != 0;
    HWND front = GetForegroundWindow();
    DWORD pid = front ? owner_pid(front) : 0;
    if (!pid) return;
    if (!ctrl && !alt && !win) {
        if (vkey == VK_RETURN && !shift) uia::key_action(pid, "submit", "return");
        return;
    }
    std::string keys;
    for (auto held : {std::make_pair(ctrl, "ctrl"), std::make_pair(alt, "alt"), std::make_pair(shift, "shift"),
                      std::make_pair(win, "cmd")}) {
        if (held.first) keys += std::string(held.second) + "+";
    }
    uia::key_action(pid, "shortcut", keys + key_name(vkey));
}

// Counts only whether a key went down, never which one; the push-to-talk key is ops_voice.cpp's and the actions are
// key_action's. Windows sends no mouse_up.
void raw_input(HRAWINPUT handle) {
    RAWINPUT raw{};
    UINT size = sizeof raw;
    if (GetRawInputData(handle, RID_INPUT, &raw, &size, sizeof(RAWINPUTHEADER)) == static_cast<UINT>(-1)) return;
    uint64_t now = GetTickCount64();
    bool synthetic = raw.header.hDevice == nullptr;
    if (raw.header.dwType == RIM_TYPEKEYBOARD) {
        ptt_key(raw.data.keyboard.VKey, raw.data.keyboard.MakeCode, raw.data.keyboard.Flags);
        key_action(raw.data.keyboard, synthetic);
        if (raw.data.keyboard.Flags & RI_KEY_BREAK) return;
        ++g_keys;
        g_last_key = now;
        activity("key", &g_key_sent, now);
        return;
    }
    if (raw.header.dwType != RIM_TYPEMOUSE) return;
    const RAWMOUSE& mouse = raw.data.mouse;
    USHORT buttons = mouse.usButtonFlags;
    // An absolute device (a pen, a remote session) repeats its position with every button change.
    bool moved = (mouse.usFlags & MOUSE_MOVE_ABSOLUTE) ? buttons == 0 : (mouse.lLastX != 0 || mouse.lLastY != 0);
    if (moved) {
        ++g_moves;
        g_last_pointer = now;
    }
    if (buttons & RI_MOUSE_LEFT_BUTTON_DOWN) ++g_left_clicks;
    if (buttons & RI_MOUSE_RIGHT_BUTTON_DOWN) ++g_right_clicks;
    if (buttons & (RI_MOUSE_LEFT_BUTTON_DOWN | RI_MOUSE_RIGHT_BUTTON_DOWN | RI_MOUSE_MIDDLE_BUTTON_DOWN |
                   RI_MOUSE_BUTTON_4_DOWN | RI_MOUSE_BUTTON_5_DOWN)) {
        g_last_click = now;
        activity("mouse_down", nullptr, now);
    }
    if (buttons & (RI_MOUSE_WHEEL | RI_MOUSE_HWHEEL)) {
        ++g_scrolls;
        g_last_scroll = now;
        activity("scroll", &g_scroll_sent, now);
    }
    // input.actions: Raw Input has no position, so the cursor's, read as the message is handled.
    POINT at{};
    if ((buttons & (RI_MOUSE_LEFT_BUTTON_UP | RI_MOUSE_RIGHT_BUTTON_DOWN)) && !synthetic && uia::actions_on() &&
        GetCursorPos(&at)) {
        if (buttons & RI_MOUSE_LEFT_BUTTON_UP) uia::click_action(at, false);
        if (buttons & RI_MOUSE_RIGHT_BUTTON_DOWN) uia::click_action(at, true);
    }
}

// The display's on and off; dimmed counts as on. Registering sends the current state, which is no edge.
void display_state(const POWERBROADCAST_SETTING& setting) {
    if (setting.PowerSetting != kConsoleDisplayState || setting.DataLength < sizeof(DWORD)) return;
    DWORD state = 0;
    std::memcpy(&state, setting.Data, sizeof state);
    bool off = state == 0;
    if (off != g_display_off) edge(off ? "display_sleep" : "display_wake");
    g_display_off = off;
}

// EVENT_SYSTEM_FOREGROUND also reports windows that did not get the foreground, so GetForegroundWindow
// must agree. A new virtual desktop shows as the front window's desktop changing.
void CALLBACK foreground(HWINEVENTHOOK, DWORD, HWND hwnd, LONG, LONG, DWORD, DWORD) {
    HWND front = GetForegroundWindow();
    if (!front || front != hwnd) return;
    DWORD pid = owner_pid(front);
    GUID desktop = GUID_NULL;
    if (g_desktops && SUCCEEDED(g_desktops->GetWindowDesktopId(front, &desktop)) && desktop != GUID_NULL) {
        bool moved = g_desktop != GUID_NULL && desktop != g_desktop;
        g_desktop = desktop;
        if (moved) workspace_changed("space", pid);
    }
    if (g_front_pid.exchange(pid) != pid) workspace_changed("front_app", pid);
}

LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case WM_INPUT:
        raw_input(reinterpret_cast<HRAWINPUT>(lparam));
        break;  // DefWindowProc frees the input
    case WM_WTSSESSION_CHANGE:
        if (wparam == WTS_SESSION_LOCK) edge("lock");
        if (wparam == WTS_SESSION_UNLOCK) edge("unlock");
        return 0;
    case WM_POWERBROADCAST:
        if (wparam == PBT_APMSUSPEND) edge("sleep");
        if (wparam == PBT_APMRESUMEAUTOMATIC) edge("wake");
        if (wparam == PBT_POWERSETTINGCHANGE && lparam) {
            display_state(*reinterpret_cast<const POWERBROADCAST_SETTING*>(lparam));
        }
        return TRUE;
    case WM_DISPLAYCHANGE:
        workspace_changed("screens", front_pid());
        return 0;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
}

// A hidden top-level window rather than a message-only one: WM_DISPLAYCHANGE and the power broadcasts go to
// top-level windows only. It is never shown, so no window list or taskbar has it.
void watch_thread(HANDLE started) {
    HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    WNDCLASSW type{};
    type.lpfnWndProc = window_proc;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"AcHelperWatch";
    HWND window = RegisterClassW(&type) ? CreateWindowExW(WS_EX_TOOLWINDOW, type.lpszClassName, L"", WS_POPUP, 0, 0,
                                                          0, 0, nullptr, nullptr, type.hInstance, nullptr)
                                        : nullptr;
    if (window) {
        WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION);
        RegisterPowerSettingNotification(window, &kConsoleDisplayState, DEVICE_NOTIFY_WINDOW_HANDLE);
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, foreground, 0, 0,
                        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (SUCCEEDED(com) &&
            FAILED(CoCreateInstance(__uuidof(VirtualDesktopManager), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&g_desktops)))) {
            g_desktops = nullptr;
        }
        RAWINPUTDEVICE devices[2] = {{0x01, 0x06, RIDEV_INPUTSINK, window}, {0x01, 0x02, RIDEV_INPUTSINK, window}};
        g_counting = RegisterRawInputDevices(devices, 2, static_cast<UINT>(sizeof(RAWINPUTDEVICE))) != 0;
        g_started = true;
    }
    SetEvent(started);
    if (!window) return;
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) DispatchMessageW(&message);
}

// Each watch's success answer is out before its first event; turning it off drops events from then on.
Outcome watch(const json::Value& params, std::atomic<bool>& on, void (*turn_on)()) {
    if (!g_started) return failure("internal", "the helper's watch window did not start");
    bool enabled = flag(params, "enabled");
    if (!enabled) on = false;
    json::Value result = json::object();
    result.set("watching", json::boolean(enabled));
    Outcome out = success(std::move(result));
    if (enabled) out.answered = turn_on;
    return out;
}

struct Audio {
    bool input = false, output = false;  // has an active session
};

// The processes with a session on device that has not expired; false when the sessions cannot be read.
bool add_sessions(IMMDevice* device, bool input, std::map<DWORD, Audio>& into) {
    IAudioSessionManager2* manager = nullptr;
    IAudioSessionEnumerator* sessions = nullptr;
    int count = 0;
    bool ok = SUCCEEDED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                         reinterpret_cast<void**>(&manager))) &&
              SUCCEEDED(manager->GetSessionEnumerator(&sessions)) && SUCCEEDED(sessions->GetCount(&count));
    for (int k = 0; ok && k < count; ++k) {
        IAudioSessionControl* control = nullptr;
        IAudioSessionControl2* control2 = nullptr;
        AudioSessionState state = AudioSessionStateExpired;
        DWORD pid = 0;
        if (SUCCEEDED(sessions->GetSession(k, &control)) && SUCCEEDED(control->GetState(&state)) &&
            state != AudioSessionStateExpired && SUCCEEDED(control->QueryInterface(IID_PPV_ARGS(&control2))) &&
            SUCCEEDED(control2->GetProcessId(&pid)) && pid) {
            Audio& audio = into[pid];
            if (state == AudioSessionStateActive) (input ? audio.input : audio.output) = true;
        }
        if (control2) control2->Release();
        if (control) control->Release();
    }
    if (sessions) sessions->Release();
    if (manager) manager->Release();
    return ok;
}

// An active session on the default capture endpoint; null while the helper itself records.
json::Value mic_active(IMMDeviceEnumerator* devices) {
    IMMDevice* device = nullptr;
    std::map<DWORD, Audio> sessions;
    bool ok = SUCCEEDED(devices->GetDefaultAudioEndpoint(eCapture, eConsole, &device)) &&
              add_sessions(device, true, sessions);
    if (device) device->Release();
    if (!ok) return json::null();
    auto mine = sessions.find(GetCurrentProcessId());
    if (mine != sessions.end() && mine->second.input) return json::null();
    for (const auto& session : sessions) {
        if (session.second.input) return json::boolean(true);
    }
    return json::boolean(false);
}

// The processes with a session on any active playback or capture endpoint.
json::Value audio_clients(IMMDeviceEnumerator* devices, Apps& apps) {
    std::map<DWORD, Audio> clients;
    for (EDataFlow flow : {eRender, eCapture}) {
        IMMDeviceCollection* endpoints = nullptr;
        UINT count = 0;
        if (FAILED(devices->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &endpoints)) ||
            FAILED(endpoints->GetCount(&count))) {
            if (endpoints) endpoints->Release();
            return json::null();
        }
        for (UINT k = 0; k < count; ++k) {
            IMMDevice* device = nullptr;
            if (SUCCEEDED(endpoints->Item(k, &device))) add_sessions(device, flow == eCapture, clients);
            if (device) device->Release();
        }
        endpoints->Release();
    }
    json::Value list = json::array();
    for (const auto& client : clients) {
        const App& app = apps.get(client.first);
        json::Value entry = json::object();
        entry.set("pid", json::integer(client.first));
        entry.set("app_id", app.app_id);
        entry.set("name", app.name);
        entry.set("running_input", json::boolean(client.second.input));
        entry.set("running_output", json::boolean(client.second.output));
        list.push(std::move(entry));
    }
    return list;
}

std::mutex g_gpu_lock;
PDH_HQUERY g_gpu_query = nullptr;
PDH_HCOUNTER g_gpu_counter = nullptr;
uint64_t g_gpu_read = 0;  // the tick of the previous collection

// The busiest GPU engine's use by pid since the previous read, 0-1; null on the first read, under 1 s after the
// previous one, or without the GPU Engine counters.
json::Value gpu_busy(DWORD pid) {
    std::lock_guard<std::mutex> hold(g_gpu_lock);
    static bool opened = false;
    if (!opened) {
        opened = true;
        if (PdhOpenQueryW(nullptr, 0, &g_gpu_query) != ERROR_SUCCESS ||
            PdhAddEnglishCounterW(g_gpu_query, L"\\GPU Engine(*)\\Utilization Percentage", 0, &g_gpu_counter) !=
                ERROR_SUCCESS) {
            g_gpu_counter = nullptr;
        }
    }
    uint64_t now = GetTickCount64();
    if (!g_gpu_counter || (g_gpu_read && now - g_gpu_read < 1000)) return json::null();
    bool first = g_gpu_read == 0;
    g_gpu_read = now;
    if (PdhCollectQueryData(g_gpu_query) != ERROR_SUCCESS || first) return json::null();
    DWORD bytes = 0, count = 0;
    PDH_STATUS status = PdhGetFormattedCounterArrayW(g_gpu_counter, PDH_FMT_DOUBLE, &bytes, &count, nullptr);
    if (static_cast<DWORD>(status) != PDH_MORE_DATA) return json::null();
    std::vector<BYTE> buffer(bytes);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
    if (PdhGetFormattedCounterArrayW(g_gpu_counter, PDH_FMT_DOUBLE, &bytes, &count, items) != ERROR_SUCCESS) {
        return json::null();
    }
    std::wstring prefix = L"pid_" + std::to_wstring(pid) + L"_";  // instances are pid_<pid>_luid_..._engtype_<kind>
    double busiest = 0;
    for (DWORD k = 0; k < count; ++k) {
        DWORD valid = items[k].FmtValue.CStatus;
        if ((valid == PDH_CSTATUS_VALID_DATA || valid == PDH_CSTATUS_NEW_DATA) &&
            std::wcsncmp(items[k].szName, prefix.c_str(), prefix.size()) == 0) {
            busiest = std::max(busiest, items[k].FmtValue.doubleValue);
        }
    }
    return json::number(std::min(1.0, std::max(0.0, busiest / 100)));
}

bool session_locked() {
    WTSINFOEXW* info = nullptr;
    DWORD bytes = 0;
    if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSSessionInfoEx,
                                     reinterpret_cast<LPWSTR*>(&info), &bytes)) {
        return false;
    }
    bool locked = info->Level == 1 && info->Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK;
    WTSFreeMemory(info);
    return locked;
}

double idle_seconds() {
    LASTINPUTINFO last{};
    last.cbSize = sizeof last;
    if (!GetLastInputInfo(&last)) return 0;
    return static_cast<DWORD>(GetTickCount() - last.dwTime) / 1000.0;
}

// The foreground window's app, with the foreground window, else that app's front-most window on screen.
json::Value front_json(const std::vector<Window>& windows, DWORD pid, HWND front, bool titles, Apps& apps) {
    if (!pid) return json::null();
    const Window* best = nullptr;
    for (const Window& w : windows) {
        if (w.hwnd == front) {
            best = &w;
            break;
        }
        if (!best && w.pid == pid) best = &w;
    }
    const App& app = apps.get(pid);
    json::Value v = json::object();
    v.set("pid", json::integer(pid));
    v.set("name", app.name);
    v.set("app_id", app.app_id);
    v.set("window", best ? window_json(*best, titles, apps) : json::null());
    v.set("category", json::null());
    return v;
}

// Whether any subkey of key has a LastUsedTimeStart and a LastUsedTimeStop of 0.
bool consent_in_use(HKEY key) {
    for (DWORD k = 0;; ++k) {
        wchar_t name[256];
        DWORD length = 256;
        LSTATUS status = RegEnumKeyExW(key, k, name, &length, nullptr, nullptr, nullptr, nullptr);
        if (status == ERROR_NO_MORE_ITEMS) return false;
        uint64_t start = 0, stop = 0;
        DWORD bytes = sizeof start;
        if (status != ERROR_SUCCESS ||
            RegGetValueW(key, name, L"LastUsedTimeStart", RRF_RT_REG_QWORD, nullptr, &start, &bytes) != ERROR_SUCCESS) {
            continue;
        }
        bytes = sizeof stop;
        if (start > 0 &&
            RegGetValueW(key, name, L"LastUsedTimeStop", RRF_RT_REG_QWORD, nullptr, &stop, &bytes) == ERROR_SUCCESS &&
            stop == 0) {
            return true;
        }
    }
}

// An app uses the camera now when its entry in the camera's consent store has started and not stopped;
// packaged apps are the store's subkeys, desktop apps those of its NonPackaged. Null when the store cannot be read.
json::Value camera_active() {
    const wchar_t* webcam =
        L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam";
    HKEY store = nullptr;
    LSTATUS opened = RegOpenKeyExW(HKEY_CURRENT_USER, webcam, 0, KEY_READ, &store);
    if (opened == ERROR_FILE_NOT_FOUND) return json::boolean(false);
    if (opened != ERROR_SUCCESS) return json::null();
    bool active = consent_in_use(store);
    HKEY desktop = nullptr;
    if (!active && RegOpenKeyExW(store, L"NonPackaged", 0, KEY_READ, &desktop) == ERROR_SUCCESS) {
        active = consent_in_use(desktop);
        RegCloseKey(desktop);
    }
    RegCloseKey(store);
    return json::boolean(active);
}

// The top-level window under the cursor, when it is one windows.list would list.
json::Value mouse_window(const std::vector<Window>& windows, bool titles, Apps& apps) {
    POINT at{};
    HWND under = GetCursorPos(&at) ? WindowFromPoint(at) : nullptr;
    HWND root = under ? GetAncestor(under, GA_ROOT) : nullptr;
    for (const Window& w : windows) {
        if (root && w.hwnd == root) return window_json(w, titles, apps);
    }
    return json::null();
}

json::Value input_counters() {
    json::Value v = json::object();
    v.set("keys", json::integer(static_cast<int64_t>(g_keys.load())));
    v.set("left_clicks", json::integer(static_cast<int64_t>(g_left_clicks.load())));
    v.set("right_clicks", json::integer(static_cast<int64_t>(g_right_clicks.load())));
    v.set("scrolls", json::integer(static_cast<int64_t>(g_scrolls.load())));
    v.set("moves", json::integer(static_cast<int64_t>(g_moves.load())));
    return v;
}

json::Value input_idles() {
    uint64_t now = GetTickCount64();
    auto idle = [now](const std::atomic<uint64_t>& last) {
        uint64_t at = last.load();
        return json::number(at < now ? static_cast<double>(now - at) / 1000.0 : 0.0);
    };
    json::Value v = json::object();
    v.set("key", idle(g_last_key));
    v.set("pointer", idle(g_last_pointer));
    v.set("scroll", idle(g_last_scroll));
    v.set("click", idle(g_last_click));
    return v;
}

}  // namespace

bool keyboard_watched() { return g_counting; }

void start_watches() {
    uint64_t now = GetTickCount64();
    for (std::atomic<uint64_t>* last : {&g_last_key, &g_last_pointer, &g_last_scroll, &g_last_click}) *last = now;
    HANDLE started = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!started) return;
    try {
        std::thread(watch_thread, started).detach();
        WaitForSingleObject(started, INFINITE);
    } catch (const std::exception&) {
    }
    CloseHandle(started);
}

Outcome attention_sample(const json::Value& params) {
    bool titles = flag(params, "include_titles");
    FILETIME now{};
    GetSystemTimePreciseAsFileTime(&now);
    std::vector<Window> windows = screen_windows();
    HWND front = GetForegroundWindow();
    DWORD pid = front ? owner_pid(front) : 0;
    Apps apps;
    json::Value result = json::object();
    result.set("ts", json::number(unix_seconds(now)));
    result.set("front", front_json(windows, pid, front, titles, apps));
    result.set("mouse_window", mouse_window(windows, titles, apps));
    result.set("idle_s", json::number(idle_seconds()));
    result.set("locked", json::boolean(session_locked()));
    result.set("secure_input", json::boolean(false));
    uia::set_focus_roles(result, pid);
    result.set("camera_active", camera_active());
    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IMMDeviceEnumerator* devices = nullptr;
    bool audio =
        SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)));
    result.set("mic_active", audio ? mic_active(devices) : json::null());
    result.set("audio_clients", audio && flag(params, "include_audio") ? audio_clients(devices, apps) : json::null());
    if (devices) devices->Release();
    if (SUCCEEDED(com)) CoUninitialize();
    bool counted = flag(params, "include_input") && g_counting;
    result.set("input_counters", counted ? input_counters() : json::null());
    result.set("input_idles", counted ? input_idles() : json::null());
    result.set("video_pids", json::null());
    result.set("front_gpu_busy", pid ? gpu_busy(pid) : json::null());
    result.set("capture_indicator", json::null());
    return success(std::move(result));
}

Outcome presence_watch(const json::Value& params) {
    return watch(params, g_presence, [] { g_presence = true; });
}

Outcome input_watch(const json::Value& params) {
    if (!g_counting && flag(params, "enabled")) return failure("internal", "Raw Input could not be registered");
    return watch(params, g_input, [] { g_input = true; });
}

// workspace.watch's answer has no front_pid on Windows.
Outcome workspace_watch(const json::Value& params) {
    if (flag(params, "enabled")) g_front_pid = front_pid();
    return watch(params, g_workspace, [] { g_workspace = true; });
}

// The keys' state now; GetAsyncKeyState reads all zeros when this session's desktop does not have the input.
Outcome input_modifiers(const json::Value&) {
    auto down = [](int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; };
    json::Value result = json::object();
    result.set("alt", json::boolean(down(VK_MENU)));
    result.set("shift", json::boolean(down(VK_SHIFT)));
    result.set("control", json::boolean(down(VK_CONTROL)));
    result.set("meta", json::boolean(down(VK_LWIN) || down(VK_RWIN)));
    return success(std::move(result));
}
