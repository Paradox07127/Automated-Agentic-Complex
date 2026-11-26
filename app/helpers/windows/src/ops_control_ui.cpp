// control.observe, control.act and control.read: observe, act on and read back one window of another
// app through UI Automation, as the Mac helper's Control.swift does, without the grants, the blacklist and the
// redaction, which the main process does. Snapshots live in this process only. Every UIA call runs on uia.cpp's
// thread; no password control is listed, read or written, and no input is synthesized: click and scroll answer
// unsupported_action.
#define _CRT_RAND_S
#include <stdlib.h>

#include "uia.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using uia::ComPtr;
using uia::Info;
using uia::Reads;

namespace limits = c12_generated::limits;

constexpr size_t kMaxElements = limits::control_observe_max_elements,
                 kMaxTextScalars = limits::control_observe_max_text_scalars,
                 kTitleScalars = limits::control_observe_title_scalars,
                 kValueScalars = limits::control_observe_value_scalars;
constexpr size_t kExtraWork = 48, kChildrenEach = 80;  // the walk's queue: max_elements and 48 more, 80 per element
constexpr int kValueUnits = 2 * static_cast<int>(kValueScalars);  // enough UTF-16 units for kValueScalars scalars
constexpr size_t kMaxTextBytes = 4096;
constexpr int64_t kImageBytes = 2500000;
constexpr ULONGLONG kLifetimeMs = 15000;
constexpr size_t kKept = 16;
constexpr ULONGLONG kWalkMs = 1000;  // the walk's own limit, as on macOS
// The waits for the UIA thread: the walk leaves control.observe's 5000 ms room for the image; act and read stay inside
// their 3000 ms (after the 250 ms gap) and 2000 ms.
constexpr DWORD kObserveMs = 2500, kActMs = 1500, kReadMs = 1500;
constexpr auto kActionGap = std::chrono::milliseconds(250);
constexpr int kOwnerDepth = 32;  // ancestors searched for an element's window

std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    int count = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(count > 0 ? count : 0), L'\0');
    if (count > 0) MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), count);
    return out;
}

Outcome stale() { return failure("stale_snapshot", "no live snapshot has that id; observe again"); }
Outcome target_changed() { return failure("target_changed", "the window moved, changed or closed since the snapshot"); }
// retryable only when no action can have gone out.
Outcome late(bool retryable) {
    return failure("timeout", "the app did not answer UI Automation in time", retryable);
}

// The window an observation was made of; compared again before every act and read.
struct Target {
    DWORD pid = 0;
    HWND hwnd = nullptr;
    RECT bounds{};
    std::string app_id;
    double launched_at = 0;

    bool operator==(const Target& o) const {
        return pid == o.pid && hwnd == o.hwnd && EqualRect(&bounds, &o.bounds) && app_id == o.app_id &&
               launched_at == o.launched_at;
    }
};

// The window as windows.list shows it now: on screen, of pid and a normal (layer 0) window; false otherwise.
bool find_target(DWORD pid, HWND hwnd, Target& out) {
    for (const win32::Window& w : win32::screen_windows()) {
        if (w.hwnd != hwnd) continue;
        if (w.pid != pid || w.layer != 0) return false;
        win32::Apps apps;
        const win32::App& app = apps.get(pid);
        out.pid = pid;
        out.hwnd = hwnd;
        out.bounds = w.bounds;
        out.app_id = app.app_id.type == json::Type::Str ? app.app_id.s : std::string();
        out.launched_at = app.launched_at.is_number() ? app.launched_at.n : 0;
        return true;
    }
    return false;
}

json::Value target_json(const Target& t) {
    json::Value v = json::object();
    v.set("pid", json::integer(t.pid));
    v.set("app_id", json::str(t.app_id));
    v.set("window_id", win32::handle_id(t.hwnd));
    v.set("bounds", uia::rect(t.bounds));
    v.set("launched_at", json::number(t.launched_at));
    return v;
}

struct Snapshot {
    Target target;
    std::map<std::string, ComPtr<IUIAutomationElement>> elements;
    ULONGLONG at = 0;
};

// The observations act and read name: each lives 15 s, at most 16 are kept, and any action ends all of them. Ids carry
// a prefix drawn per process, so an id of an earlier helper is stale here.
class Snapshots {
public:
    Snapshots() {
        unsigned int word = 0;
        if (rand_s(&word) != 0) word = GetTickCount() ^ GetCurrentProcessId();
        do {
            prefix_.insert(prefix_.begin(), "0123456789abcdefghijklmnopqrstuvwxyz"[word % 36]);
            word /= 36;
        } while (word);
    }

