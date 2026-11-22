// The UIA thread and the reads the ax.* handlers share; ax.focused, ax.selected_text, and ax.watch with its event
// handlers and ax.notification (CONTRACT §7.4, §8).
#include "uia.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <exception>
#include <map>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace uia {
namespace {

constexpr HRESULT kUiaTimeout = static_cast<HRESULT>(0x80131505L);   // UIA_E_TIMEOUT
constexpr HRESULT kElementGone = static_cast<HRESULT>(0x80040201L);  // UIA_E_ELEMENTNOTAVAILABLE
// ConnectionTimeout and TransactionTimeout, under CONTRACT §5.3's 2000 ms.
constexpr DWORD kUiaTimeoutMs = 1000;
constexpr ULONGLONG kBackOffMs = 2000;
constexpr LONG kCaretMargin = 40;

struct Done {
    std::mutex lock;
    std::condition_variable finished;
    bool done = false, abandoned = false;
};

struct Task {
    std::function<void(IUIAutomation*)> work;
    std::shared_ptr<Done> done;  // null for posted work
};

std::mutex g_queue_lock;
std::condition_variable g_queue_ready;
std::deque<Task> g_queue;
std::once_flag g_once;
std::atomic<bool> g_available{false};
std::mutex g_skip_lock;
std::map<DWORD, ULONGLONG> g_skip_until;
// UIA thread only.
IUIAutomation* g_automation = nullptr;
IUIAutomationCacheRequest* g_cache = nullptr;

void thread_main(HANDLE started) {
    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (SUCCEEDED(com) && FAILED(CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER,
                                                  IID_PPV_ARGS(&g_automation))) &&
        FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&g_automation)))) {
        g_automation = nullptr;
    }
    ComPtr<IUIAutomation2> limits;
    if (g_automation && SUCCEEDED(g_automation->QueryInterface(IID_PPV_ARGS(&limits)))) {
        limits->put_ConnectionTimeout(kUiaTimeoutMs);
        limits->put_TransactionTimeout(kUiaTimeoutMs);
    }
    // Loads what UIA needs before the first op's limit starts; the desktop element answers without asking an app.
    ComPtr<IUIAutomationElement> desktop;
    if (g_automation && cache_request(g_automation)) g_automation->GetRootElementBuildCache(g_cache, &desktop);
    g_available = g_automation != nullptr;
    SetEvent(started);
    for (;;) {
        Task task;
        {
            std::unique_lock<std::mutex> hold(g_queue_lock);
            g_queue_ready.wait(hold, [] { return !g_queue.empty(); });
            task = std::move(g_queue.front());
            g_queue.pop_front();
        }
        if (task.done) {
            std::lock_guard<std::mutex> hold(task.done->lock);
            if (task.done->abandoned) continue;
        }
        try {
            task.work(g_automation);
        } catch (const std::exception&) {
        }
        if (task.done) {
            std::lock_guard<std::mutex> hold(task.done->lock);
            task.done->done = true;
            task.done->finished.notify_all();
        }
    }
}

void start() {
    std::call_once(g_once, [] {
        HANDLE started = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!started) return;
        try {
            std::thread(thread_main, started).detach();
            WaitForSingleObject(started, INFINITE);
        } catch (const std::exception&) {
        }
        CloseHandle(started);
    });
}

void enqueue(Task task) {
    {
        std::lock_guard<std::mutex> hold(g_queue_lock);
        g_queue.push_back(std::move(task));
    }
    g_queue_ready.notify_one();
}

// The first rectangle of a text range.
bool range_rect(IUIAutomationTextRange* range, Reads& reads, RECT& out) {
    SAFEARRAY* rects = nullptr;
    if (!reads.ok(range->GetBoundingRectangles(&rects)) || !rects) return false;
    LONG low = 0, high = -1;
    SafeArrayGetLBound(rects, 1, &low);
    SafeArrayGetUBound(rects, 1, &high);
    double v[4] = {};
    bool found = high - low + 1 >= 4;
    for (LONG k = 0; found && k < 4; ++k) {
        LONG at = low + k;
        found = SUCCEEDED(SafeArrayGetElement(rects, &at, &v[k]));
    }
    SafeArrayDestroy(rects);
    if (!found || v[3] <= 0) return false;
    out = {std::lround(v[0]), std::lround(v[1]), std::lround(v[0] + v[2]), std::lround(v[1] + v[3])};
    return true;
}

}  // namespace

