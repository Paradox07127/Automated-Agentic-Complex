// The ax.* ops of CONTRACT §7.4 that read other windows with UI Automation: ax.dialog_buttons, ax.overlays,
// ax.hit_chain and ax.window_text. Every UIA call runs on uia.cpp's thread; none reads the value of a password
// control. Coordinates are physical pixels of the virtual screen (§2.8).
#include "uia.h"

#include <cmath>
#include <cstdlib>
#include <cwchar>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace {

using uia::ComPtr;
using uia::elements;
using uia::Info;
using uia::Reads;

constexpr ULONGLONG kSliceMs = 1500;  // one ax.window_text page's walk, inside kTextMs
constexpr size_t kDefaultNodes = 2048, kWindowScalars = 6000, kFocusedScalars = 2000;
constexpr size_t kKeptWalks = 8;

RECT rect_param(const json::Value& r) {
    double x = r.get("x")->n, y = r.get("y")->n;
    return {std::lround(x), std::lround(y), std::lround(x + r.get("width")->n), std::lround(y + r.get("height")->n)};
}

// ---- ax.dialog_buttons, ax.overlays

// CONTRACT §7.4: the default (AutomationId 1) and cancel (2) buttons of the app's front window when it is modal or a
// Win32 dialog, else of a modal window inside it.
Outcome dialog_read(IUIAutomation* automation, DWORD pid) {
    Reads reads;
    reads.pid = pid;
    IUIAutomationCacheRequest* cache = uia::cache_request(automation);
    HWND hwnd = uia::front_window(pid);
    ComPtr<IUIAutomationElement> window, owner;
    if (hwnd && reads.ok(automation->ElementFromHandleBuildCache(hwnd, cache, &window)) && window) {
        Info w = uia::info(window.Get());
        if (w.modal || w.class_name == L"#32770") owner = window;
        ComPtr<IUIAutomationCondition> windows =
            uia::condition(automation, UIA_ControlTypePropertyId, UIA_WindowControlTypeId);
        ComPtr<IUIAutomationElementArray> children;
        if (!owner && windows &&
            reads.ok(window->FindAllBuildCache(TreeScope_Children, windows.Get(), cache, &children))) {
            for (const auto& child : elements(children.Get())) {
                if (!owner && uia::info(child.Get()).modal) owner = child;
            }
        }
    }
    json::Value buttons = json::array();
    for (const wchar_t* id : {L"1", L"2"}) {
        ComPtr<IUIAutomationCondition> button =
            uia::condition(automation, UIA_ControlTypePropertyId, UIA_ButtonControlTypeId);
        ComPtr<IUIAutomationCondition> named = uia::condition(automation, UIA_AutomationIdPropertyId, id), both;
        ComPtr<IUIAutomationElement> found;
        if (owner && button && named && SUCCEEDED(automation->CreateAndCondition(button.Get(), named.Get(), &both)) &&
            reads.ok(owner->FindFirstBuildCache(TreeScope_Descendants, both.Get(), cache, &found)) && found) {
            Info b = uia::info(found.Get());
            if (b.has_bounds) buttons.push(uia::rect(b.bounds));
        }
    }
    if (reads.timed_out) return uia::timeout();
    return success(uia::result_with("buttons", std::move(buttons)));
}