    std::string add(std::shared_ptr<Snapshot> snapshot) {
        std::lock_guard<std::mutex> hold(lock_);
        for (auto k = kept_.begin(); k != kept_.end();) {
            k = snapshot->at - k->second->at >= kLifetimeMs ? kept_.erase(k) : std::next(k);
        }
        if (kept_.size() >= kKept) {
            auto oldest = std::min_element(kept_.begin(), kept_.end(),
                                           [](const auto& a, const auto& b) { return a.second->at < b.second->at; });
            kept_.erase(oldest);
        }
        std::string id = "o-" + prefix_ + "-" + std::to_string(++counter_);
        kept_[id] = std::move(snapshot);
        return id;
    }

    std::shared_ptr<Snapshot> find(const std::string& id) {
        std::lock_guard<std::mutex> hold(lock_);
        auto found = kept_.find(id);
        if (found == kept_.end() || GetTickCount64() - found->second->at >= kLifetimeMs) return nullptr;
        return found->second;
    }

    void invalidate() {
        std::lock_guard<std::mutex> hold(lock_);
        kept_.clear();
    }

private:
    std::mutex lock_;
    std::string prefix_;
    int counter_ = 0;
    std::map<std::string, std::shared_ptr<Snapshot>> kept_;
};

Snapshots& snapshots() {
    static Snapshots kept;
    return kept;
}

// One action at a time, at least kActionGap apart.
std::mutex g_acting;
std::atomic<int64_t> g_last_action{0};  // steady_clock nanoseconds; 0 before the first action

int64_t steady_now() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

// An action goes out: every snapshot ends and the next action waits kActionGap.
void action_out() {
    snapshots().invalidate();
    g_last_action = steady_now();
}

// UIA thread only: uia.cpp's properties, and those act and observe add.
IUIAutomationCacheRequest* g_cache = nullptr;

IUIAutomationCacheRequest* control_cache(IUIAutomation* automation) {
    if (g_cache || FAILED(automation->CreateCacheRequest(&g_cache))) return g_cache;
    for (PROPERTYID id : {UIA_ControlTypePropertyId, UIA_BoundingRectanglePropertyId, UIA_IsPasswordPropertyId,
                          UIA_IsOffscreenPropertyId, UIA_ProcessIdPropertyId, UIA_NamePropertyId,
                          UIA_HelpTextPropertyId, UIA_ClassNamePropertyId, UIA_IsValuePatternAvailablePropertyId,
                          UIA_ValueIsReadOnlyPropertyId, UIA_WindowIsModalPropertyId, UIA_IsEnabledPropertyId,
                          UIA_IsInvokePatternAvailablePropertyId, UIA_NativeWindowHandlePropertyId}) {
        g_cache->AddProperty(id);
    }
    return g_cache;
}

// max_text_scalars across one observation, with caps per field.
class Budget {
public:
    explicit Budget(size_t scalars) : left_(scalars) {}

    // cut: text is already the start of a longer one.
    std::string take(const std::string& text, size_t most, bool cut = false) {
        size_t room = std::min(most, left_), count = uia::scalars(text);
        if (count <= room) {
            left_ -= count;
            clipped_ = clipped_ || cut;
            return text;
        }
        clipped_ = true;
        left_ -= room;
        return uia::first_scalars(text, room);
    }

    bool clipped() const { return clipped_; }

private:
    size_t left_;
    bool clipped_ = false;
};

struct Observed {
    json::Value elements = json::array();
    std::map<std::string, ComPtr<IUIAutomationElement>> refs;
    bool truncated = false, clipped = false;
};