bool call(DWORD limit_ms, DWORD pid, std::function<void(IUIAutomation*)> work) {
    start();
    if (!g_available) return false;
    auto done = std::make_shared<Done>();
    enqueue({std::move(work), done});
    std::unique_lock<std::mutex> hold(done->lock);
    if (done->finished.wait_for(hold, std::chrono::milliseconds(limit_ms), [&] { return done->done; })) return true;
    done->abandoned = true;
    if (pid) back_off(pid);
    return false;
}

void post(std::function<void(IUIAutomation*)> work) {
    start();
    if (g_available) enqueue({std::move(work), nullptr});
}

bool available() {
    start();
    return g_available;
}

bool skipped(DWORD pid) {
    std::lock_guard<std::mutex> hold(g_skip_lock);
    auto found = g_skip_until.find(pid);
    return found != g_skip_until.end() && found->second > GetTickCount64();
}

void back_off(DWORD pid) {
    std::lock_guard<std::mutex> hold(g_skip_lock);
    g_skip_until[pid] = GetTickCount64() + kBackOffMs;
}

bool Reads::ok(HRESULT hr) {
    if (SUCCEEDED(hr)) return true;
    if (hr == kUiaTimeout || hr == HRESULT_FROM_WIN32(ERROR_TIMEOUT)) {
        timed_out = true;
        if (pid) back_off(pid);
    } else if (hr != kElementGone) {
        failed = true;
    }
    return false;
}

IUIAutomationCacheRequest* cache_request(IUIAutomation* automation) {
    if (g_cache || FAILED(automation->CreateCacheRequest(&g_cache))) return g_cache;
    for (PROPERTYID id : {UIA_ControlTypePropertyId, UIA_BoundingRectanglePropertyId, UIA_IsPasswordPropertyId,
                          UIA_IsOffscreenPropertyId, UIA_ProcessIdPropertyId, UIA_NamePropertyId,
                          UIA_HelpTextPropertyId, UIA_ClassNamePropertyId, UIA_IsValuePatternAvailablePropertyId,
                          UIA_ValueIsReadOnlyPropertyId, UIA_WindowIsModalPropertyId}) {
        g_cache->AddProperty(id);
    }
    return g_cache;
}

ComPtr<IUIAutomationElement> focused(IUIAutomation* automation, DWORD pid, Reads& reads) {
    ComPtr<IUIAutomationElement> element, root;
    if (!reads.ok(automation->GetFocusedElementBuildCache(cache_request(automation), &element)) || !element) {
        return nullptr;
    }
    // With nothing focused UIA answers the desktop.
    BOOL desktop = FALSE;
    if (SUCCEEDED(automation->GetRootElement(&root)) && root &&
        SUCCEEDED(automation->CompareElements(element.Get(), root.Get(), &desktop)) && desktop) {
        return nullptr;
    }
    if (pid && info(element.Get()).pid != pid) return nullptr;
    return element;
}

ComPtr<IUIAutomationTextPattern> text_pattern(IUIAutomationElement* element, Reads& reads) {
    ComPtr<IUIAutomationTextPattern> pattern;
    if (!reads.ok(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern)))) pattern.Reset();
    return pattern;
}

json::Value selected_text(IUIAutomationElement* element, const Info& info, Reads& reads) {
    if (info.password) return json::null();
    ComPtr<IUIAutomationTextPattern> pattern = text_pattern(element, reads);
    ComPtr<IUIAutomationTextRangeArray> ranges;
    ComPtr<IUIAutomationTextRange> first;
    int count = 0;
    BSTR text = nullptr;
    if (!pattern || !reads.ok(pattern->GetSelection(&ranges)) || !ranges || FAILED(ranges->get_Length(&count)) ||
        count < 1 || !reads.ok(ranges->GetElement(0, &first)) || !first ||
        !reads.ok(first->GetText(kMaxTextUnits, &text))) {
        return json::null();
    }
    std::string selected = take(text);
    return selected.empty() ? json::null() : json::str(selected);
}

