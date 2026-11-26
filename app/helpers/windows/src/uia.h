// UI Automation for the ax.* ops: one dedicated MTA thread owns IUIAutomation and makes every UIA
// call; the AX role names of UIA's ControlTypes; the element reads the ax.* handlers share.
#pragma once

#define NOMINMAX
#include <windows.h>
#include <uiautomation.h>
#include <wrl/client.h>

#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "json.h"
#include "ops.h"
#include "win32.h"

// uia.cpp
Outcome ax_focused(const json::Value& params);
Outcome ax_selected_text(const json::Value& params);
Outcome ax_watch(const json::Value& params);
Outcome input_actions(const json::Value& params);
// ops_uia.cpp
Outcome ax_dialog_buttons(const json::Value& params);
Outcome ax_overlays(const json::Value& params);
Outcome ax_hit_chain(const json::Value& params);
Outcome ax_window_text(const json::Value& params);
Outcome ax_window_tree(const json::Value& params);
Outcome browser_front_tab(const json::Value& params);
// ops_control_ui.cpp
Outcome control_observe(const json::Value& params);
Outcome control_act(const json::Value& params);
Outcome control_read(const json::Value& params);

namespace uia {

using Microsoft::WRL::ComPtr;

// How long an op waits for its work on the UIA thread: inside the 1000, 2000 and 3000 ms timeout_ms of ops.json.
constexpr DWORD kProbeMs = 800;
constexpr DWORD kWatchMs = 1500;
constexpr DWORD kTextMs = 2500;
// ax.watch's read at subscription, after kWatchMs; ax.window_tree and browser.front_tab of 2000 ms; attention.sample's
// focus read, beside its other reads.
constexpr DWORD kWatchReadMs = 300;
constexpr DWORD kTreeMs = 1700;
constexpr DWORD kTabMs = 1500;
constexpr DWORD kSampleMs = 400;
// The most UTF-16 units one value or selection read takes.
constexpr int kMaxTextUnits = 1 << 18;

// Runs work on the UIA thread and waits up to limit_ms for it. False when it did not finish in time (pid, when not 0,
// then gets the 2 s back-off) or UIA could not start; work that starts late still runs, so it may only touch what it
// owns.
bool call(DWORD limit_ms, DWORD pid, std::function<void(IUIAutomation*)> work);
// Queues work for the UIA thread without waiting.
void post(std::function<void(IUIAutomation*)> work);
bool available();

// An app that timed out answers ax_timeout for 2 s without being asked.
bool skipped(DWORD pid);
void back_off(DWORD pid);

inline Outcome timeout() { return failure("ax_timeout", "the app did not answer UI Automation in time", true); }
inline Outcome gone() { return failure("process_gone", "no process has that pid"); }

// read's outcome on the UIA thread within limit_ms, else ax_timeout.
inline Outcome on_uia(DWORD limit_ms, DWORD pid, std::function<Outcome(IUIAutomation*)> read) {
    if (!available()) return failure("internal", "UI Automation could not start");
    auto out = std::make_shared<Outcome>();
    if (!call(limit_ms, pid, [out, read](IUIAutomation* automation) { *out = read(automation); })) return timeout();
    return *out;
}

// One op's UIA reads of one app; the first timeout puts the app on the back-off list.
struct Reads {
    DWORD pid = 0;  // 0 until the app is known
    bool timed_out = false;
    bool failed = false;  // a failure other than a timeout or an element that went away
    bool ok(HRESULT hr);
};

// The UIA thread's one cache request with the properties Info holds.
IUIAutomationCacheRequest* cache_request(IUIAutomation* automation);

// A property condition on an int (VT_I4) or a string (VT_BSTR) property.
inline ComPtr<IUIAutomationCondition> condition(IUIAutomation* automation, PROPERTYID property, VARIANT value) {
    ComPtr<IUIAutomationCondition> made;
    if (FAILED(automation->CreatePropertyCondition(property, value, &made))) made.Reset();
    VariantClear(&value);
    return made;
}

inline ComPtr<IUIAutomationCondition> condition(IUIAutomation* automation, PROPERTYID property, int value) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_I4;
    v.lVal = value;
    return condition(automation, property, v);
}

inline ComPtr<IUIAutomationCondition> condition(IUIAutomation* automation, PROPERTYID property, const wchar_t* value) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BSTR;
    v.bstrVal = SysAllocString(value);
    return v.bstrVal ? condition(automation, property, v) : nullptr;
}