// Breadth first through the control view from the window's element, at most max_elements, skipping
// hidden (IsOffscreen), off-window and password controls and what is under them. A Text control's name is its value,
// as AXStaticText's text is.
Outcome walk(IUIAutomation* automation, const Target& target, bool text, size_t max_elements, size_t max_scalars,
             Observed& out) {
    Reads reads;
    reads.pid = target.pid;
    IUIAutomationCacheRequest* cache = control_cache(automation);
    ComPtr<IUIAutomationCondition> view;
    if (!cache || FAILED(automation->get_ControlViewCondition(&view))) {
        return failure("internal", "cannot make a UIA cache request");
    }
    ComPtr<IUIAutomationElement> window;
    if (!reads.ok(automation->ElementFromHandleBuildCache(target.hwnd, cache, &window)) || !window) {
        return reads.timed_out ? uia::timeout() : failure("window_gone", "UI Automation has no element of that window");
    }
    ULONGLONG deadline = GetTickCount64() + kWalkMs;
    size_t limit = max_elements > SIZE_MAX - kExtraWork ? SIZE_MAX : max_elements + kExtraWork;
    Budget budget(max_scalars);
    std::vector<ComPtr<IUIAutomationElement>> work = {window};
    size_t head = 0;
    bool expired = false;
    while (head < work.size() && out.refs.size() < max_elements && !reads.timed_out) {
        if (GetTickCount64() >= deadline) {
            expired = true;
            break;
        }
        ComPtr<IUIAutomationElement> node = work[head++];
        Info i = uia::info(node.Get());
        if (i.secure || i.offscreen || (i.has_bounds && !uia::intersects(target.bounds, i.bounds))) continue;
        std::string id = "e" + std::to_string(out.refs.size());
        BOOL enabled = TRUE;
        if (FAILED(node->get_CachedIsEnabled(&enabled))) enabled = TRUE;
        json::Value item = json::object();
        item.set("element_id", json::str(id));
        item.set("role", json::str(uia::role(i.type)));
        item.set("native_role", json::str(uia::native_role(i.type)));
        item.set("enabled", json::boolean(enabled != FALSE));
        if (text) {
            bool is_text = i.type == UIA_TextControlTypeId;
            const std::wstring& title = is_text || i.name.empty() ? i.help : i.name;
            item.set("title", json::str(budget.take(uia::utf8(title), kTitleScalars)));
            if (is_text) {
                item.set("value", json::str(budget.take(uia::utf8(i.name), kValueScalars)));
            } else if (i.type == UIA_EditControlTypeId || i.type == UIA_DocumentControlTypeId) {
                bool cut = false;
                json::Value value = uia::value_text(node.Get(), i, kValueUnits, reads, &cut);
                std::string shown = value.type == json::Type::Str ? value.s : std::string();
                item.set("value", json::str(budget.take(shown, kValueScalars, cut)));
            }
        }
        if (i.has_bounds) {
            RECT r = i.bounds;
            OffsetRect(&r, -target.bounds.left, -target.bounds.top);
            item.set("bounds", uia::rect(r));
        }
        json::Value actions = json::array();
        if (uia::cached_flag(node.Get(), UIA_IsInvokePatternAvailablePropertyId)) actions.push(json::str("AXPress"));
        item.set("actions", std::move(actions));
        out.elements.push(std::move(item));
        out.refs[id] = node;
        size_t room = std::min(kChildrenEach, limit - std::min(limit, work.size()));
        ComPtr<IUIAutomationElementArray> children;
        if (room > 0 && reads.ok(node->FindAllBuildCache(TreeScope_Children, view.Get(), cache, &children))) {
            for (const auto& child : uia::elements(children.Get())) {
                if (room-- == 0) break;
                work.push_back(child);
            }
        }
    }
    if (reads.timed_out) return uia::timeout();
    out.truncated = head < work.size() || work.size() >= limit || expired;
    out.clipped = budget.clipped();
    return success(json::object());
}

// The element's top-level window is window: the root of the first window handle at it or above it.
bool in_window(IUIAutomation* automation, IUIAutomationElement* element, HWND window, Reads& reads) {
    ComPtr<IUIAutomationTreeWalker> walker;
    if (FAILED(automation->get_ControlViewWalker(&walker))) return false;
    ComPtr<IUIAutomationElement> at(element);
    for (int depth = 0; at && depth < kOwnerDepth; ++depth) {
        UIA_HWND handle = nullptr;
        if (SUCCEEDED(at->get_CachedNativeWindowHandle(&handle)) && handle) {
            return GetAncestor(static_cast<HWND>(handle), GA_ROOT) == window;
        }
        ComPtr<IUIAutomationElement> parent;
        if (!reads.ok(walker->GetParentElementBuildCache(at.Get(), control_cache(automation), &parent))) return false;
        at = parent;
    }
    return false;
}