json::Value value_text(IUIAutomationElement* element, const Info& info, int max_units, Reads& reads, bool* cut) {
    if (info.password) return json::null();
    auto fit = [&](std::wstring text) {
        if (text.size() > static_cast<size_t>(max_units)) {
            text.resize(static_cast<size_t>(max_units));
            if (!text.empty() && IS_HIGH_SURROGATE(text.back())) text.pop_back();
            if (cut) *cut = true;
        }
        return json::str(utf8(text));
    };
    auto by_value = [&]() -> json::Value {
        ComPtr<IUIAutomationValuePattern> pattern;
        BSTR value = nullptr;
        if (!reads.ok(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&pattern))) || !pattern ||
            !reads.ok(pattern->get_CurrentValue(&value))) {
            return json::null();
        }
        return fit(take_wide(value));
    };
    auto by_text = [&]() -> json::Value {
        ComPtr<IUIAutomationTextPattern> pattern = text_pattern(element, reads);
        ComPtr<IUIAutomationTextRange> document;
        BSTR text = nullptr;
        if (!pattern || !reads.ok(pattern->get_DocumentRange(&document)) || !document ||
            !reads.ok(document->GetText(max_units + 1, &text))) {
            return json::null();
        }
        return fit(take_wide(text));
    };
    bool document = info.type == UIA_DocumentControlTypeId;
    json::Value first = document ? by_text() : by_value();
    if (first.type != json::Type::Null || reads.timed_out) return first;
    return document ? by_value() : by_text();
}

json::Value caret(IUIAutomationElement* element, const Info& info, Reads& reads) {
    if (info.password || !info.has_bounds) return json::null();
    ComPtr<IUIAutomationTextRange> at;
    ComPtr<IUIAutomationTextPattern2> two;
    BOOL active = FALSE;
    if (reads.ok(element->GetCurrentPatternAs(UIA_TextPattern2Id, IID_PPV_ARGS(&two))) && two &&
        !reads.ok(two->GetCaretRange(&active, &at))) {
        at.Reset();
    }
    if (!at && !reads.timed_out) {
        ComPtr<IUIAutomationTextPattern> pattern = text_pattern(element, reads);
        ComPtr<IUIAutomationTextRangeArray> ranges;
        ComPtr<IUIAutomationTextRange> first;
        int count = 0;
        if (pattern && reads.ok(pattern->GetSelection(&ranges)) && ranges && SUCCEEDED(ranges->get_Length(&count)) &&
            count > 0 && reads.ok(ranges->GetElement(0, &first)) && first && !reads.ok(first->Clone(&at))) {
            at.Reset();
        }
    }
    if (!at) return json::null();
    RECT r{};
    bool found = false;
    int moved = 0;
    // The selection's start, then the character after it, then the right edge of the one before it.
    if (reads.ok(at->MoveEndpointByRange(TextPatternRangeEndpoint_End, at.Get(), TextPatternRangeEndpoint_Start))) {
        found = range_rect(at.Get(), reads, r) ||
                (reads.ok(at->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 1, &moved)) &&
                 moved == 1 && range_rect(at.Get(), reads, r));
        if (!found && !reads.timed_out &&
            reads.ok(at->MoveEndpointByRange(TextPatternRangeEndpoint_End, at.Get(), TextPatternRangeEndpoint_Start)) &&
            reads.ok(at->MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1, &moved)) &&
            moved == -1 && range_rect(at.Get(), reads, r)) {
            r.left = r.right;
            found = true;
        }
    }
    RECT zone = {info.bounds.left - kCaretMargin, info.bounds.top - kCaretMargin, info.bounds.right + kCaretMargin,
                 info.bounds.bottom + kCaretMargin};
    if (!found || r.bottom - r.top < 4 || r.left < zone.left || r.top < zone.top || r.right > zone.right ||
        r.bottom > zone.bottom) {
        return json::null();
    }
    r.right = std::max(r.right, r.left + 2);
    return rect(r);
}

// ---- ax.watch