// Banners: the shell experience host's core windows on screen, where toasts show (what else it shows there opens at
// the user's click). IME: CONTRACT §7.4's candidate and prediction windows among the top-level elements and inside
// the text input host's windows.
Outcome overlays_read(IUIAutomation* automation) {
    Reads reads;
    IUIAutomationCacheRequest* cache = uia::cache_request(automation);
    json::Value banners = json::array(), ime = json::array();
    std::map<DWORD, std::wstring> exes;
    std::vector<HWND> input_hosts;
    for (const win32::Window& w : win32::screen_windows()) {
        auto exe = exes.find(w.pid);
        if (exe == exes.end()) exe = exes.emplace(w.pid, uia::exe_name(w.pid)).first;
        wchar_t type[64] = {};
        GetClassNameW(w.hwnd, type, 64);
        if (exe->second == L"shellexperiencehost.exe" && std::wcscmp(type, L"Windows.UI.Core.CoreWindow") == 0) {
            banners.push(uia::rect(w.bounds));
        }
        if (exe->second == L"textinputhost.exe") input_hosts.push_back(w.hwnd);
    }
    ComPtr<IUIAutomationCondition> candidate =
        uia::condition(automation, UIA_AutomationIdPropertyId, L"IME_Candidate_Window");
    ComPtr<IUIAutomationCondition> prediction =
        uia::condition(automation, UIA_AutomationIdPropertyId, L"IME_Prediction_Window"), either;
    ComPtr<IUIAutomationElement> root;
    auto add = [&](IUIAutomationElement* under, TreeScope scope) {
        ComPtr<IUIAutomationElementArray> found;
        if (!reads.ok(under->FindAllBuildCache(scope, either.Get(), cache, &found))) return;
        for (const auto& element : elements(found.Get())) {
            Info i = uia::info(element.Get());
            if (i.has_bounds && !i.offscreen) ime.push(uia::rect(i.bounds));
        }
    };
    if (candidate && prediction &&
        SUCCEEDED(automation->CreateOrCondition(candidate.Get(), prediction.Get(), &either)) &&
        reads.ok(automation->GetRootElement(&root)) && root) {
        add(root.Get(), TreeScope_Children);
        for (HWND host : input_hosts) {
            ComPtr<IUIAutomationElement> window;
            if (!reads.timed_out && reads.ok(automation->ElementFromHandleBuildCache(host, cache, &window)) && window) {
                add(window.Get(), TreeScope_Descendants);
            }
        }
    }
    if (reads.timed_out) return uia::timeout();
    json::Value result = json::object();
    result.set("banners", std::move(banners));
    result.set("ime", std::move(ime));
    return success(std::move(result));
}

// ---- ax.hit_chain