// The snapshot's element after the checks act and read share, as on macOS: the window has not moved or changed, the
// element still exists in it, and it is no password control; null with why otherwise.
ComPtr<IUIAutomationElement> checked(IUIAutomation* automation, const Snapshot& snapshot, const std::string& id,
                                     Reads& reads, Outcome& why) {
    Target now;
    if (!find_target(snapshot.target.pid, snapshot.target.hwnd, now) || !(now == snapshot.target)) {
        why = target_changed();
        return nullptr;
    }
    auto found = snapshot.elements.find(id);
    if (found == snapshot.elements.end()) {
        why = failure("element_gone", "the snapshot has no such element");
        return nullptr;
    }
    IUIAutomationCacheRequest* cache = control_cache(automation);
    ComPtr<IUIAutomationElement> fresh;
    if (!cache) {
        why = failure("internal", "cannot make a UIA cache request");
        return nullptr;
    }
    if (!reads.ok(found->second->BuildUpdatedCache(cache, &fresh)) || !fresh) {
        why = reads.timed_out ? late(true) : failure("element_gone", "the element no longer exists");
        return nullptr;
    }
    // A Win32 control's provider keeps the IsPassword it read when it was made; one made now reads it as it is.
    UIA_HWND handle = nullptr;
    ComPtr<IUIAutomationElement> remade;
    if (SUCCEEDED(fresh->get_CachedNativeWindowHandle(&handle)) && handle) {
        if (!reads.ok(automation->ElementFromHandleBuildCache(static_cast<HWND>(handle), cache, &remade)) || !remade) {
            why = reads.timed_out ? late(true) : failure("element_gone", "the element no longer exists");
            return nullptr;
        }
        fresh = remade;
    }
    if (!in_window(automation, fresh.Get(), snapshot.target.hwnd, reads)) {
        why = reads.timed_out ? late(true) : failure("target_changed", "the element left the snapshot's window");
        return nullptr;
    }
    if (uia::info(fresh.Get()).secure) {
        why = failure("secure_element", "the element is a password control");
        return nullptr;
    }
    return fresh;
}

Outcome effect(const char* name) { return success(uia::result_with("effect", json::str(name))); }
// A cancel, the shutdown or the handler's own timeout answered the request first; nobody reads this.
Outcome answered_before() { return failure("cancelled", "the request was answered before its action went out"); }

// press is InvokePattern.Invoke, unverifiable; set_value and type are ValuePattern.SetValue, confirmed when the value
// reads back the same. Once the action is out a UIA timeout leaves it unverifiable.
Outcome act_on(IUIAutomation* automation, const Snapshot& snapshot, const std::string& id, bool press,
               const std::wstring& text, Request& request) {
    Reads reads;
    reads.pid = snapshot.target.pid;
    Outcome why;
    ComPtr<IUIAutomationElement> element = checked(automation, snapshot, id, reads, why);
    if (!element) return why;
    if (press) {
        ComPtr<IUIAutomationInvokePattern> invoke;
        if (!uia::cached_flag(element.Get(), UIA_IsInvokePatternAvailablePropertyId) ||
            !reads.ok(element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&invoke))) || !invoke) {
            return reads.timed_out ? late(true) : failure("action_refused", "the element has no InvokePattern");
        }
        if (!commit(request)) return answered_before();
        action_out();
        if (!reads.ok(invoke->Invoke()) && !reads.timed_out) {
            return failure("action_refused", "the element did not take Invoke");
        }
        return effect("unverifiable");
    }
    ComPtr<IUIAutomationValuePattern> pattern;
    if (!uia::info(element.Get()).editable_value ||
        !reads.ok(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&pattern))) || !pattern) {
        return reads.timed_out ? late(true) : failure("action_refused", "the element's ValuePattern cannot be set");
    }
    BSTR value = SysAllocStringLen(text.data(), static_cast<UINT>(text.size()));
    if (!value) return failure("internal", "out of memory");
    if (!commit(request)) {
        SysFreeString(value);
        return answered_before();
    }
    action_out();
    HRESULT hr = pattern->SetValue(value);
    SysFreeString(value);
    if (!reads.ok(hr)) {
        return reads.timed_out ? effect("unverifiable")
                               : failure("action_refused", "the element did not take the text");
    }
    BSTR back = nullptr;
    bool same = reads.ok(pattern->get_CurrentValue(&back)) && uia::take_wide(back) == text;
    return effect(same ? "confirmed" : "unverifiable");
}

// The element's current value and title, compared by the main process (desktop_verify).
Outcome read_on(IUIAutomation* automation, const Snapshot& snapshot, const std::string& id) {
    Reads reads;
    reads.pid = snapshot.target.pid;
    Outcome why;
    ComPtr<IUIAutomationElement> element = checked(automation, snapshot, id, reads, why);
    if (!element) return why;
    Info i = uia::info(element.Get());
    bool is_text = i.type == UIA_TextControlTypeId;
    json::Value value =
        is_text ? json::str(uia::utf8(i.name)) : uia::value_text(element.Get(), i, uia::kMaxTextUnits, reads);
    if (reads.timed_out) return late(true);
    json::Value result = json::object();
    result.set("value", std::move(value));
    result.set("title", is_text ? json::null() : json::str(uia::utf8(i.name)));
    return success(std::move(result));
}

}  // namespace