// The focused element when pid (0: any app) owns it, else null; reads says why when it is null.
ComPtr<IUIAutomationElement> focused(IUIAutomation* automation, DWORD pid, Reads& reads);
ComPtr<IUIAutomationTextPattern> text_pattern(IUIAutomationElement* element, Reads& reads);
struct Info;
// The first selection's text, null when there is none or it is empty. Never of a password control.
json::Value selected_text(IUIAutomationElement* element, const Info& info, Reads& reads);
// A text control's value (ValuePattern, else TextPattern; a Document the other way round), at most max_units UTF-16
// units, cut set when there was more; null when it has none. Never of a password control.
json::Value value_text(IUIAutomationElement* element, const Info& info, int max_units, Reads& reads,
                       bool* cut = nullptr);
// The caret at the selection's start when it lies within 40 px of the control, else null.
json::Value caret(IUIAutomationElement* element, const Info& info, Reads& reads);
// An ax_element of element in the top-level window: roles, label (a Text control's first 200 scalars),
// the value's length, the window's title and element_key; selected_text and value only when asked. A password control
// gives its roles, window title and key only, and a null value when asked.
json::Value element_json(IUIAutomationElement* element, HWND window, bool selected, bool value, Reads& reads);

// attention.sample's focus_* fields: the focused element's roles and those of the first Window up from
// it; null where UIA does not answer. front: the foreground app.
void set_focus_roles(json::Value& result, DWORD front);

// input.actions is on; ops_attention.cpp's Raw Input asks before it reads an action.
bool actions_on();
// A user's release of the left button (click) or press of the right one (context_menu) at p; the control under it is
// read on the UIA thread.
void click_action(POINT p, bool context_menu);
// A shortcut or submit (kind) with its keys, sent to pid, the foreground app; its focused control is read on the UIA
// thread.
void key_action(DWORD pid, const char* kind, std::string keys);

// ---- text

inline std::wstring take_wide(BSTR text) {
    std::wstring out = text ? std::wstring(text, SysStringLen(text)) : std::wstring();
    SysFreeString(text);
    return out;
}

inline std::string utf8(const std::wstring& text) { return win32::utf8(text); }
// Converts and frees text.
inline std::string take(BSTR text) { return utf8(take_wide(text)); }

// The number of Unicode scalars of UTF-8 text, and its first n of them.
inline size_t scalars(const std::string& text) {
    size_t count = 0;
    for (unsigned char c : text) count += (c & 0xC0) != 0x80;
    return count;
}

inline std::string first_scalars(const std::string& text, size_t n) {
    size_t at = 0;
    for (size_t seen = 0; at < text.size(); ++at) {
        if ((static_cast<unsigned char>(text[at]) & 0xC0) != 0x80 && seen++ == n) break;
    }
    return text.substr(0, at);
}

// ---- elements

// IsPassword, or a keyword of ops.json's secure_keywords in the class name, Name or HelpText, as
// AXRules.isSecure reads role, subrole, title and description. A Text control's Name is its text (AXStaticText's
// value), which the rule leaves out.
inline bool secure(bool password, CONTROLTYPEID type, const std::wstring& class_name, const std::wstring& name,
                   const std::wstring& help) {
    if (password) return true;
    std::wstring identity =
        win32::lower(class_name + L" " + (type == UIA_TextControlTypeId ? std::wstring() : name) + L" " + help);
    for (const wchar_t* keyword : c12_generated::secure_keywords()) {
        if (identity.find(keyword) != std::wstring::npos) return true;
    }
    return false;
}

// The cached properties of an element, as cache_request() asks for them.
struct Info {
    CONTROLTYPEID type = 0;
    RECT bounds{};
    bool has_bounds = false;  // a non-empty bounding rectangle
    bool password = false;    // IsPassword
    bool secure = false;      // by secure(): what no read of a value, label or selection touches
    bool offscreen = false, modal = false, editable_value = false;
    DWORD pid = 0;
    std::wstring name, help, class_name;
};

inline bool cached_flag(IUIAutomationElement* element, PROPERTYID property) {
    VARIANT value;
    VariantInit(&value);
    bool on = SUCCEEDED(element->GetCachedPropertyValue(property, &value)) && value.vt == VT_BOOL &&
              value.boolVal != VARIANT_FALSE;
    VariantClear(&value);
    return on;
}