namespace {

enum Kind { kFocus, kWindow, kTitle, kValue, kSelection, kKinds };
const char* const kKindNames[kKinds] = {"focus", "window", "title", "value", "selection"};

// One watch id's subscription.
struct Watch {
    std::string id;  // "" is the default one
    DWORD pid = 0;
    bool kinds[kKinds] = {};
    bool selected = false;
    std::atomic<bool> live{false};     // its answer is out and it was not stopped
    std::atomic<bool> queued[kKinds];  // a read of that kind waits on the UIA thread
    // UIA thread only; remove_handlers drops the listener, which holds the Watch.
    ComPtr<IUIAutomationElement> root;
    ComPtr<IUnknown> listener;
    bool properties = false;
};

// CONTRACT §7.4 for Windows: the roles, the label, the value's length and the window title, the selection only when
// asked; no element_key, value or doc. A password control gives its roles and window title only.
json::Value element_json(IUIAutomation* automation, const Watch& watch) {
    Reads reads;
    reads.pid = watch.pid;
    ComPtr<IUIAutomationElement> element = focused(automation, watch.pid, reads);
    if (!element) return json::null();
    Info i = info(element.Get());
    json::Value v = json::object();
    v.set("role", json::str(role(i.type)));
    v.set("native_role", json::str(native_role(i.type)));
    v.set("subrole", subrole(i));
    std::wstring label = !i.name.empty() ? i.name : i.help;
    v.set("label", i.password || label.empty() ? json::null() : json::str(utf8(label)));
    bool cut = false;
    json::Value value = value_text(element.Get(), i, kMaxTextUnits, reads, &cut);
    bool counted = value.type == json::Type::Str && !cut;
    v.set("value_length", counted ? json::integer(static_cast<int64_t>(scalars(value.s))) : json::null());
    std::string title = window_title(front_window(watch.pid));
    v.set("window_title", title.empty() ? json::null() : json::str(title));
    if (watch.selected && !i.password) v.set("selected_text", selected_text(element.Get(), i, reads));
    return reads.timed_out ? json::null() : v;
}

class Listener : public IUIAutomationFocusChangedEventHandler,
                 public IUIAutomationEventHandler,
                 public IUIAutomationPropertyChangedEventHandler {
public:
    explicit Listener(std::shared_ptr<Watch> watch) : watch_(std::move(watch)) {}
    virtual ~Listener() = default;

    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG left = --refs_;
        if (!left) delete this;
        return left;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IUIAutomationFocusChangedEventHandler)) {
            *out = static_cast<IUIAutomationFocusChangedEventHandler*>(this);
        } else if (iid == __uuidof(IUIAutomationEventHandler)) {
            *out = static_cast<IUIAutomationEventHandler*>(this);
        } else if (iid == __uuidof(IUIAutomationPropertyChangedEventHandler)) {
            *out = static_cast<IUIAutomationPropertyChangedEventHandler*>(this);
        } else {
            *out = nullptr;
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE HandleFocusChangedEvent(IUIAutomationElement* sender) override {
        notify(sender, kFocus);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE HandleAutomationEvent(IUIAutomationElement* sender, EVENTID event) override {
        notify(sender, event == UIA_Window_WindowOpenedEventId ? kWindow : kSelection);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE HandlePropertyChangedEvent(IUIAutomationElement* sender, PROPERTYID property,
                                                         VARIANT) override {
        CONTROLTYPEID type = 0;
        if (property == UIA_ValueValuePropertyId) notify(sender, kValue);
        if (property == UIA_NamePropertyId && sender && SUCCEEDED(sender->get_CachedControlType(&type)) &&
            type == UIA_WindowControlTypeId) {
            notify(sender, kTitle);
        }
        return S_OK;
    }

private:
    // On a UIA event thread: reads only the sender's cache and queues the rest for the UIA thread, one read per kind.
    void notify(IUIAutomationElement* sender, int kind) {
        int pid = 0;
        if (!watch_->live || !watch_->kinds[kind] || !sender || FAILED(sender->get_CachedProcessId(&pid)) ||
            static_cast<DWORD>(pid) != watch_->pid || watch_->queued[kind].exchange(true)) {
            return;
        }
        std::shared_ptr<Watch> watch = watch_;
        post([watch, kind](IUIAutomation* automation) {
            watch->queued[kind] = false;
            if (!watch->live) return;
            json::Value data = json::object();
            data.set("pid", json::integer(watch->pid));
            data.set("notification", json::str(kKindNames[kind]));
            data.set("element", skipped(watch->pid) ? json::null() : element_json(automation, *watch));
            if (!watch->id.empty()) data.set("watch_id", json::str(watch->id));
            send_event("ax.notification", std::move(data), watch->live);
        });
    }

    std::atomic<ULONG> refs_{1};
    std::shared_ptr<Watch> watch_;
};

void remove_handlers(IUIAutomation* automation, Watch& watch) {
    ComPtr<IUIAutomationFocusChangedEventHandler> focus;
    ComPtr<IUIAutomationEventHandler> events;
    ComPtr<IUIAutomationPropertyChangedEventHandler> properties;
    if (!watch.listener || FAILED(watch.listener.As(&focus)) || FAILED(watch.listener.As(&events)) ||
        FAILED(watch.listener.As(&properties))) {
        return;
    }
    if (watch.kinds[kFocus]) automation->RemoveFocusChangedEventHandler(focus.Get());
    if (watch.kinds[kWindow]) {
        automation->RemoveAutomationEventHandler(UIA_Window_WindowOpenedEventId, watch.root.Get(), events.Get());
    }
    if (watch.kinds[kSelection]) {
        automation->RemoveAutomationEventHandler(UIA_Text_TextSelectionChangedEventId, watch.root.Get(), events.Get());
    }
    if (watch.properties) automation->RemovePropertyChangedEventHandler(watch.root.Get(), properties.Get());
    watch.listener.Reset();
    watch.root.Reset();
}

// Focus changes anywhere and the other kinds under the desktop; each handler keeps only pid's.
bool add_handlers(IUIAutomation* automation, const std::shared_ptr<Watch>& watch) {
    IUIAutomationCacheRequest* cache = cache_request(automation);
    if (!cache || FAILED(automation->GetRootElement(&watch->root)) || !watch->root) return false;
    Listener* listener = new Listener(watch);
    watch->listener.Attach(static_cast<IUIAutomationFocusChangedEventHandler*>(listener));
    bool ok = !watch->kinds[kFocus] || SUCCEEDED(automation->AddFocusChangedEventHandler(cache, listener));
    for (auto event : {std::make_pair(kWindow, UIA_Window_WindowOpenedEventId),
                       std::make_pair(kSelection, UIA_Text_TextSelectionChangedEventId)}) {
        if (ok && watch->kinds[event.first]) {
            ok = SUCCEEDED(automation->AddAutomationEventHandler(event.second, watch->root.Get(), TreeScope_Subtree,
                                                                 cache, listener));
        }
    }
    std::vector<PROPERTYID> ids;
    if (watch->kinds[kValue]) ids.push_back(UIA_ValueValuePropertyId);
    if (watch->kinds[kTitle]) ids.push_back(UIA_NamePropertyId);
    if (ok && !ids.empty()) {
        ok = SUCCEEDED(automation->AddPropertyChangedEventHandlerNativeArray(
            watch->root.Get(), TreeScope_Subtree, cache, listener, ids.data(), static_cast<int>(ids.size())));
        watch->properties = ok;
    }
    return ok;
}

// The handlers of a new subscription, registered; null when UIA refused them.
std::shared_ptr<Watch> subscribe(DWORD pid, const json::Value& notifications, bool read_selected_text, std::string id) {
    auto made = std::make_shared<Watch>();
    made->id = std::move(id);
    made->pid = pid;
    made->selected = read_selected_text;
    for (int k = 0; k < kKinds; ++k) made->queued[k] = false;
    for (const json::Value& name : notifications.values) {
        for (int k = 0; k < kKinds; ++k) made->kinds[k] = made->kinds[k] || name.s == kKindNames[k];
    }
    auto ok = std::make_shared<bool>(false);
    bool finished = call(kWatchMs, 0, [made, ok](IUIAutomation* automation) { *ok = add_handlers(automation, made); });
    if (finished && *ok) return made;
    // Queued after the registration, which may still run.
    post([made](IUIAutomation* automation) { remove_handlers(automation, *made); });
    return nullptr;
}

// No event of it is sent once this returns.
void unsubscribe(const std::shared_ptr<Watch>& watch) {
    watch->live = false;
    post([watch](IUIAutomation* automation) { remove_handlers(automation, *watch); });
}

std::mutex g_watch_lock;  // held through a whole ax.watch
std::map<std::string, std::shared_ptr<Watch>> g_watches;
// The subscription the answer on this op thread starts; Outcome::answered lets its events out.
thread_local std::shared_ptr<Watch> t_starting;

// ---- ax.focused, ax.selected_text

// CONTRACT §7.4: never the value; no app_pid on Windows.
Outcome focused_read(IUIAutomation* automation, DWORD pid) {
    Reads reads;
    reads.pid = pid;
    ComPtr<IUIAutomationElement> element = focused(automation, pid, reads);
    Info i = info(element.Get());
    if (element && !pid && skipped(i.pid)) return timeout();
    reads.pid = i.pid;
    json::Value focus = json::null();
    if (element && i.has_bounds && i.pid) {
        bool can_edit = editable(i);
        focus = json::object();
        focus.set("pid", json::integer(i.pid));
        focus.set("role", json::str(role(i.type)));
        focus.set("native_role", json::str(native_role(i.type)));
        focus.set("subrole", subrole(i));
        focus.set("frame", frame(i));
        focus.set("caret", can_edit ? caret(element.Get(), i, reads) : json::null());
        focus.set("editable", json::boolean(can_edit));
        focus.set("element_key", element_key(element.Get()));
    }
    if (reads.timed_out) return timeout();
    return success(result_with("focus", std::move(focus)));
}

Outcome selected_read(IUIAutomation* automation, DWORD pid) {
    Reads reads;
    reads.pid = pid;
    ComPtr<IUIAutomationElement> element = focused(automation, pid, reads);
    json::Value text = element ? selected_text(element.Get(), info(element.Get()), reads) : json::null();
    if (reads.timed_out) return timeout();
    return success(result_with("text", std::move(text)));
}

}  // namespace
}  // namespace uia

