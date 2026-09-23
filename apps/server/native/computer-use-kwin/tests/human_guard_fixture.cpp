// The guards on the human's own windows, driven through the production code
// against modelled windows: activation is never borrowed in a client the
// human is typing in (a toolkit has one active window per application, so the
// borrow was a focus-out in theirs), a raise that would bury the window they
// are working in is refused, and no serial the agent minted can pass for the
// human's interaction when a client asks KWin for an activation token.
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using qint64 = int64_t;
using qsizetype = long long;
using uint = unsigned int;

struct ClientConnection {};
struct SurfaceInterface {
    ClientConnection* owner = nullptr;
    ClientConnection* client() const { return owner; }
};
struct RectF {
    double x = 0, y = 0, w = 0, h = 0;
    bool intersects(const RectF& o) const { return x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h; }
};
enum Layer { NormalLayer = 3, AboveLayer = 4 };
struct Window {
    std::string name;
    SurfaceInterface* s = nullptr;
    RectF frame;
    Layer l = NormalLayer;
    bool active = false, deleted = false, popup = false;
    Window* parent = nullptr;
    std::vector<std::string>* log = nullptr;
    SurfaceInterface* surface() const { return s; }
    bool isDeleted() const { return deleted; }
    bool isActive() const { return active; }
    void setActive(bool value) {
        active = value;
        if (log) log->push_back(name + (value ? " activated" : " deactivated"));
    }
    RectF frameGeometry() const { return frame; }
    Layer layer() const { return l; }
    bool isPopupWindow() const { return popup; }
    Window* transientFor() const { return parent; }
    bool hasTransient(const Window* w, bool) const {
        for (const Window* p = w ? w->parent : nullptr; p; p = p->parent)
            if (p == this) return true;
        return false;
    }
};
template <class T> struct QPointer {
    T* p = nullptr;
    QPointer() = default;
    QPointer(T* v) : p(v) {}
    QPointer& operator=(T* v) { p = v; return *this; }
    operator T*() const { return p; }
    T* operator->() const { return p; }
    void clear() { p = nullptr; }
};
template <class T> struct QList : std::vector<T> {
    using std::vector<T>::vector;
    qsizetype indexOf(const T& v) const {
        auto it = std::find(this->begin(), this->end(), v);
        return it == this->end() ? -1 : qsizetype(it - this->begin());
    }
};
struct Workspace {
    Window* active = nullptr;
    QList<Window*> stacking;
    Window* activeWindow() const { return active; }
    const QList<Window*>& stackingOrder() const { return stacking; }
    static Workspace* self() { static Workspace w; return &w; }
};
SurfaceInterface* humanKeyboardFocus = nullptr;
SurfaceInterface* humanKeyboardSurfaceInClientOf(const SurfaceInterface* surface) {
    return surface && humanKeyboardFocus && humanKeyboardFocus->client() == surface->client() ? humanKeyboardFocus : nullptr;
}

struct SynaraComputerUsePlugin {
    bool m_ownsCompositor = false;
    bool m_running = true;
    uint m_humanActiveGuardMs = 2000;
    qint64 humanAge = -1;
    Window* humanWindow = nullptr;
    QPointer<Window> m_activatedWindow;

    qint64 humanInputAgeMilliseconds() const { return humanAge; }
    Window* humanFocusWindow() const { return humanWindow; }

    bool humanKeyboardInSiblingOf(const Window* window) const;
    void updateWindowActivation(Window* window);
    void clearWindowActivation();
    const Window* humanWindowCoveredByRaise(const Window* window) const;
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        std::vector<std::string> log;
        ClientConnection browser, editor;
        SurfaceInterface agentTab{&browser}, humanTab{&browser}, editorSurface{&editor};
        Window agentWindow{"agent-window", &agentTab, {0, 0, 800, 600}};
        Window humanWindow{"human-window", &humanTab, {400, 300, 800, 600}};
        Window editorWindow{"editor", &editorSurface, {1300, 0, 300, 200}};
        agentWindow.log = humanWindow.log = editorWindow.log = &log;