// The element at p inside the top-level window hwnd without asking what is in front of it: its deepest child window
// at p, then the deepest control-view element there.
ComPtr<IUIAutomationElement> descend(IUIAutomation* automation, HWND hwnd, POINT p, Reads& reads) {
    HWND at = hwnd;
    for (int depth = 0; depth < 16; ++depth) {
        POINT inside = p;
        ScreenToClient(at, &inside);
        HWND child = ChildWindowFromPointEx(at, inside, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
        if (!child || child == at) break;
        at = child;
    }
    IUIAutomationCacheRequest* cache = uia::cache_request(automation);
    ComPtr<IUIAutomationElement> element;
    ComPtr<IUIAutomationCondition> view;
    if (!reads.ok(automation->ElementFromHandleBuildCache(at, cache, &element)) || !element ||
        FAILED(automation->get_ControlViewCondition(&view))) {
        return element;
    }
    for (int depth = 0; depth < 24; ++depth) {
        ComPtr<IUIAutomationElementArray> children;
        ComPtr<IUIAutomationElement> hit;
        if (!reads.ok(element->FindAllBuildCache(TreeScope_Children, view.Get(), cache, &children))) break;
        for (const auto& child : elements(children.Get())) {
            Info i = uia::info(child.Get());
            if (!hit && i.has_bounds && !i.offscreen && PtInRect(&i.bounds, p)) hit = child;
        }
        if (!hit) break;
        element = hit;
    }
    return element;
}

// CONTRACT §7.4: the element at p and up to 3 ancestors, asked of the app whose window is under p.
Outcome hit_read(IUIAutomation* automation, HWND hwnd, DWORD pid, POINT p) {
    Reads reads;
    reads.pid = pid;
    ComPtr<IUIAutomationElement> element, root;
    HWND under = WindowFromPoint(p);
    if (under && GetAncestor(under, GA_ROOT) == hwnd) {
        if (!reads.ok(automation->ElementFromPointBuildCache(p, uia::cache_request(automation), &element))) {
            element.Reset();
        }
    } else {
        element = descend(automation, hwnd, p, reads);
    }
    json::Value chain = json::array();
    ComPtr<IUIAutomationTreeWalker> walker;
    if (element && SUCCEEDED(automation->get_ControlViewWalker(&walker)) &&
        SUCCEEDED(automation->GetRootElement(&root))) {
        for (int depth = 0; element && depth < 4; ++depth) {
            Info i = uia::info(element.Get());
            json::Value hit = json::object();
            hit.set("role", json::str(uia::role(i.type)));
            hit.set("native_role", json::str(uia::native_role(i.type)));
            hit.set("subrole", uia::subrole(i));
            hit.set("frame", uia::frame(i));
            chain.push(std::move(hit));
            ComPtr<IUIAutomationElement> parent;
            BOOL top = FALSE;
            if (depth == 3 ||
                !reads.ok(walker->GetParentElementBuildCache(element.Get(), uia::cache_request(automation), &parent)) ||
                !parent || FAILED(automation->CompareElements(parent.Get(), root.Get(), &top)) || top) {
                break;
            }
            element = parent;
        }
    }
    if (reads.timed_out) return uia::timeout();
    json::Value result = json::object();
    result.set("pid", json::integer(pid));
    result.set("chain", std::move(chain));
    return success(std::move(result));
}

// ---- ax.window_text

struct Node {
    int id = 0, parent = -1;
    CONTROLTYPEID type = 0;
    json::Value bounds;
    bool tiny = false;  // 1 px or less across: kept out of the text
    std::optional<std::string> label, description, value, selection;
};

struct TextParams {
    DWORD pid = 0;
    bool focused_level = false;
    std::optional<RECT> bounds, clip;
    std::optional<std::string> cursor;
    size_t max_nodes = 0, max_scalars = 0;
};

// One snapshot's breadth-first walk of one window; a cursor continues it.
struct Walk {
    std::string id, title;
    DWORD pid = 0;
    HWND hwnd = nullptr;
    bool focused_level = false, pinned = false, first = true, has_keep = false;
    RECT keep{};  // the window cut to the clip; nodes outside it are left out
    std::optional<Node> focused, rest;  // rest: the texts of a node the scalar budget cut, sent first on the next page
    std::deque<std::pair<ComPtr<IUIAutomationElement>, int>> queue;  // elements to write, with their parent's id
    int made = 0;
    bool complete() const { return queue.empty() && !rest; }
};

// UIA thread only: the walks kept for their cursors, oldest first.
std::deque<std::shared_ptr<Walk>> g_walks;
int g_snapshots = 0;

std::optional<std::string> text_of(const std::wstring& text) {
    if (text.empty()) return std::nullopt;
    return uia::utf8(text);
}

json::Value json_of(const std::optional<std::string>& text) { return text ? json::str(*text) : json::null(); }

bool is_text(CONTROLTYPEID type) {
    return type == UIA_TextControlTypeId || type == UIA_EditControlTypeId || type == UIA_DocumentControlTypeId;
}

// The texts of node that do not fit in budget scalars, as a node holding only those; budget shrinks by what fits.
std::optional<Node> fit(Node& node, size_t& budget) {
    Node left = node;
    bool cut = false;
    for (std::optional<std::string> Node::*field : {&Node::label, &Node::description, &Node::value}) {
        std::optional<std::string>& text = node.*field;
        (left.*field).reset();
        if (!text) continue;
        size_t count = uia::scalars(*text);
        if (count <= budget) {
            budget -= count;
            continue;
        }
        std::string kept = uia::first_scalars(*text, budget);
        left.*field = text->substr(kept.size());
        text = kept;
        budget = 0;
        cut = true;
    }
    return cut ? std::optional<Node>(left) : std::nullopt;
}

// The answer's text, as the Mac helper writes it: one line per label and visible text, without repeats.
class Lines {
public:
    explicit Lines(size_t limit) : remaining_(limit) {}

    void add(const char* label, const std::optional<std::string>& value) {
        if (!value || value->empty()) return;
        std::string line = std::string(label) + ": " + *value;
        if (seen_.count(line)) return;
        if (remaining_ == 0) {
            cut_ = true;
            return;
        }
        seen_.insert(line);
        std::string clipped = uia::first_scalars(line, remaining_);
        if (clipped.size() < line.size()) cut_ = true;
        size_t used = uia::scalars(clipped) + 1;
        remaining_ = used >= remaining_ ? 0 : remaining_ - used;
        text_ += (text_.empty() ? "" : "\n") + clipped;
    }

    void focused(const std::optional<Node>& node) {
        if (!node) return;
        add("焦点控件", uia::role(node->type));
        add("标签", node->label);
        add("说明", node->description);
        add("选中", node->selection);
    }

    const std::string& text() const { return text_; }
    bool cut() const { return cut_; }

private:
    size_t remaining_;
    std::set<std::string> seen_;
    std::string text_;
    bool cut_ = false;
};

// Text controls before the rest, each in walk order; a text control's help text is not written.
std::string summary(const std::optional<Node>& focused, const std::vector<Node>& nodes, size_t limit, bool& cut) {
    Lines lines(limit);
    lines.focused(focused);
    for (bool texts : {true, false}) {
        for (const Node& node : nodes) {
            if (is_text(node.type) != texts || node.tiny) continue;
            lines.add("标签", node.label);
            if (!texts && node.description != node.label) lines.add("说明", node.description);
            if (texts) lines.add("可见文字", node.value);
        }
    }
    cut = lines.cut();
    return lines.text();
}

Node make_node(IUIAutomationElement* element, const Info& i, int id, int parent, Reads& reads, bool& partial) {
    Node node;
    node.id = id;
    node.parent = parent;
    node.type = i.type;
    node.bounds = uia::frame(i);
    node.tiny = i.has_bounds && (i.bounds.right - i.bounds.left <= 1 || i.bounds.bottom - i.bounds.top <= 1);
    // A Text control's name is its visible text.
    (i.type == UIA_TextControlTypeId ? node.value : node.label) = text_of(i.name);
    node.description = text_of(i.help);
    if (i.type == UIA_EditControlTypeId || i.type == UIA_DocumentControlTypeId) {
        bool cut = false;
        json::Value value = uia::value_text(element, i, uia::kMaxTextUnits, reads, &cut);
        if (value.type == json::Type::Str) node.value = value.s;
        partial = partial || cut;
    }
    return node;
}

// The one on-screen window of pid within 2 px of target, else nullptr.
HWND matching_window(DWORD pid, const RECT& target) {
    HWND found = nullptr;
    int matches = 0;
    for (const win32::Window& w : win32::screen_windows()) {
        const RECT& b = w.bounds;
        if (w.pid == pid && std::abs(b.left - target.left) <= 2 && std::abs(b.top - target.top) <= 2 &&
            std::abs(b.right - target.right) <= 2 && std::abs(b.bottom - target.bottom) <= 2) {
            found = w.hwnd;
            ++matches;
        }
    }
    return matches == 1 ? found : nullptr;
}

// The window is still the one the walk started in: still open (pinned) or still in front, with the same title.
bool still_current(const Walk& walk) {
    return IsWindow(walk.hwnd) && (walk.pinned || uia::front_window(walk.pid) == walk.hwnd) &&
           uia::window_title(walk.hwnd) == walk.title;
}

std::shared_ptr<Walk> begin_walk(IUIAutomation* automation, IUIAutomationElement* window, HWND hwnd,
                                 const TextParams& p, Reads& reads) {
    auto walk = std::make_shared<Walk>();
    walk->id = "s-" + std::to_string(++g_snapshots);
    walk->pid = p.pid;
    walk->hwnd = hwnd;
    walk->focused_level = p.focused_level;
    walk->pinned = p.bounds.has_value();
    walk->title = uia::window_title(hwnd);
    Info w = uia::info(window);
    walk->has_keep = w.has_bounds || p.clip;
    if (w.has_bounds) walk->keep = w.bounds;
    if (p.clip && w.has_bounds) IntersectRect(&walk->keep, &w.bounds, &*p.clip);  // empty when they do not meet
    else if (p.clip) walk->keep = *p.clip;
    // The focused control is in this window only while the window has the foreground.
    HWND front = GetForegroundWindow();
    ComPtr<IUIAutomationElement> element;
    if (front && GetAncestor(front, GA_ROOT) == hwnd) element = uia::focused(automation, p.pid, reads);
    Info i = uia::info(element.Get());
    if (element && !i.password && (!i.has_bounds || !walk->has_keep || uia::intersects(walk->keep, i.bounds))) {
        Node node;
        node.type = i.type;
        node.label = text_of(i.name);
        node.description = text_of(i.help);
        json::Value selection = uia::selected_text(element.Get(), i, reads);
        if (selection.type == json::Type::Str) node.selection = selection.s;
        walk->focused = node;
    }
    if (!p.focused_level) walk->queue.emplace_back(ComPtr<IUIAutomationElement>(window), -1);
    return walk;
}

struct Page {
    std::optional<Node> focused;
    std::vector<Node> nodes;
    std::vector<std::string> reasons;
    bool timed_out_first = false;  // nothing was read: the app timed out at once
    bool cut = false;              // the scalar budget cut a node's text
};

Page next_page(IUIAutomation* automation, Walk& walk, const TextParams& p, Reads& reads) {
    Page page;
    ULONGLONG deadline = GetTickCount64() + kSliceMs;
    if (walk.first) page.focused = walk.focused;
    walk.first = false;
    size_t budget = p.max_scalars;
    bool unreadable = false, node_budget = false, cut = false;
    if (walk.rest) {
        Node left = *walk.rest;
        walk.rest = fit(left, budget);
        cut = walk.rest.has_value();
        page.nodes.push_back(std::move(left));
    }
    IUIAutomationCacheRequest* cache = uia::cache_request(automation);
    ComPtr<IUIAutomationCondition> view;
    if (FAILED(automation->get_ControlViewCondition(&view))) view.Reset();
    while (!walk.rest && !walk.queue.empty() && budget > 0 && GetTickCount64() < deadline && !reads.timed_out) {
        if (page.nodes.size() >= p.max_nodes) {
            node_budget = true;
            break;
        }
        auto entry = walk.queue.front();
        walk.queue.pop_front();
        Info i = uia::info(entry.first.Get());
        if (i.password || i.offscreen || (walk.has_keep && i.has_bounds && !uia::intersects(walk.keep, i.bounds))) {
            continue;
        }
        Node node = make_node(entry.first.Get(), i, walk.made, entry.second, reads, unreadable);
        if (reads.timed_out) {
            walk.queue.push_front(entry);
            break;
        }
        ++walk.made;
        walk.rest = fit(node, budget);
        cut = cut || walk.rest.has_value();
        int id = node.id;
        page.nodes.push_back(std::move(node));
        ComPtr<IUIAutomationElementArray> children;
        if (view && reads.ok(entry.first->FindAllBuildCache(TreeScope_Children, view.Get(), cache, &children))) {
            for (const auto& child : elements(children.Get())) walk.queue.emplace_back(child, id);
        } else {
            unreadable = true;
        }
    }
    page.timed_out_first = reads.timed_out && walk.made == 0 && page.nodes.empty() && !walk.focused_level;
    if (!walk.complete()) {
        page.reasons.push_back(node_budget ? "node_budget" : budget == 0 ? "char_budget" : "ax_time_slice");
    }
    page.cut = cut;
    if (unreadable) page.reasons.push_back("ax_unreadable_nodes_or_text");
    return page;
}

json::Value coverage(const char* scope, const std::vector<std::string>& reasons, size_t nodes, size_t chars) {
    bool partial = false;
    json::Value list = json::array();
    for (const std::string& reason : reasons) {
        partial = partial || reason != "cursor_reset";
        list.push(json::str(reason));
    }
    json::Value v = json::object();
    v.set("status", json::str(partial ? "partial" : nodes == 0 && chars == 0 ? "empty" : "complete"));
    v.set("scope", json::str(scope));
    v.set("reasons", std::move(list));
    v.set("captured_nodes", json::integer(static_cast<int64_t>(nodes)));
    v.set("captured_chars", json::integer(static_cast<int64_t>(chars)));
    return v;
}

Outcome text_answer(std::string snapshot, bool matched, std::string text, json::Value nodes, json::Value covered) {
    json::Value result = json::object();
    result.set("snapshot_id", json::str(std::move(snapshot)));
    result.set("matched", json::boolean(matched));
    result.set("text", json::str(std::move(text)));
    result.set("nodes", std::move(nodes));
    result.set("coverage", std::move(covered));
    return success(std::move(result));
}

// CONTRACT §7.4: a bounded projection of one window, page by page; the text is not redacted (the main process does).
Outcome text_read(IUIAutomation* automation, const TextParams& p) {
    Reads reads;
    reads.pid = p.pid;
    const char* scope = p.focused_level ? "focused_control" : "visible_window";
    std::vector<std::string> reasons;
    std::shared_ptr<Walk> walk;
    if (p.cursor) {
        for (auto k = g_walks.begin(); k != g_walks.end(); ++k) {
            if ((*k)->id != *p.cursor) continue;
            walk = *k;
            g_walks.erase(k);
            break;
        }
        if (walk && !(walk->pid == p.pid && walk->focused_level == p.focused_level && still_current(*walk))) {
            walk.reset();
        }
        if (!walk) reasons.push_back("cursor_reset");
    }
    if (!walk) {
        HWND hwnd = p.bounds ? matching_window(p.pid, *p.bounds) : uia::front_window(p.pid);
        if (!hwnd) {
            return text_answer("s-" + std::to_string(++g_snapshots), false, "", json::array(),
                               coverage(scope, reasons, 0, 0));
        }
        ComPtr<IUIAutomationElement> window;
        if (!reads.ok(automation->ElementFromHandleBuildCache(hwnd, uia::cache_request(automation), &window)) ||
            !window) {
            if (reads.timed_out) return uia::timeout();
            return failure("ax_unavailable", "the app does not answer UI Automation reads of its window");
        }
        walk = begin_walk(automation, window.Get(), hwnd, p, reads);
        if (reads.timed_out) return uia::timeout();
    }
    Page page = next_page(automation, *walk, p, reads);
    if (page.timed_out_first) return uia::timeout();
    reasons.insert(reasons.end(), page.reasons.begin(), page.reasons.end());
    bool cut = false;
    std::string text = p.focused_level ? summary(page.focused, {}, p.max_scalars, cut)
                                       : summary(page.focused, page.nodes, p.max_scalars, cut);
    bool counted = false;
    for (const std::string& reason : reasons) counted = counted || reason == "char_budget";
    if ((cut || page.cut) && !counted) reasons.push_back("char_budget");
    json::Value nodes = json::array();
    for (const Node& n : page.nodes) {
        json::Value v = json::object();
        v.set("id", json::integer(n.id));
        v.set("parent", json::integer(n.parent));
        v.set("role", json::str(uia::role(n.type)));
        v.set("native_role", json::str(uia::native_role(n.type)));
        v.set("label", json_of(n.label ? n.label : n.description));
        v.set("value", json_of(n.value));
        v.set("selection", json::null());
        v.set("bounds", n.bounds);
        nodes.push(std::move(v));
    }
    json::Value covered = coverage(scope, reasons, page.nodes.size(), uia::scalars(text));
    covered.set("next_cursor", walk->complete() ? json::null() : json::str(walk->id));
    if (!walk->complete()) {
        g_walks.push_back(walk);
        if (g_walks.size() > kKeptWalks) g_walks.pop_front();
    }
    return text_answer(walk->id, true, std::move(text), std::move(nodes), std::move(covered));
}

}  // namespace