Outcome ax_focused(const json::Value& params) {
    const json::Value* asked = params.get("pid");
    DWORD pid = asked ? uia::live_pid(asked) : 0;
    if (asked && !pid) return success(uia::result_with("focus", json::null()));
    if (pid && uia::skipped(pid)) return uia::timeout();
    return uia::on_uia(uia::kProbeMs, pid, [pid](IUIAutomation* automation) {
        return uia::focused_read(automation, pid);
    });
}

// The selection of the focused control when pid owns it.
Outcome ax_selected_text(const json::Value& params) {
    DWORD pid = uia::live_pid(params.get("pid"));
    if (!pid) return success(uia::result_with("text", json::null()));
    if (uia::skipped(pid)) return uia::timeout();
    return uia::on_uia(uia::kProbeMs, pid, [pid](IUIAutomation* automation) {
        return uia::selected_read(automation, pid);
    });
}

// CONTRACT §7.4 for Windows: watch_id is honoured; read_value and manual_accessibility are accepted and do nothing.
Outcome ax_watch(const json::Value& params) {
    const json::Value* given = params.get("watch_id");
    if (given && (given->type != json::Type::Str || given->s.empty())) {
        return failure("bad_request", "ax.watch.params.watch_id not str+");
    }
    std::string id = given ? given->s : std::string();
    const json::Value* asked = params.get("pid");
    bool stop = asked->type == json::Type::Null;
    DWORD pid = stop ? 0 : uia::live_pid(asked);
    std::lock_guard<std::mutex> hold(uia::g_watch_lock);
    if (!stop && !pid) return uia::gone();
    if (!stop && !uia::available()) return failure("internal", "UI Automation could not start");
    auto old = uia::g_watches.find(id);
    if (old != uia::g_watches.end()) {
        uia::unsubscribe(old->second);
        uia::g_watches.erase(old);
    }
    json::Value result = json::object();
    result.set("watching", json::boolean(!stop));
    result.set("pid", stop ? json::null() : json::integer(pid));
    if (!id.empty()) result.set("watch_id", json::str(id));
    if (stop) return success(std::move(result));
    std::shared_ptr<uia::Watch> watch =
        uia::subscribe(pid, *params.get("notifications"), win32::flag(params, "read_selected_text"), id);
    if (!watch) return failure("internal", "UI Automation did not take the event handlers");
    uia::g_watches[id] = watch;
    uia::t_starting = watch;
    Outcome out = success(std::move(result));
    out.answered = [] {
        if (uia::t_starting) uia::t_starting->live = true;
        uia::t_starting.reset();
    };
    return out;
}
