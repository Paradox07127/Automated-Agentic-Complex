// The ax.* ops of CONTRACT §7.4 that read other windows with UI Automation: ax.dialog_buttons, ax.overlays,
// ax.hit_chain, ax.window_text and ax.window_tree; and browser.front_tab of §7.3. Every UIA call runs on uia.cpp's
// thread; none reads the value of a password control. Coordinates are physical pixels of the virtual screen (§2.8).
#include "uia.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <cwctype>
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
    std::optional<RECT> bounds;
    std::optional<std::string> cursor;
    size_t max_nodes = 0, max_scalars = 0;
};

// One snapshot's breadth-first walk of one window; a cursor continues it.
struct Walk {
    std::string id, title;
    DWORD pid = 0;
    HWND hwnd = nullptr;
    bool focused_level = false, pinned = false, first = true, has_keep = false;
    RECT keep{};  // the window's bounds; nodes outside it are left out
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
    walk->has_keep = w.has_bounds;
    if (w.has_bounds) walk->keep = w.bounds;
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

// ---- ax.window_tree

constexpr size_t kTreeLines = 800, kTreeScalars = 32000, kTreeValueScalars = 500, kKeptTrees = 8;
// Above this many old-by-new line pairs the changed middle is all - lines, then all + lines.
constexpr size_t kDiffCells = 4000000;
// After this much of the op's time the values are not asked for: the tree is answered truncated without them.
constexpr ULONGLONG kTreeValuesBy = 1000;

// One line: head is the role and the title, tail the value, the description and the states.
struct TreeLine {
    size_t depth = 0, id = 0;
    std::string head, tail;