Outcome control_observe(const json::Value& params) {
    int64_t asked = params.get("pid")->i;
    DWORD pid = asked > static_cast<int64_t>(MAXDWORD) ? 0 : static_cast<DWORD>(asked);
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(params.get("window_id")->i));
    Target target;
    if (!pid || !find_target(pid, hwnd, target)) {
        return failure("window_gone", "that process has no such window on screen");
    }
    if (uia::skipped(pid)) return uia::timeout();
    if (!uia::available()) return failure("internal", "UI Automation could not start");
    bool text = win32::flag(params, "include_text"), image = win32::flag(params, "include_image");
    const json::Value* most = params.get("max_elements");
    const json::Value* scalars = params.get("max_text_scalars");
    size_t max_elements = most ? static_cast<size_t>(most->i) : kMaxElements;
    size_t max_scalars = scalars ? static_cast<size_t>(scalars->i) : kMaxTextScalars;
    auto observed = std::make_shared<Observed>();
    auto walked = std::make_shared<Outcome>();
    if (!uia::call(kObserveMs, pid, [=](IUIAutomation* automation) {
            *walked = walk(automation, target, text, max_elements, max_scalars, *observed);
        })) {
        return uia::timeout();
    }
    if (!walked->ok) return *walked;
    json::Value result = json::object();
    result.set("target", target_json(target));
    result.set("elements", std::move(observed->elements));
    result.set("truncated", json::boolean(observed->truncated));
    result.set("text_truncated", json::boolean(observed->clipped));
    if (image) {
        json::Value shot = json::object();
        shot.set("window_id", *params.get("window_id"));
        shot.set("max_bytes", json::integer(kImageBytes));
        Outcome captured = capture_window(shot);
        if (!captured.ok) {
            return captured.code == "capture_failed" ? failure("internal", captured.message, captured.retryable)
                                                     : captured;
        }
        result.set("image", *captured.result.get("image"));
    }
    auto snapshot = std::make_shared<Snapshot>();
    snapshot->target = target;
    snapshot->elements = std::move(observed->refs);
    snapshot->at = GetTickCount64();
    result.set("snapshot_id", json::str(snapshots().add(std::move(snapshot))));
    return success(std::move(result));
}

// Click and scroll would need synthetic input, which this helper never makes; they answer
// unsupported_action before any other check and are no action.
Outcome control_act(const json::Value& params) {
    const std::string& action = params.get("action")->s;
    if (action == "click" || action == "scroll") {
        return failure("unsupported_action", action + " needs synthetic input, which the Windows helper does not send");
    }
    const json::Value* element_id = params.get("element_id");
    if (!element_id) return failure("element_required", action + " needs an element_id from the snapshot");
    const json::Value* text = params.get("text");
    bool press = action == "press";
    if (!press && (!text || text->s.size() > kMaxTextBytes)) {
        return failure("invalid_text", action + " needs a text of at most 4096 bytes");
    }
    std::lock_guard<std::mutex> hold(g_acting);
    // The wait comes before the checks, so that the action goes out on what they saw.
    int64_t last = g_last_action;
    int64_t wait = last ? last + std::chrono::nanoseconds(kActionGap).count() - steady_now() : 0;
    if (wait > 0) std::this_thread::sleep_for(std::chrono::nanoseconds(wait));
    std::shared_ptr<Snapshot> snapshot = snapshots().find(params.get("snapshot_id")->s);
    if (!snapshot) return stale();
    if (!uia::available()) return failure("internal", "UI Automation could not start");
    std::string id = element_id->s;
    std::wstring value = press ? std::wstring() : wide(text->s);
    auto out = std::make_shared<Outcome>();
    std::shared_ptr<Request> request = this_request();
    if (!uia::call(kActMs, snapshot->target.pid, [=](IUIAutomation* automation) {
            *out = act_on(automation, *snapshot, id, press, value, *request);
        })) {
        return late(false);
    }
    return *out;
}

Outcome control_read(const json::Value& params) {
    std::shared_ptr<Snapshot> snapshot = snapshots().find(params.get("snapshot_id")->s);
    if (!snapshot) return stale();
    if (!uia::available()) return failure("internal", "UI Automation could not start");
    std::string id = params.get("element_id")->s;
    auto out = std::make_shared<Outcome>();
    if (!uia::call(kReadMs, snapshot->target.pid, [=](IUIAutomation* automation) {
            *out = read_on(automation, *snapshot, id);
        })) {
        return late(true);
    }
    return *out;
}