inline Info info(IUIAutomationElement* element) {
    Info i;
    if (!element) return i;
    element->get_CachedControlType(&i.type);
    RECT r{};
    if (SUCCEEDED(element->get_CachedBoundingRectangle(&r)) && r.right > r.left && r.bottom > r.top) {
        i.bounds = r;
        i.has_bounds = true;
    }
    BOOL on = FALSE;
    if (SUCCEEDED(element->get_CachedIsPassword(&on))) i.password = on != FALSE;
    on = FALSE;
    if (SUCCEEDED(element->get_CachedIsOffscreen(&on))) i.offscreen = on != FALSE;
    int pid = 0;
    if (SUCCEEDED(element->get_CachedProcessId(&pid)) && pid > 0) i.pid = static_cast<DWORD>(pid);
    BSTR text = nullptr;
    if (SUCCEEDED(element->get_CachedName(&text))) i.name = take_wide(text);
    text = nullptr;
    if (SUCCEEDED(element->get_CachedHelpText(&text))) i.help = take_wide(text);
    text = nullptr;
    if (SUCCEEDED(element->get_CachedClassName(&text))) i.class_name = take_wide(text);
    i.editable_value = cached_flag(element, UIA_IsValuePatternAvailablePropertyId) &&
                       !cached_flag(element, UIA_ValueIsReadOnlyPropertyId);
    i.modal = cached_flag(element, UIA_WindowIsModalPropertyId);
    i.secure = secure(i.password, i.type, i.class_name, i.name, i.help);
    return i;
}

// The native name and the AX role of each UIA ControlType; null for a type the table lacks.
inline const char* const* find_type(CONTROLTYPEID id) {
    static const char* const types[][2] = {
        {"Button", "AXButton"}, {"Calendar", "AXUnknown"}, {"CheckBox", "AXCheckBox"}, {"ComboBox", "AXComboBox"},
        {"Edit", "AXTextField"}, {"Hyperlink", "AXLink"}, {"Image", "AXImage"}, {"ListItem", "AXRow"},
        {"List", "AXList"}, {"Menu", "AXMenu"}, {"MenuBar", "AXMenuBar"}, {"MenuItem", "AXMenuItem"},
        {"ProgressBar", "AXProgressIndicator"}, {"RadioButton", "AXRadioButton"}, {"ScrollBar", "AXScrollBar"},
        {"Slider", "AXSlider"}, {"Spinner", "AXIncrementor"}, {"StatusBar", "AXGroup"}, {"Tab", "AXTabGroup"},
        {"TabItem", "AXRadioButton"}, {"Text", "AXStaticText"}, {"ToolBar", "AXToolbar"}, {"ToolTip", "AXHelpTag"},
        {"Tree", "AXOutline"}, {"TreeItem", "AXRow"}, {"Custom", "AXUnknown"}, {"Group", "AXGroup"},
        {"Thumb", "AXUnknown"}, {"DataGrid", "AXTable"}, {"DataItem", "AXRow"}, {"Document", "AXTextArea"},
        {"SplitButton", "AXMenuButton"}, {"Window", "AXWindow"}, {"Pane", "AXGroup"}, {"Header", "AXUnknown"},
        {"HeaderItem", "AXUnknown"}, {"Table", "AXTable"}, {"TitleBar", "AXUnknown"}, {"Separator", "AXUnknown"},
        {"SemanticZoom", "AXUnknown"}, {"AppBar", "AXUnknown"},
    };
    // The ControlType ids run from UIA_ButtonControlTypeId (50000) to UIA_AppBarControlTypeId in the table's order.
    static_assert(static_cast<size_t>(UIA_AppBarControlTypeId - UIA_ButtonControlTypeId + 1) ==
                          sizeof types / sizeof types[0] &&
                      UIA_EditControlTypeId == UIA_ButtonControlTypeId + 4 &&
                      UIA_TextControlTypeId == UIA_ButtonControlTypeId + 20 &&
                      UIA_WindowControlTypeId == UIA_ButtonControlTypeId + 32,
                  "the ControlType table is out of order");
    if (id < UIA_ButtonControlTypeId || id > UIA_AppBarControlTypeId) return nullptr;
    return types[id - UIA_ButtonControlTypeId];
}