        {
            // The human types in one browser window; the agent aims at another.
            SynaraComputerUsePlugin plugin;
            humanKeyboardFocus = &humanTab;
            Workspace::self()->active = &humanWindow;
            humanWindow.active = true;
            check(plugin.humanKeyboardInSiblingOf(&agentWindow), "a sibling window of the human's is recognised");
            check(!plugin.humanKeyboardInSiblingOf(&humanWindow), "their own window is not a sibling of itself");
            check(!plugin.humanKeyboardInSiblingOf(&editorWindow), "another application is not a sibling");
            plugin.updateWindowActivation(&agentWindow);
            check(log.empty() && !plugin.m_activatedWindow, "no activation is borrowed in the client they are typing in");
            plugin.updateWindowActivation(&editorWindow);
            check(log.size() == 1 && log[0] == "editor activated" && plugin.m_activatedWindow == &editorWindow, "another application still gets its borrow");

            // The human leaves the browser: the borrow is allowed again.
            humanKeyboardFocus = &editorSurface;
            log.clear();
            plugin.updateWindowActivation(&agentWindow);
            check(log.size() == 2 && log[0] == "editor deactivated" && log[1] == "agent-window activated", "the borrow moves once the human is elsewhere");

            // They come back into the browser while the borrow stands: it is
            // withdrawn on the next focus rather than re-asserted.
            humanKeyboardFocus = &humanTab;
            log.clear();
            plugin.updateWindowActivation(&agentWindow);
            check(log.size() == 1 && log[0] == "agent-window deactivated" && !plugin.m_activatedWindow, "a standing borrow is given back");
        }
        {
            SynaraComputerUsePlugin plugin;
            plugin.m_ownsCompositor = true;
            humanKeyboardFocus = &humanTab;
            check(!plugin.humanKeyboardInSiblingOf(&agentWindow), "a compositor the agent owns has no human to protect");
        }
        {
            // raiseWindow's guard.
            SynaraComputerUsePlugin plugin;
            Workspace::self()->stacking = {&agentWindow, &editorWindow, &humanWindow};
            plugin.humanWindow = &humanWindow;
            plugin.humanAge = 300;
            check(plugin.humanWindowCoveredByRaise(&agentWindow) == &humanWindow, "raising a window under theirs, where they overlap, would bury it");
            check(!plugin.humanWindowCoveredByRaise(&editorWindow), "a window that does not overlap theirs is free to rise");
            check(!plugin.humanWindowCoveredByRaise(&humanWindow), "raising their own window covers nothing");
            Workspace::self()->stacking = {&humanWindow, &agentWindow};
            check(!plugin.humanWindowCoveredByRaise(&agentWindow), "a window already above theirs changes nothing");
            Workspace::self()->stacking = {&agentWindow, &humanWindow};
            humanWindow.l = AboveLayer;
            check(!plugin.humanWindowCoveredByRaise(&agentWindow), "a window in a lower layer cannot rise past theirs");
            humanWindow.l = NormalLayer;
            plugin.humanAge = 5000;
            check(!plugin.humanWindowCoveredByRaise(&agentWindow), "an idle human is not in the way");
            plugin.humanAge = 300;
            Window dialog{"dialog", &humanTab, {100, 100, 300, 200}};
            dialog.parent = &agentWindow;
            Workspace::self()->stacking = {&agentWindow, &dialog};
            plugin.humanWindow = &dialog;
            check(!plugin.humanWindowCoveredByRaise(&agentWindow), "their dialog stays above the window that owns it");
            Window menu{"menu", &humanTab, {450, 350, 100, 100}};
            menu.popup = true;
            menu.parent = &humanWindow;
            Workspace::self()->stacking = {&agentWindow, &humanWindow, &menu};
            plugin.humanWindow = &menu;
            check(plugin.humanWindowCoveredByRaise(&agentWindow) == &humanWindow, "their open menu counts as the window that opened it");
        }
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "human guards: no borrowed activation beside the human's window, no raise over it.\n";
}