    std::string text() const { return std::string(depth, '\t') + std::to_string(id) + " " + head + tail; }
    // The line without its number, which every line above an added or removed one shifts.
    std::string key() const { return std::to_string(depth) + '\x1f' + head + '\x1f' + tail; }
    // What a ~ line keeps.
    std::string place() const { return std::to_string(depth) + '\x1f' + head; }
};

struct TreeVersion {
    std::string id, window;
    std::vector<TreeLine> lines;
};

// UIA thread only: the versions previous can name, oldest first.
std::deque<TreeVersion> g_trees;
int g_tree_ids = 0;

// What one element gives its line; empty texts are none.
struct TreeNode {
    std::string role, title, description, value;
    bool selected = false, disabled = false, secure = false;
    int expanded = -1;                     // -1: no such state, else collapsed (0) or expanded (1)
    size_t first = 0, last = 0, total = 0;  // total > 0: only items first..last (from 1) of total are on screen
};

// AXStaticText -> static text.
std::string role_words(const std::string& role) {
    std::string name;
    char previous = 0;
    for (char c : role.compare(0, 2, "AX") == 0 ? role.substr(2) : role) {
        bool upper = c >= 'A' && c <= 'Z';
        if (upper && ((previous >= 'a' && previous <= 'z') || (previous >= '0' && previous <= '9'))) name += ' ';
        name += upper ? static_cast<char>(c - 'A' + 'a') : c;
        previous = c;
    }
    return name;
}

// One line per element: line breaks are written as \n, tabs as spaces.
std::string flat(const std::string& text) {
    std::string out;
    for (size_t k = 0; k < text.size(); ++k) {
        if (text[k] == '\r' || text[k] == '\n') {
            out += "\\n";
            if (text[k] == '\r' && k + 1 < text.size() && text[k + 1] == '\n') ++k;
        } else {
            out += text[k] == '\t' ? ' ' : text[k];
        }
    }
    return out;
}

bool value_role(const std::string& role) {
    static const std::set<std::string> roles = {"AXStaticText", "AXTextField", "AXTextArea", "AXComboBox",
                                                "AXCheckBox", "AXRadioButton", "AXPopUpButton"};
    return roles.count(role) > 0;
}

std::pair<std::string, std::string> describe(const TreeNode& node) {
    std::string head = role_words(node.role);
    const std::string& label = !node.title.empty() ? node.title : node.description;
    if (!label.empty()) head += " " + flat(label);
    std::string tail;
    if (!node.secure && value_role(node.role) && !node.value.empty()) {
        tail += ", Value: " + flat(uia::first_scalars(node.value, kTreeValueScalars));
    }
    if (!node.title.empty() && !node.description.empty() && node.description != node.title) {
        tail += ", Description: " + flat(node.description);
    }
    if (node.selected) tail += " (selected)";
    if (node.disabled) tail += " (disabled)";
    if (node.expanded >= 0) tail += node.expanded ? " (expanded)" : " (collapsed)";
    if (node.total) {
        tail += " (showing " + std::to_string(node.first) + "-" + std::to_string(node.last) + " of " +
                std::to_string(node.total) + " items)";
    }
    return {head, tail};
}

// A container with nothing of its own and one child gives no line; the child takes its place.
bool folds(const TreeNode& node, size_t children) {
    static const std::set<std::string> roles = {"AXGroup", "AXUnknown", "AXLayoutArea", "AXLayoutItem",
                                                "AXSplitGroup"};
    return children == 1 && roles.count(node.role) && node.title.empty() && node.description.empty() &&
           node.value.empty() && !node.selected && !node.disabled && node.expanded < 0 && !node.total;
}

bool cached_int(IUIAutomationElement* element, PROPERTYID property, int& out) {
    VARIANT value;
    VariantInit(&value);
    bool found = SUCCEEDED(element->GetCachedPropertyValue(property, &value)) && value.vt == VT_I4;
    if (found) out = value.lVal;
    VariantClear(&value);
    return found;
}

// False when the element does not support the property's pattern.
bool cached_bool(IUIAutomationElement* element, PROPERTYID property, bool& out) {
    VARIANT value;
    VariantInit(&value);
    bool found = SUCCEEDED(element->GetCachedPropertyValue(property, &value)) && value.vt == VT_BOOL;
    if (found) out = value.boolVal != VARIANT_FALSE;
    VariantClear(&value);
    return found;
}

std::string cached_text(IUIAutomationElement* element, PROPERTYID property) {
    VARIANT value;
    VariantInit(&value);
    std::string text;
    if (SUCCEEDED(element->GetCachedPropertyValue(property, &value)) && value.vt == VT_BSTR && value.bstrVal) {
        text = uia::utf8(std::wstring(value.bstrVal, SysStringLen(value.bstrVal)));
    }
    VariantClear(&value);
    return text;
}

std::string cached_key(IUIAutomationElement* element) {
    VARIANT value;
    VariantInit(&value);
    std::string key;
    if (SUCCEEDED(element->GetCachedPropertyValue(UIA_RuntimeIdPropertyId, &value)) &&
        value.vt == (VT_ARRAY | VT_I4)) {
        key = uia::runtime_key(value.parray);  // takes the array
        value.vt = VT_EMPTY;
    }
    VariantClear(&value);
    return key;
}

std::vector<ComPtr<IUIAutomationElement>> cached_children(IUIAutomationElement* element) {
    ComPtr<IUIAutomationElementArray> children;
    if (FAILED(element->GetCachedChildren(&children))) return {};
    return elements(children.Get());
}

bool text_control(CONTROLTYPEID type) {
    return type == UIA_EditControlTypeId || type == UIA_DocumentControlTypeId || type == UIA_ComboBoxControlTypeId;
}

// The element's line and the children to walk: a list's on-screen items only, when some are off screen. A Text
// control's name is its value, as AXStaticText's value is its text.
TreeNode tree_node(IUIAutomationElement* element, const std::map<std::string, std::string>& values,
                   std::vector<ComPtr<IUIAutomationElement>>& children) {
    TreeNode node;
    CONTROLTYPEID type = 0;
    element->get_CachedControlType(&type);
    node.role = uia::role(type);
    BOOL on = FALSE;
    node.secure = SUCCEEDED(element->get_CachedIsPassword(&on)) && on != FALSE;
    on = TRUE;
    node.disabled = SUCCEEDED(element->get_CachedIsEnabled(&on)) && on == FALSE;
    std::string name = cached_text(element, UIA_NamePropertyId);
    node.description = cached_text(element, UIA_HelpTextPropertyId);
    (type == UIA_TextControlTypeId ? node.value : node.title) = name;
    if (text_control(type) && !node.secure) {
        auto found = values.find(cached_key(element));
        if (found != values.end()) node.value = found->second;
    }
    int state = 0;
    bool selected = false;
    if (type == UIA_CheckBoxControlTypeId && cached_int(element, UIA_ToggleToggleStatePropertyId, state)) {
        node.value = std::to_string(state);
    }
    if (cached_bool(element, UIA_SelectionItemIsSelectedPropertyId, selected)) {
        // A radio button's or tab's selection is its value, as AppKit's.
        if (type == UIA_RadioButtonControlTypeId || type == UIA_TabItemControlTypeId) node.value = selected ? "1" : "0";
        else node.selected = selected;
    }
    if (cached_int(element, UIA_ExpandCollapseExpandCollapseStatePropertyId, state) &&
        state != ExpandCollapseState_LeafNode) {
        node.expanded = state == ExpandCollapseState_Collapsed ? 0 : 1;
    }
    children = cached_children(element);
    if (type == UIA_ListControlTypeId || type == UIA_TreeControlTypeId || type == UIA_DataGridControlTypeId ||
        type == UIA_TableControlTypeId) {
        std::vector<ComPtr<IUIAutomationElement>> shown;
        size_t first = 0;
        for (size_t k = 0; k < children.size(); ++k) {
            BOOL off = FALSE;
            if (SUCCEEDED(children[k]->get_CachedIsOffscreen(&off)) && off != FALSE) continue;
            if (shown.empty()) first = k;
            shown.push_back(children[k]);
        }
        if (!shown.empty() && shown.size() < children.size()) {
            node.first = first + 1;
            node.last = std::min(first + shown.size(), children.size());
            node.total = children.size();
            children = std::move(shown);
        }
    }
    return node;
}

// Whether the cached tree under root holds a text control that is no password.
bool has_text_controls(IUIAutomationElement* root) {
    std::vector<ComPtr<IUIAutomationElement>> stack = {ComPtr<IUIAutomationElement>(root)};
    while (!stack.empty()) {
        ComPtr<IUIAutomationElement> element = stack.back();
        stack.pop_back();
        CONTROLTYPEID type = 0;
        BOOL password = FALSE;
        element->get_CachedControlType(&type);
        if (text_control(type) && SUCCEEDED(element->get_CachedIsPassword(&password)) && password == FALSE) {
            return true;
        }
        for (const auto& child : cached_children(element.Get())) stack.push_back(child);
    }
    return false;
}

// The values of the text controls under root that are no password, by element key, in one more call: a password
// control's value is never asked for. False when UIA did not answer.
bool read_values(IUIAutomation* automation, IUIAutomationElement* root, Reads& reads,
                 std::map<std::string, std::string>& values) {
    ComPtr<IUIAutomationCacheRequest> cache;
    if (FAILED(automation->CreateCacheRequest(&cache))) return false;
    cache->AddProperty(UIA_RuntimeIdPropertyId);
    cache->AddProperty(UIA_ValueValuePropertyId);
    cache->put_AutomationElementMode(AutomationElementMode_None);
    VARIANT no, yes;
    VariantInit(&no);
    VariantInit(&yes);
    no.vt = yes.vt = VT_BOOL;
    no.boolVal = VARIANT_FALSE;
    yes.boolVal = VARIANT_TRUE;
    ComPtr<IUIAutomationCondition> plain = uia::condition(automation, UIA_IsPasswordPropertyId, no);
    ComPtr<IUIAutomationCondition> valued = uia::condition(automation, UIA_IsValuePatternAvailablePropertyId, yes);
    ComPtr<IUIAutomationCondition> edit = uia::condition(automation, UIA_ControlTypePropertyId, UIA_EditControlTypeId);
    ComPtr<IUIAutomationCondition> document =
        uia::condition(automation, UIA_ControlTypePropertyId, UIA_DocumentControlTypeId);
    ComPtr<IUIAutomationCondition> combo =
        uia::condition(automation, UIA_ControlTypePropertyId, UIA_ComboBoxControlTypeId);
    ComPtr<IUIAutomationCondition> either, all;
    if (!plain || !valued || !edit || !document || !combo) return false;
    IUIAutomationCondition* types[] = {edit.Get(), document.Get(), combo.Get()};
    if (FAILED(automation->CreateOrConditionFromNativeArray(types, 3, &either))) return false;
    IUIAutomationCondition* parts[] = {plain.Get(), valued.Get(), either.Get()};
    ComPtr<IUIAutomationElementArray> found;
    if (FAILED(automation->CreateAndConditionFromNativeArray(parts, 3, &all)) ||
        !reads.ok(root->FindAllBuildCache(TreeScope_Descendants, all.Get(), cache.Get(), &found))) {
        return false;
    }
    for (const auto& element : elements(found.Get())) {
        std::string key = cached_key(element.Get());
        if (!key.empty()) values[key] = cached_text(element.Get(), UIA_ValueValuePropertyId);
    }
    return true;
}

struct Walked {
    std::vector<TreeLine> lines;
    bool truncated = false, secure = false;
};

// Preorder from root. A line that does not fit max_scalars (each line with its newline) is left out.
Walked walk_tree(IUIAutomationElement* root, const std::map<std::string, std::string>& values, size_t max_lines,
                 size_t max_scalars) {
    Walked out;
    size_t used = 0;
    std::vector<std::pair<ComPtr<IUIAutomationElement>, size_t>> stack = {{ComPtr<IUIAutomationElement>(root), 0}};
    while (!stack.empty()) {
        if (out.lines.size() >= max_lines) {
            out.truncated = true;
            break;
        }
        auto entry = stack.back();
        stack.pop_back();
        std::vector<ComPtr<IUIAutomationElement>> children;
        TreeNode node = tree_node(entry.first.Get(), values, children);
        if (folds(node, children.size())) {
            stack.emplace_back(children[0], entry.second);
            continue;
        }
        std::pair<std::string, std::string> parts = describe(node);
        TreeLine line{entry.second, out.lines.size(), parts.first, parts.second};
        size_t cost = uia::scalars(line.text()) + 1;
        if (used + cost > max_scalars) {
            out.truncated = true;
            break;
        }
        used += cost;
        out.secure = out.secure || node.secure;
        out.lines.push_back(std::move(line));
        for (auto child = children.rbegin(); child != children.rend(); ++child) {
            stack.emplace_back(*child, entry.second + 1);
        }
    }
    return out;
}

// The index pairs of a longest common subsequence of a and b.
std::vector<std::pair<size_t, size_t>> common_lines(const std::vector<std::string>& a,
                                                    const std::vector<std::string>& b) {
    if (a.empty() || b.empty() || a.size() * b.size() > kDiffCells) return {};
    std::map<std::string, int> codes;
    std::vector<int> x, y;
    for (const std::string& key : a) x.push_back(codes.emplace(key, static_cast<int>(codes.size())).first->second);
    for (const std::string& key : b) {
        auto found = codes.find(key);
        y.push_back(found == codes.end() ? -1 : found->second);
    }
    size_t width = y.size() + 1;
    std::vector<int32_t> lengths((x.size() + 1) * width, 0);
    for (size_t i = x.size(); i-- > 0;) {
        for (size_t j = y.size(); j-- > 0;) {
            lengths[i * width + j] = x[i] == y[j] ? lengths[(i + 1) * width + j + 1] + 1
                                                  : std::max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
    }
    std::vector<std::pair<size_t, size_t>> pairs;
    for (size_t i = 0, j = 0; i < x.size() && j < y.size();) {
        if (x[i] == y[j]) {
            pairs.emplace_back(i++, j++);
        } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
            ++i;
        } else {
            ++j;
        }
    }
    return pairs;
}

// + added and - removed lines; a removed and an added line at the same place with the same depth, role and title are
// one ~ line with the new text. Unchanged lines are left out.
std::vector<std::string> diff(const std::vector<TreeLine>& old, const std::vector<TreeLine>& now) {
    size_t prefix = 0, suffix = 0;
    while (prefix < old.size() && prefix < now.size() && old[prefix].key() == now[prefix].key()) ++prefix;
    while (suffix < old.size() - prefix && suffix < now.size() - prefix &&
           old[old.size() - 1 - suffix].key() == now[now.size() - 1 - suffix].key()) {
        ++suffix;
    }
    std::vector<const TreeLine*> a, b;
    std::vector<std::string> a_keys, b_keys;
    for (size_t k = prefix; k < old.size() - suffix; ++k) {
        a.push_back(&old[k]);
        a_keys.push_back(old[k].key());
    }
    for (size_t k = prefix; k < now.size() - suffix; ++k) {
        b.push_back(&now[k]);
        b_keys.push_back(now[k].key());
    }
    std::vector<std::pair<size_t, size_t>> pairs = common_lines(a_keys, b_keys);
    pairs.emplace_back(a.size(), b.size());
    std::vector<std::string> out;
    size_t i = 0, j = 0;
    for (const auto& pair : pairs) {
        size_t gone = pair.first - i, came = pair.second - j;
        for (size_t k = 0; k < std::max(gone, came); ++k) {
            const TreeLine* was = k < gone ? a[i + k] : nullptr;
            const TreeLine* is = k < came ? b[j + k] : nullptr;
            if (was && is && was->place() == is->place()) {
                out.push_back("~" + is->text());
                continue;
            }
            if (was) out.push_back("-" + was->text());
            if (is) out.push_back("+" + is->text());
        }
        i = pair.first + 1;
        j = pair.second + 1;
    }
    return out;
}

json::Value tree_result(bool matched, std::string id, const char* mode, std::string text, size_t lines,
                        bool truncated, bool secure) {
    json::Value result = json::object();
    result.set("matched", json::boolean(matched));
    result.set("tree_id", json::str(std::move(id)));
    result.set("mode", json::str(mode));
    result.set("text", json::str(std::move(text)));
    result.set("lines", json::integer(static_cast<int64_t>(lines)));
    result.set("truncated", json::boolean(truncated));
    result.set("secure", json::boolean(secure));
    return result;
}

// Kept as a new version; against previous when it is a kept version of window and this walk was not truncated, whose
// unread lines a diff would give as removed.
Outcome tree_answer(Walked walked, const std::string& window, const std::optional<std::string>& previous) {
    std::string id = "t-" + std::to_string(++g_tree_ids);
    std::optional<std::vector<TreeLine>> old;
    for (const TreeVersion& version : g_trees) {
        if (previous && version.id == *previous && version.window == window) old = version.lines;
    }
    std::vector<std::string> text;
    const char* mode = "full";
    if (old && !walked.truncated) {
        text = diff(*old, walked.lines);
        mode = text.empty() ? "no_change" : "diff";
    } else {
        for (const TreeLine& line : walked.lines) text.push_back(line.text());
    }
    std::string joined;
    for (const std::string& line : text) joined += (joined.empty() ? "" : "\n") + line;
    size_t count = walked.lines.size();
    g_trees.push_back({id, window, std::move(walked.lines)});
    if (g_trees.size() > kKeptTrees) g_trees.pop_front();
    return success(tree_result(true, std::move(id), mode, std::move(joined), count, walked.truncated, walked.secure));
}

struct TreeParams {
    DWORD pid = 0;
    std::optional<RECT> bounds;
    std::optional<std::string> previous;
    size_t max_lines = kTreeLines, max_scalars = kTreeScalars;
};

// CONTRACT §7.4: one window's controls as text lines, read with one subtree cache request (and one more for the text
// controls' values); the text is not redacted (the main process does).
Outcome tree_read(IUIAutomation* automation, const TreeParams& p) {
    ULONGLONG started = GetTickCount64();
    Reads reads;
    reads.pid = p.pid;
    HWND hwnd = p.bounds ? matching_window(p.pid, *p.bounds) : uia::front_window(p.pid);
    if (!hwnd) return success(tree_result(false, "t-" + std::to_string(++g_tree_ids), "full", "", 0, false, false));
    ComPtr<IUIAutomationCacheRequest> cache;
    if (FAILED(automation->CreateCacheRequest(&cache))) return failure("internal", "cannot make a UIA cache request");
    cache->put_TreeScope(TreeScope_Subtree);
    for (PROPERTYID id : {UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_HelpTextPropertyId,
                          UIA_IsPasswordPropertyId, UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId,
                          UIA_RuntimeIdPropertyId, UIA_ToggleToggleStatePropertyId,
                          UIA_SelectionItemIsSelectedPropertyId, UIA_ExpandCollapseExpandCollapseStatePropertyId}) {
        cache->AddProperty(id);
    }
    ComPtr<IUIAutomationElement> root;
    if (!reads.ok(automation->ElementFromHandleBuildCache(hwnd, cache.Get(), &root)) || !root) {
        if (reads.timed_out) return uia::timeout();
        return failure("ax_unavailable", "the app does not answer UI Automation reads of its window");
    }
    std::map<std::string, std::string> values;
    bool unread = has_text_controls(root.Get()) &&
                  (GetTickCount64() - started > kTreeValuesBy || !read_values(automation, root.Get(), reads, values));
    Walked walked = walk_tree(root.Get(), values, p.max_lines, p.max_scalars);
    walked.truncated = walked.truncated || unread;
    std::string window = std::to_string(p.pid) + ":" + std::to_string(reinterpret_cast<uintptr_t>(hwnd));
    return tree_answer(std::move(walked), window, p.previous);
}

// ---- browser.front_tab

// The front-most window of the Chromium browser whose app id is exe: visible, uncloaked, unowned, of Chromium's
// window class and with a title; minimized counts.
HWND browser_window(const wchar_t* exe) {
    struct Search {
        const wchar_t* exe;
        std::map<DWORD, bool> theirs;
        HWND found;
    } search{exe, {}, nullptr};
    EnumWindows([](HWND hwnd, LPARAM into) -> BOOL {
        auto* s = reinterpret_cast<Search*>(into);
        wchar_t type[32] = {};
        if (!IsWindowVisible(hwnd) || win32::is_cloaked(hwnd) || GetWindow(hwnd, GW_OWNER) ||
            !GetClassNameW(hwnd, type, 32) || std::wcscmp(type, L"Chrome_WidgetWin_1") != 0 ||
            uia::window_title(hwnd).empty()) {
            return TRUE;
        }
        DWORD pid = win32::owner_pid(hwnd);
        auto known = s->theirs.find(pid);
        if (known == s->theirs.end()) {
            HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            std::wstring id = process ? win32::app_id_of(process, win32::base_name(win32::image_path(process)))
                                      : std::wstring();
            if (process) CloseHandle(process);
            known = s->theirs.emplace(pid, id == s->exe).first;
        }
        if (!known->second) return TRUE;
        s->found = hwnd;
        return FALSE;
    }, reinterpret_cast<LPARAM>(&search));
    return search.found;
}

// The lower-case host of a URL the address bar shows, scheme or not (Chromium leaves out http:// and https://);
// empty when the text is no URL with a host (a search being typed, about:blank).
std::wstring url_host(const std::wstring& shown) {
    size_t start = shown.find_first_not_of(L' '), end = shown.find_last_not_of(L' ');
    if (start == std::wstring::npos) return {};
    std::wstring text = shown.substr(start, end - start + 1);
    for (wchar_t c : text) {
        if (std::iswspace(c)) return {};
    }
    size_t colon = text.find(L':'), from = 0;
    bool scheme = colon != std::wstring::npos && colon > 0 && std::iswalpha(text[0]);
    for (size_t k = 0; scheme && k < colon; ++k) {
        wchar_t c = text[k];
        scheme = c < 0x80 && (std::iswalnum(c) || c == L'+' || c == L'-' || c == L'.');
    }
    if (scheme) {
        if (text.compare(colon, 3, L"://") != 0) return {};
        from = colon + 3;
    }
    std::wstring authority = text.substr(from, text.find_first_of(L"/?#", from) - from);
    size_t at = authority.rfind(L'@');
    if (at != std::wstring::npos) authority = authority.substr(at + 1);
    std::wstring host = authority;
    if (!authority.empty() && authority[0] == L'[') {
        size_t close = authority.find(L']');
        if (close == std::wstring::npos) return {};
        host = authority.substr(1, close - 1);
    } else {
        size_t port = authority.rfind(L':');
        if (port != std::wstring::npos) {
            for (size_t k = port + 1; k < authority.size(); ++k) {
                if (!std::iswdigit(authority[k])) return {};
            }
            host = authority.substr(0, port);
        }
        if (host.empty()) return {};
        // Without a scheme only a dotted name or localhost is an address, not one word of a search.
        bool dotted = host.find(L'.') != std::wstring::npos && host.front() != L'.' && host.back() != L'.';
        if (!scheme && !dotted && win32::lower(host) != L"localhost") return {};
        for (wchar_t c : host) {
            if (c < 0x80 && !std::iswalnum(c) && c != L'.' && c != L'-' && c != L'_') return {};
        }
    }
    return host.empty() ? host : win32::lower(host);
}

// What UIA reads of a browser window, found by Chromium's view class names, which no language changes: the root
// view's accessible name (the window title as Chromium announces it) and the address bar's text.
struct Tab {
    std::wstring name;
    std::optional<std::wstring> address;
};

void tab_read(IUIAutomation* automation, HWND hwnd, DWORD pid, Tab& tab) {
    Reads reads;
    reads.pid = pid;
    IUIAutomationCacheRequest* cache = uia::cache_request(automation);
    ComPtr<IUIAutomationElement> window, view, omnibox;
    ComPtr<IUIAutomationCacheRequest> value;
    ComPtr<IUIAutomationCondition> root = uia::condition(automation, UIA_ClassNamePropertyId, L"BrowserRootView");
    ComPtr<IUIAutomationCondition> address = uia::condition(automation, UIA_ClassNamePropertyId, L"OmniboxViewViews");
    if (!reads.ok(automation->ElementFromHandleBuildCache(hwnd, cache, &window)) || !window) return;
    if (root && reads.ok(window->FindFirstBuildCache(TreeScope_Children, root.Get(), cache, &view)) && view) {
        tab.name = uia::info(view.Get()).name;
    }
    if (reads.timed_out || !address || FAILED(automation->CreateCacheRequest(&value)) ||
        FAILED(value->AddProperty(UIA_ValueValuePropertyId)) ||
        !reads.ok(window->FindFirstBuildCache(TreeScope_Descendants, address.Get(), value.Get(), &omnibox)) ||
        !omnibox) {
        return;
    }
    VARIANT text;
    VariantInit(&text);
    if (SUCCEEDED(omnibox->GetCachedPropertyValue(UIA_ValueValuePropertyId, &text)) && text.vt == VT_BSTR &&
        text.bstrVal) {
        tab.address = std::wstring(text.bstrVal, SysStringLen(text.bstrVal));
    }
    VariantClear(&text);
}

// Whether the window is private. Edge writes InPrivate, a name it does not translate, into its title and its root
// view's name. Chrome adds a translated "(Incognito)" to its root view's name only: a name that is just the title is
// a normal window in any language, and one with more but not the English word is unknown (null).
json::Value private_window(bool edge, const std::wstring& title, const std::wstring& name) {
    if (edge) {
        return json::boolean(title.find(L"InPrivate") != std::wstring::npos ||
                             name.find(L"InPrivate") != std::wstring::npos);
    }
    if (name.find(L"Incognito") != std::wstring::npos) return json::boolean(true);
    if (!name.empty() && name == title) return json::boolean(false);
    return json::null();
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
    if (const json::Value* cursor = params.get("cursor")) p.cursor = cursor->s;
    const json::Value* nodes = params.get("max_nodes");
    const json::Value* chars = params.get("max_scalars");
    p.max_nodes = nodes ? static_cast<size_t>(nodes->i) : kDefaultNodes;
    p.max_scalars = chars ? static_cast<size_t>(chars->i) : p.focused_level ? kFocusedScalars : kWindowScalars;
    return uia::on_uia(uia::kTextMs, p.pid, [p](IUIAutomation* automation) { return text_read(automation, p); });
}

Outcome ax_window_tree(const json::Value& params) {
    TreeParams p;
    p.pid = uia::live_pid(params.get("pid"));
    if (!p.pid) return uia::gone();
    if (uia::skipped(p.pid)) return uia::timeout();
    if (const json::Value* bounds = params.get("window_bounds")) p.bounds = rect_param(*bounds);
    if (const json::Value* previous = params.get("previous")) p.previous = previous->s;
    if (const json::Value* lines = params.get("max_lines")) p.max_lines = static_cast<size_t>(lines->i);
    if (const json::Value* chars = params.get("max_scalars")) p.max_scalars = static_cast<size_t>(chars->i);
    return uia::on_uia(uia::kTreeMs, p.pid, [p](IUIAutomation* automation) { return tree_read(automation, p); });
}

// CONTRACT §7.3 for Windows: Chrome and Edge through UI Automation, which needs no permission; what cannot be read in
// time is null.
Outcome browser_front_tab(const json::Value& params) {
    const std::string& app = params.get("app_id")->s;
    json::Value result = json::object();
    result.set("url_host", json::null());
    result.set("incognito", json::null());
    bool edge = app == "msedge.exe";
    if (!edge && app != "chrome.exe") return success(std::move(result));
    HWND hwnd = browser_window(edge ? L"msedge.exe" : L"chrome.exe");
    if (!hwnd) return failure("process_gone", "the browser has no window");
    DWORD pid = win32::owner_pid(hwnd);
    if (uia::skipped(pid) || !uia::available()) return success(std::move(result));
    wchar_t title[1024] = {};
    int length = GetWindowTextW(hwnd, title, 1024);
    auto tab = std::make_shared<Tab>();
    if (!uia::call(uia::kTabMs, pid, [tab, hwnd, pid](IUIAutomation* automation) {
            tab_read(automation, hwnd, pid, *tab);
        })) {
        return success(std::move(result));
    }
    json::Value incognito =
        private_window(edge, std::wstring(title, length > 0 ? static_cast<size_t>(length) : 0), tab->name);
    result.set("incognito", incognito);
    std::wstring host = incognito.type == json::Type::Bool && !incognito.b && tab->address ? url_host(*tab->address)
                                                                                         : std::wstring();
    if (!host.empty()) result.set("url_host", json::str(uia::utf8(host)));
    return success(std::move(result));
}