// The AX role (AXUnknown for a type the table lacks) and the UIA name (the id for such a type).
inline std::string role(CONTROLTYPEID type) {
    const char* const* found = find_type(type);
    return found ? found[1] : "AXUnknown";
}

inline std::string native_role(CONTROLTYPEID type) {
    const char* const* found = find_type(type);
    return found ? found[0] : std::to_string(type);
}

// AXSecureTextField for IsPassword, AXDialog for a modal window, else null.
inline json::Value subrole(const Info& info) {
    if (info.password) return json::str("AXSecureTextField");
    if (info.type == UIA_WindowControlTypeId && info.modal) return json::str("AXDialog");
    return json::null();
}

// By role and subrole as ScreenTargets.isEditable, or a ValuePattern that is not read-only.
inline bool editable(const Info& info) {
    std::string r = role(info.type);
    return r == "AXTextField" || r == "AXTextArea" || r == "AXComboBox" || info.password || info.editable_value;
}

inline json::Value rect(const RECT& r) { return win32::rect(r); }
inline json::Value frame(const Info& info) { return info.has_bounds ? rect(info.bounds) : json::null(); }

inline bool intersects(const RECT& a, const RECT& b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// The opaque element_key: the RuntimeId's parts in hex; empty without one. Takes id.
inline std::string runtime_key(SAFEARRAY* id) {
    if (!id) return {};
    LONG low = 0, high = -1;
    SafeArrayGetLBound(id, 1, &low);
    SafeArrayGetUBound(id, 1, &high);
    std::string key;
    for (LONG k = low; k <= high; ++k) {
        int part = 0;
        if (FAILED(SafeArrayGetElement(id, &k, &part))) break;
        char hex[16];
        std::snprintf(hex, sizeof hex, "%x", static_cast<unsigned>(part));
        key += (key.empty() ? "" : ".") + std::string(hex);
    }
    SafeArrayDestroy(id);
    return key;
}

inline json::Value element_key(IUIAutomationElement* element) {
    SAFEARRAY* id = nullptr;
    if (!element || FAILED(element->GetRuntimeId(&id))) return json::null();
    std::string key = runtime_key(id);
    return key.empty() ? json::null() : json::str(key);
}

// ---- processes and windows

// A process that exists; one this helper may not open still exists.
inline bool alive(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return GetLastError() == ERROR_ACCESS_DENIED;
    DWORD code = 0;
    bool running = GetExitCodeProcess(process, &code) && code == STILL_ACTIVE;
    CloseHandle(process);
    return running;
}

// A pid param of a live process, else 0.
inline DWORD live_pid(const json::Value* pid) {
    if (!pid || pid->type != json::Type::Int || pid->i > static_cast<int64_t>(MAXDWORD)) return 0;
    return alive(static_cast<DWORD>(pid->i)) ? static_cast<DWORD>(pid->i) : 0;
}

// Lower case; empty when unknown.
inline std::wstring exe_name(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return {};
    std::wstring name = win32::lower(win32::base_name(win32::image_path(process)));
    CloseHandle(process);
    return name;
}

// The foreground window when pid owns it, else pid's front-most window on screen, else nullptr.
inline HWND front_window(DWORD pid) {
    HWND front = GetForegroundWindow();
    HWND root = front ? GetAncestor(front, GA_ROOT) : nullptr;
    if (root && win32::owner_pid(root) == pid) return root;
    for (const win32::Window& w : win32::screen_windows()) {
        if (w.pid == pid) return w.hwnd;
    }
    return nullptr;
}

// Without a message to the window, so that a hung one cannot block.
inline std::string window_title(HWND hwnd) {
    wchar_t title[1024] = {};
    int length = hwnd ? GetWindowTextW(hwnd, title, 1024) : 0;
    return win32::utf8(title, length > 0 ? static_cast<size_t>(length) : 0);
}

inline std::vector<ComPtr<IUIAutomationElement>> elements(IUIAutomationElementArray* found) {
    std::vector<ComPtr<IUIAutomationElement>> out;
    int count = 0;
    if (!found || FAILED(found->get_Length(&count))) return out;
    for (int k = 0; k < count; ++k) {
        ComPtr<IUIAutomationElement> element;
        if (SUCCEEDED(found->GetElement(k, &element)) && element) out.push_back(element);
    }
    return out;
}

inline json::Value result_with(const char* key, json::Value value) {
    json::Value result = json::object();
    result.set(key, std::move(value));
    return result;
}

}  // namespace uia