Outcome ax_dialog_buttons(const json::Value& params) {
    DWORD pid = uia::live_pid(params.get("pid"));
    if (!pid) return uia::gone();
    if (uia::skipped(pid)) return uia::timeout();
    return uia::on_uia(uia::kProbeMs, pid, [pid](IUIAutomation* automation) { return dialog_read(automation, pid); });
}

Outcome ax_overlays(const json::Value&) {
    return uia::on_uia(uia::kProbeMs, 0, overlays_read);
}

Outcome ax_hit_chain(const json::Value& params) {
    const json::Value& point = *params.get("point");
    double x = point.get("x")->n, y = point.get("y")->n;
    std::set<int64_t> excluded;
    if (const json::Value* pids = params.get("exclude_pids")) {
        for (const json::Value& pid : pids->values) excluded.insert(pid.i);
    }
    for (const win32::Window& w : win32::screen_windows()) {
        if (excluded.count(w.pid) || w.alpha <= 0 || x < w.bounds.left || x >= w.bounds.right || y < w.bounds.top ||
            y >= w.bounds.bottom) {
            continue;
        }
        if (uia::skipped(w.pid)) return uia::timeout();
        HWND hwnd = w.hwnd;
        DWORD pid = w.pid;
        POINT p{std::lround(x), std::lround(y)};
        return uia::on_uia(uia::kProbeMs, pid, [hwnd, pid, p](IUIAutomation* automation) {
            return hit_read(automation, hwnd, pid, p);
        });
    }
    json::Value result = json::object();
    result.set("pid", json::null());
    result.set("chain", json::array());
    return success(std::move(result));
}

Outcome ax_window_text(const json::Value& params) {
    TextParams p;
    p.pid = uia::live_pid(params.get("pid"));
    if (!p.pid) return uia::gone();
    if (uia::skipped(p.pid)) return uia::timeout();
    p.focused_level = params.get("level")->s == "focused";
    if (const json::Value* bounds = params.get("window_bounds")) p.bounds = rect_param(*bounds);
    if (const json::Value* clip = params.get("clip")) p.clip = rect_param(*clip);
    if (const json::Value* cursor = params.get("cursor")) p.cursor = cursor->s;
    const json::Value* nodes = params.get("max_nodes");
    const json::Value* chars = params.get("max_scalars");
    p.max_nodes = nodes ? static_cast<size_t>(nodes->i) : kDefaultNodes;
    p.max_scalars = chars ? static_cast<size_t>(chars->i) : p.focused_level ? kFocusedScalars : kWindowScalars;
    return uia::on_uia(uia::kTextMs, p.pid, [p](IUIAutomation* automation) { return text_read(automation, p); });
}
