// The direct-injection seat policy, driven through the production direct path
// against a model of what a Wayland client believes about its seat0 objects.
//
// A client keeps one "entered" surface per wl_pointer and per wl_keyboard,
// whichever surface the last enter named, and routes motion, button, key and
// modifiers events there. The model records exactly that, plus every event,
// so each scenario can assert both where the agent's events landed and what
// the object names once the agent is done with it.
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using quint32 = uint32_t;
using qint64 = int64_t;
using uint = unsigned int;
using QString = std::string;
#define QStringLiteral(literal) std::string(literal)
#define Q_DISABLE_COPY_MOVE(Class) \
    Class(const Class&) = delete; \
    Class& operator=(const Class&) = delete;

struct QPointF {
    double xv = 0, yv = 0;
    QPointF() = default;
    QPointF(double x, double y) : xv(x), yv(y) {}
    double x() const { return xv; }
    double y() const { return yv; }
};
struct QMatrix4x4 {
    double dx = 0, dy = 0;
    QPointF map(const QPointF& p) const { return {p.x() + dx, p.y() + dy}; }
};
template <class T> struct QPointer {
    T* p = nullptr;
    QPointer() = default;
    QPointer(T* v) : p(v) {}
    QPointer& operator=(T* v) { p = v; return *this; }
    operator T*() const { return p; }
    T* operator->() const { return p; }
    bool isNull() const { return !p; }
    void clear() { p = nullptr; }
};
template <class T> struct QList : std::vector<T> {
    using std::vector<T>::vector;
    bool contains(const T& v) const { return std::find(this->begin(), this->end(), v) != this->end(); }
    void append(const T& v) { this->push_back(v); }
    void removeOne(const T& v) {
        auto it = std::find(this->begin(), this->end(), v);
        if (it != this->end()) this->erase(it);
    }
    bool isEmpty() const { return this->empty(); }
};
template <class T> struct QSet : std::set<T> {
    void remove(const T& v) { this->erase(v); }
    bool isEmpty() const { return this->empty(); }
    QList<T> values() const { return QList<T>(this->begin(), this->end()); }
    bool contains(const T& v) const { return this->count(v) != 0; }
};

// ---- the wire, as the client sees it -------------------------------------
struct ClientConnection;
struct SurfaceInterface;
struct wl_resource {
    ClientConnection* client = nullptr;
    SurfaceInterface* surface = nullptr;
    int version = 9;
};
int wl_resource_get_version(wl_resource* r) { return r->version; }
int wl_fixed_from_double(double d) { return int(d * 256); }
struct wl_array { std::vector<quint32> keys; };
void wl_array_init(wl_array*) {}
void wl_array_release(wl_array*) {}
void* wl_array_add(wl_array* a, size_t) { a->keys.push_back(0); return &a->keys.back(); }
constexpr int WL_POINTER_FRAME_SINCE_VERSION = 5;
constexpr quint32 WL_POINTER_BUTTON_STATE_RELEASED = 0, WL_POINTER_BUTTON_STATE_PRESSED = 1;
constexpr quint32 WL_KEYBOARD_KEY_STATE_RELEASED = 0, WL_KEYBOARD_KEY_STATE_PRESSED = 1;

struct Modifiers { quint32 depressed = 0, latched = 0, locked = 0, group = 0; bool operator==(const Modifiers&) const = default; };
struct Event {
    std::string kind;
    SurfaceInterface* surface = nullptr;   // named by enter/leave
    SurfaceInterface* entered = nullptr;   // what the object believed when a routed event arrived
    quint32 serial = 0;
    quint32 code = 0;
    bool pressed = false;
    std::vector<quint32> keys;
    Modifiers mods;
    double x = 0, y = 0;
};
struct ClientConnection {
    std::string name;
    SurfaceInterface* pointerEntered = nullptr;
    SurfaceInterface* keyboardEntered = nullptr;
    Modifiers mods;
    std::vector<Event> pointerLog, keyboardLog;
    wl_resource pointer{this, nullptr}, keyboard{this, nullptr};
    explicit ClientConnection(std::string n) : name(std::move(n)) {}
};
struct SurfaceInterface {
    ClientConnection* c;
    std::string name;
    wl_resource res;
    SurfaceInterface(ClientConnection* client, std::string n) : c(client), name(std::move(n)), res{client, this} {}
    ClientConnection* client() const { return c; }
    wl_resource* resource() { return &res; }
    std::pair<SurfaceInterface*, QPointF> mapToInputSurface(const QPointF& p) { return {this, p}; }
    QPointF toSurfaceLocal(const QPointF& p) const { return p; }
    QPointF mapToChild(SurfaceInterface*, const QPointF& p) const { return p; }
};

Event event(const std::string& kind, SurfaceInterface* surface, SurfaceInterface* entered, quint32 serial = 0) {
    Event e;
    e.kind = kind;
    e.surface = surface;
    e.entered = entered;
    e.serial = serial;
    return e;
}
void wl_pointer_send_enter(wl_resource* r, quint32 serial, wl_resource* s, int x, int y) {
    r->client->pointerEntered = s->surface;
    Event e = event("enter", s->surface, s->surface, serial);
    e.x = x / 256.0;
    e.y = y / 256.0;
    r->client->pointerLog.push_back(e);
}
void wl_pointer_send_leave(wl_resource* r, quint32 serial, wl_resource* s) {
    r->client->pointerLog.push_back(event("leave", s->surface, r->client->pointerEntered, serial));
    if (r->client->pointerEntered == s->surface) r->client->pointerEntered = nullptr;
}
void wl_pointer_send_motion(wl_resource* r, quint32, int x, int y) {
    Event e = event("motion", nullptr, r->client->pointerEntered);
    e.x = x / 256.0;
    e.y = y / 256.0;
    r->client->pointerLog.push_back(e);
}
void wl_pointer_send_button(wl_resource* r, quint32 serial, quint32, quint32 code, quint32 state) {
    Event e = event("button", nullptr, r->client->pointerEntered, serial);
    e.code = code;
    e.pressed = state == WL_POINTER_BUTTON_STATE_PRESSED;
    r->client->pointerLog.push_back(e);
}
void wl_pointer_send_frame(wl_resource*) {}
void wl_keyboard_send_enter(wl_resource* r, quint32 serial, wl_resource* s, wl_array* keys) {
    r->client->keyboardEntered = s->surface;
    Event e = event("enter", s->surface, s->surface, serial);
    e.keys = keys->keys;
    r->client->keyboardLog.push_back(e);
}
void wl_keyboard_send_leave(wl_resource* r, quint32 serial, wl_resource* s) {
    r->client->keyboardLog.push_back(event("leave", s->surface, r->client->keyboardEntered, serial));
    if (r->client->keyboardEntered == s->surface) r->client->keyboardEntered = nullptr;
}
void wl_keyboard_send_key(wl_resource* r, quint32 serial, quint32, quint32 key, quint32 state) {
    Event e = event("key", nullptr, r->client->keyboardEntered, serial);
    e.code = key;
    e.pressed = state == WL_KEYBOARD_KEY_STATE_PRESSED;
    r->client->keyboardLog.push_back(e);
}
void wl_keyboard_send_modifiers(wl_resource* r, quint32 serial, quint32 d, quint32 l, quint32 lk, quint32 g) {
    r->client->mods = {d, l, lk, g};
    Event e = event("modifiers", nullptr, r->client->keyboardEntered, serial);
    e.mods = {d, l, lk, g};
    r->client->keyboardLog.push_back(e);
}

// ---- the compositor, as the plugin sees it -------------------------------
enum class PointerButtonState { Pressed, Released };
enum class KeyboardKeyState { Pressed, Released };
struct PointerInterface {
    SurfaceInterface* focus = nullptr;
    quint32 serial = 0;
    SurfaceInterface* focusedSurface() const { return focus; }
    quint32 focusedSerial() const { return serial; }
};
struct KeyboardInterface {
    SurfaceInterface* focus = nullptr;
    SurfaceInterface* focusedSurface() const { return focus; }
    // KWin's per-client path: every seat0 keyboard of the client, unconditionally.
    void sendModifiers(quint32 d, quint32 l, quint32 lk, quint32 g, ClientConnection* client) {
        client->mods = {d, l, lk, g};
        Event e = event("human-modifiers", nullptr, client->keyboardEntered);
        e.mods = {d, l, lk, g};
        client->keyboardLog.push_back(e);
    }
};
struct SeatInterface {
    PointerInterface pointerObject;
    KeyboardInterface keyboardObject;
    QPointF pos;
    QMatrix4x4 transformation;
    PointerInterface* pointer() { return &pointerObject; }
    KeyboardInterface* keyboard() { return &keyboardObject; }
    SurfaceInterface* focusedPointerSurface() const { return pointerObject.focus; }
    SurfaceInterface* focusedKeyboardSurface() const { return keyboardObject.focus; }
    QPointF pointerPos() const { return pos; }
    QMatrix4x4 focusedPointerSurfaceTransformation() const { return transformation; }
    // The agent seat's side, never reached: every scenario drives the direct path.
    void notifyPointerEnter(SurfaceInterface*, const QPointF&, const QMatrix4x4&) { throw std::runtime_error("agent seat used"); }
    void notifyPointerMotion(const QPointF&) { throw std::runtime_error("agent seat used"); }
    void notifyPointerButton(quint32, PointerButtonState) { throw std::runtime_error("agent seat used"); }
    void notifyPointerFrame() {}
    void notifyPointerLeave() {}
    void notifyKeyboardKey(quint32, KeyboardKeyState, uint32_t) { throw std::runtime_error("agent seat used"); }
    void notifyKeyboardModifiers(quint32, quint32, quint32, quint32) {}
    void setFocusedKeyboardSurface(SurfaceInterface*, const QList<quint32>& = {}) {}
};
struct Display {
    quint32 serial = 1000;
    quint32 nextSerial() { return ++serial; }
};
struct WaylandServer {
    SeatInterface seat0;
    Display displayObject;
    SeatInterface* seat() { return &seat0; }
    Display* display() { return &displayObject; }
};
WaylandServer server;
WaylandServer* waylandServer() { return &server; }

struct ModifierState { uint32_t depressed = 0, latched = 0, locked = 0; };
struct xkb_state { uint32_t depressed = 0, latched = 0, locked = 0, group = 0; };
struct Xkb {
    ModifierState mods;
    quint32 layout = 0;
    xkb_state stateObject;
    const ModifierState& modifierState() const { return mods; }
    quint32 currentLayout() const { return layout; }
    xkb_state* state() { return &stateObject; }
};
struct KeyboardInputRedirection {
    Xkb xkbObject;
    QList<uint32_t> held;
    Xkb* xkb() { return &xkbObject; }
    QList<uint32_t> unfilteredKeys() const { return held; }
};
struct InputRedirection {
    KeyboardInputRedirection keyboardObject;
    KeyboardInputRedirection* keyboard() { return &keyboardObject; }
};
InputRedirection inputObject;
InputRedirection* input() { return &inputObject; }

enum { XKB_STATE_MODS_DEPRESSED, XKB_STATE_MODS_LATCHED, XKB_STATE_MODS_LOCKED, XKB_STATE_LAYOUT_EFFECTIVE };
enum { XKB_KEY_UP, XKB_KEY_DOWN };
constexpr uint32_t CAPS_MASK = 2, CONTROL_MASK = 4;
constexpr quint32 KEY_LEFTCTRL = 29, KEY_A = 30, BTN_LEFT = 272;
uint32_t xkb_state_serialize_mods(xkb_state* s, int component) {
    switch (component) {
    case XKB_STATE_MODS_DEPRESSED: return s->depressed;
    case XKB_STATE_MODS_LATCHED: return s->latched;
    default: return s->locked;
    }
}
uint32_t xkb_state_serialize_layout(xkb_state* s, int) { return s->group; }
void xkb_state_update_key(xkb_state* s, uint32_t key, int direction) {
    if (key != KEY_LEFTCTRL + 8) return;
    if (direction == XKB_KEY_DOWN) s->depressed |= CONTROL_MASK;
    else s->depressed &= ~CONTROL_MASK;
}

struct Window {
    SurfaceInterface* s;
    QMatrix4x4 t;
    SurfaceInterface* surface() const { return s; }
    QMatrix4x4 inputTransformation() const { return t; }
    bool hitTest(const QPointF&) const { return true; }
    bool isPopupWindow() const { return false; }
    Window* transientFor() const { return nullptr; }
};
struct InputDevice {
    void sendButton(quint32, bool) {}
    void sendKey(quint32, bool) {}
};

// The plumbing the direct path is built on, supplied by the fixture.
quint32 nextDirectSerial() { return server.displayObject.nextSerial(); }
quint32 directTimestampMs() { return 1; }
QList<wl_resource*> clientInputResources(const SurfaceInterface* surface, const char* klass) {
    ClientConnection* client = surface->client();
    return {std::string(klass) == "wl_pointer" ? &client->pointer : &client->keyboard};
}
// The rest of the plugin's seat-policy surface the fixture drives directly.
struct SynaraComputerUsePlugin;

struct SynaraComputerUsePlugin {
    enum class InputKind { Pointer, Keyboard };
    enum class HumanConflict { None, FocusedWindow, SharedClient };
    class DirectInjectionScope;

    bool m_ownsCompositor = false;
    bool m_pointerDirect = false, m_keyboardDirect = false;
    bool m_targetRequested = false;
    QPointF m_pos;
    QPointer<Window> m_pointerWindow, m_keyboardWindow, m_targetWindow;
    QPointer<SurfaceInterface> m_directPointerSurface, m_directKeyboardSurface;
    QPointer<PointerInterface> m_watchedHumanPointer;
    QPointer<SurfaceInterface> m_humanPointerFocus;
    QSet<quint32> m_pressedButtons;
    QList<quint32> m_pressedKeys;
    double m_directAxisRemainderH = 0, m_directAxisRemainderV = 0;
    int m_directInjectionDepth = 0;
    SeatInterface* m_seat = nullptr;
    xkb_state agentXkb;
    xkb_state* m_xkbState = &agentXkb;
    InputDevice* m_inputDevice = nullptr;
    uint m_humanActiveGuardMs = 2000;
    qint64 humanPointerAge = -1, humanKeyboardAge = -1;
    Window* humanWindow = nullptr;
    Window* hitWindow = nullptr;

    bool inputReady() const { return true; }
    void setTimestampNow() {}
    void syncModifiers() {}
    void clearWindowActivation() {}
    qint64 humanInputAgeMilliseconds() const {
        if (humanPointerAge < 0) return humanKeyboardAge;
        return humanKeyboardAge < 0 ? humanPointerAge : std::min(humanPointerAge, humanKeyboardAge);
    }
    qint64 humanPointerAgeMilliseconds() const { return humanPointerAge; }
    qint64 humanKeyboardAgeMilliseconds() const { return humanKeyboardAge; }
    Window* humanFocusWindow() const { return humanWindow; }
    bool popupInTransientTree(const Window*, const Window*) const { return false; }
    Window* windowAt(const QPointF&, InputKind) const { return hitWindow; }
    Window* popupTransientAt(const Window*, const QPointF&) const { return nullptr; }
    bool pointerUsableWindow(const Window* w) const { return w != nullptr; }
    bool usePointerDirectInjection(const Window*) const { return true; }

    void sendButton(quint32 code, bool pressed);
    void sendKey(quint32 keyCode, bool pressed);
    void releasePressedButtons();
    void releasePressedKeys();
    void clearPointerDelivery();
    void clearKeyboardDelivery();
    void clearKeyboardFocus();
    bool updatePointerFocus();
    void directPointerEnter(Window* window);
    void directPointerLeave();
    bool ensureDirectPointerEnter();
    void directPointerButton(quint32 code, bool pressed);
    void directKeyboardEnter(Window* window);
    void directKeyboardLeave();
    bool ensureDirectKeyboardEnter();
    void directKeyboardKey(quint32 keyCode, bool pressed);
    void directKeyboardModifiers();
    void sendHumanKeyboardModifiers(SurfaceInterface* surface);
    void restoreHumanDelivery();
    void handleHumanPointerInput();
    void handleHumanKeyboardInput();
    void handleHumanPointerFocusChanged();
    void handleHumanKeyboardFocusAboutToChange(SurfaceInterface* nextSurface);
    HumanConflict humanConflict(const Window* window, bool directInjection, InputKind kind, const Window** humanWindow) const;
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

std::vector<std::string> kinds(const std::vector<Event>& log, size_t from = 0) {
    std::vector<std::string> out;
    for (size_t i = from; i < log.size(); ++i) {
        const Event& e = log[i];
        std::string kind = e.kind;
        if (e.surface) kind += "(" + e.surface->name + ")";
        if (e.kind == "button" || e.kind == "key") kind += e.pressed ? "+" : "-";
        out.push_back(kind);
    }
    return out;
}

std::string join(const std::vector<std::string>& v) {
    std::string out;
    for (const auto& s : v) out += (out.empty() ? "" : " ") + s;
    return out;
}

void expectSequence(const std::vector<Event>& log, size_t from, const std::vector<std::string>& expected, const char* scenario) {
    const auto actual = kinds(log, from);
    if (actual != expected) throw std::runtime_error(std::string(scenario) + ": expected [" + join(expected) + "] got [" + join(actual) + "]");
}

const Event& find(const std::vector<Event>& log, const std::string& kind, bool pressed) {
    for (const Event& e : log) if (e.kind == kind && e.pressed == pressed) return e;
    throw std::runtime_error("missing " + kind);
}

struct Desk {
    ClientConnection X{"X"}, Y{"Y"};
    SurfaceInterface A{&X, "A"}, B{&X, "B"}, C{&Y, "C"};
    Window winB{&B, {}};
    SynaraComputerUsePlugin plugin;
    Desk() {
        server = WaylandServer{};
        inputObject = InputRedirection{};
        plugin.m_pos = {50, 60};
        plugin.m_watchedHumanPointer = &server.seat0.pointerObject;
    }
    void humanPointerOn(SurfaceInterface* s, quint32 serial) {
        server.seat0.pointerObject.focus = s;
        server.seat0.pointerObject.serial = serial;
        server.seat0.pos = {10, 10};
        if (s) s->client()->pointerEntered = s;
        plugin.m_humanPointerFocus = s;
    }
    void humanKeyboardOn(SurfaceInterface* s) {
        server.seat0.keyboardObject.focus = s;
        if (s) s->client()->keyboardEntered = s;
    }
};

void pointerSharedSibling() {
    Desk d;
    d.humanPointerOn(&d.A, 100);
    d.plugin.m_pointerWindow = &d.winB;
    d.plugin.m_pointerDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, true);
        d.plugin.sendButton(BTN_LEFT, false);
    }
    expectSequence(d.X.pointerLog, 0, {"leave(A)", "enter(B)", "motion", "button+", "button-", "leave(B)", "enter(A)"}, "pointer shared sibling");
    check(find(d.X.pointerLog, "button", true).entered == &d.B, "the press must land while the object names the agent's surface");
    check(d.X.pointerEntered == &d.A, "the object must name the human's surface again once the call is over");
    const Event& restored = d.X.pointerLog.back();
    check(restored.serial == 100, "the human's enter must be re-sent with the serial KWin recorded for it");
    check(restored.x == 10 && restored.y == 10, "the human's enter must be re-sent at the human's pointer position");
    check(d.plugin.m_directPointerSurface.isNull(), "a handed-back object leaves no enter outstanding");
    check(d.Y.pointerLog.empty(), "another client must not hear a thing");
}

void pointerUnsharedPersistsThenHumanArrives() {
    Desk d;
    d.humanPointerOn(&d.C, 100);
    d.plugin.m_pointerWindow = &d.winB;
    d.plugin.m_pointerDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, true);
    }
    expectSequence(d.X.pointerLog, 0, {"enter(B)", "motion", "button+"}, "pointer unshared");
    check(d.X.pointerEntered == &d.B && d.plugin.m_directPointerSurface == &d.B, "an enter on an unshared client persists across calls");

    // The human moves into A: KWin leaves C on Y's object and enters A on X's,
    // then the plugin hears about it.
    d.Y.pointerEntered = nullptr;
    server.seat0.pointerObject.focus = &d.A;
    server.seat0.pointerObject.serial = 200;
    d.X.pointerEntered = &d.A;
    d.X.pointerLog.push_back(event("kwin-enter", &d.A, &d.A, 200));
    const size_t from = d.X.pointerLog.size();
    d.plugin.handleHumanPointerFocusChanged();
    expectSequence(d.X.pointerLog, from, {"leave(A)", "enter(B)", "motion", "button-", "leave(B)", "enter(A)"}, "pointer focus change with a held button");
    check(find(d.X.pointerLog, "button", false).entered == &d.B, "the release must land on the surface that saw the press");
    check(d.X.pointerLog.back().serial == 200, "the hand-back must carry KWin's new enter serial");
    check(d.X.pointerEntered == &d.A, "the object must end up naming the human's surface");
    check(d.plugin.m_pressedButtons.empty() && d.plugin.m_directPointerSurface.isNull(), "held buttons and the stale enter must be gone");
}

void pointerSameSurface() {
    Desk d;
    d.humanPointerOn(&d.B, 100);
    d.plugin.m_pointerWindow = &d.winB;
    d.plugin.m_pointerDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, true);
        d.plugin.sendButton(BTN_LEFT, false);
    }
    expectSequence(d.X.pointerLog, 0, {"motion", "button+", "button-"}, "pointer same surface");
    check(d.X.pointerLog.front().x == 50 && d.X.pointerLog.front().y == 60, "the agent's motion goes to the agent's position");
    check(d.X.pointerEntered == &d.B, "seat0's own enter is never revoked");
    check(d.plugin.m_directPointerSurface.isNull(), "the same-surface borrow still ends with the call");
}

void motionNeverBorrowsSharedObject() {
    Desk d;
    d.humanPointerOn(&d.A, 100);
    d.plugin.hitWindow = &d.winB;
    check(d.plugin.updatePointerFocus(), "the target under the ghost cursor is adopted");
    check(d.plugin.m_pointerWindow == &d.winB && d.plugin.m_pointerDirect, "the window is aimed at on the direct path");
    check(d.X.pointerLog.empty() && d.plugin.m_directPointerSurface.isNull(), "plain motion must not touch an object the human's seat is using in this client");

    Desk e;
    e.humanPointerOn(&e.C, 100);
    e.plugin.hitWindow = &e.winB;
    check(e.plugin.updatePointerFocus(), "adopted");
    expectSequence(e.X.pointerLog, 0, {"enter(B)", "motion"}, "motion on an unshared client");
    check(e.plugin.m_directPointerSurface == &e.B, "hover follows the ghost cursor when nobody shares the object");
}

void keyboardSharedSibling() {
    Desk d;
    d.humanKeyboardOn(&d.A);
    inputObject.keyboardObject.xkbObject.mods.locked = CAPS_MASK;
    inputObject.keyboardObject.xkbObject.layout = 1;
    inputObject.keyboardObject.held = {KEY_LEFTCTRL};
    d.X.mods = {0, 0, CAPS_MASK, 1};
    d.plugin.m_keyboardWindow = &d.winB;
    d.plugin.m_keyboardDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendKey(KEY_A, true);
        d.plugin.sendKey(KEY_A, false);
    }
    std::vector<std::string> structural;
    for (const auto& k : kinds(d.X.keyboardLog)) if (k.rfind("modifiers", 0) != 0 && k.rfind("human-modifiers", 0) != 0) structural.push_back(k);
    check(structural == std::vector<std::string>{"leave(A)", "enter(B)", "key+", "key-", "leave(B)", "enter(A)"},
          "keyboard shared sibling: got [" + join(structural) + "]");
    check(find(d.X.keyboardLog, "key", true).entered == &d.B, "the key must land while the object names the agent's surface");
    const Event& agentMods = d.X.keyboardLog[2];
    check(agentMods.kind == "modifiers" && agentMods.mods.locked == CAPS_MASK && agentMods.mods.group == 0 && agentMods.mods.depressed == 0,
          "the agent's modifiers merge the human's lock state, keep its own depressed state and its own group");
    check(d.X.keyboardLog.back().kind == "human-modifiers" && d.X.mods == Modifiers{0, 0, CAPS_MASK, 1},
          "the human's real modifiers, group included, must come back last");
    const Event& restored = *std::find_if(d.X.keyboardLog.rbegin(), d.X.keyboardLog.rend(), [](const Event& e) { return e.kind == "enter"; });
    check(restored.surface == &d.A && restored.keys == std::vector<quint32>{KEY_LEFTCTRL}, "the human's enter must carry the keys KWin knows they hold");
    check(d.X.keyboardEntered == &d.A && d.plugin.m_directKeyboardSurface.isNull(), "the object must name the human's surface again once the call is over");
}

void keyboardHumanArrivesWithHeldKey() {
    Desk d;
    d.humanKeyboardOn(&d.C);
    d.plugin.m_keyboardWindow = &d.winB;
    d.plugin.m_keyboardDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendKey(KEY_LEFTCTRL, true);
    }
    check(d.X.keyboardEntered == &d.B && d.plugin.m_pressedKeys == QList<quint32>{KEY_LEFTCTRL}, "Ctrl is held on the unshared client");
    check(d.plugin.agentXkb.depressed == CONTROL_MASK, "the agent's xkb state holds Ctrl");

    // seat0's keyboard is about to move into A; KWin's leave and enter follow
    // this signal, so the object still names B while the plugin cleans up.
    const size_t from = d.X.keyboardLog.size();
    d.plugin.handleHumanKeyboardFocusAboutToChange(&d.A);
    std::vector<std::string> structural;
    for (const auto& k : kinds(d.X.keyboardLog, from)) if (k.rfind("modifiers", 0) != 0) structural.push_back(k);
    check(structural == std::vector<std::string>{"key-", "leave(B)"}, "keyboard focus change with a held key: got [" + join(structural) + "]");
    check(find(d.X.keyboardLog, "key", false).entered == &d.B, "the release must land on the surface that saw the press");
    check(d.plugin.m_pressedKeys.isEmpty() && d.plugin.agentXkb.depressed == 0, "held keys and the agent's modifier state must unwind");
    check(d.plugin.m_directKeyboardSurface.isNull() && d.X.keyboardEntered == nullptr, "the object is clean for KWin's enter");
}

void refusalWhileHumanActiveInClient() {
    Desk d;
    const Window* human = nullptr;
    using Conflict = SynaraComputerUsePlugin::HumanConflict;
    using Kind = SynaraComputerUsePlugin::InputKind;
    d.humanPointerOn(&d.A, 100);
    d.plugin.humanPointerAge = 500;
    check(d.plugin.humanConflict(&d.winB, true, Kind::Pointer, &human) == Conflict::SharedClient, "an active human pointer elsewhere in the same client refuses a direct click");
    check(d.plugin.humanConflict(&d.winB, false, Kind::Pointer, &human) == Conflict::None, "the agent seat shares nothing with the human, so it is not refused");
    check(d.plugin.humanConflict(&d.winB, true, Kind::Keyboard, &human) == Conflict::None, "a busy pointer does not refuse a key: the keyboard object is not shared");
    d.plugin.humanPointerAge = 5000;
    check(d.plugin.humanConflict(&d.winB, true, Kind::Pointer, &human) == Conflict::None, "an idle pointer refuses nothing");
    d.plugin.humanPointerAge = -1;
    check(d.plugin.humanConflict(&d.winB, true, Kind::Pointer, &human) == Conflict::None, "no observed input refuses nothing");
    d.plugin.humanPointerAge = 500;
    d.humanPointerOn(&d.C, 100);
    check(d.plugin.humanConflict(&d.winB, true, Kind::Pointer, &human) == Conflict::None, "a human in another client refuses nothing");
    // The human types in a sibling window of the client while their mouse rests
    // in another client: keys are refused, clicks are not.
    d.humanKeyboardOn(&d.A);
    d.plugin.humanKeyboardAge = 200;
    d.plugin.humanPointerAge = 9000;
    check(d.plugin.humanConflict(&d.winB, true, Kind::Keyboard, &human) == Conflict::SharedClient, "an active human keyboard in the same client refuses a direct key");
    check(d.plugin.humanConflict(&d.winB, true, Kind::Pointer, &human) == Conflict::None, "their typing does not refuse a click on an unshared pointer object");
    d.humanPointerOn(&d.A, 100);
    check(d.plugin.humanConflict(&d.winB, true, Kind::Pointer, &human) == Conflict::None, "a shared but idle pointer object refuses nothing while only the keyboard is busy");
    d.humanKeyboardOn(&d.C);
    d.plugin.humanWindow = &d.winB;
    check(d.plugin.humanConflict(&d.winB, true, Kind::Pointer, &human) == Conflict::FocusedWindow && human == &d.winB, "the human's own focused window is still the first rule, on any device");
}

void clickAcrossCalls() {
    Desk d;
    d.humanPointerOn(&d.A, 100);
    d.plugin.m_pointerWindow = &d.winB;
    d.plugin.m_pointerDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, true);
    }
    expectSequence(d.X.pointerLog, 0, {"leave(A)", "enter(B)", "motion", "button+"}, "press call on a shared object");
    check(d.X.pointerEntered == &d.B && d.plugin.m_directPointerSurface == &d.B, "a held object is not handed back between the press and the release");
    // The server's hold: motion may arrive before the release (a drag).
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.m_pos = {55, 65};
        d.plugin.hitWindow = &d.winB;
        check(d.plugin.updatePointerFocus(), "motion during the hold is accepted");
    }
    check(d.X.pointerLog.back().kind == "motion" && d.X.pointerLog.back().x == 55, "motion during the hold reaches the borrowed object");
    const size_t from = d.X.pointerLog.size();
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, false);
    }
    expectSequence(d.X.pointerLog, from, {"button-", "leave(B)", "enter(A)"}, "release call on a shared object");
    check(find(d.X.pointerLog, "button", false).entered == &d.B, "the release lands on the surface that saw the press");
    check(d.X.pointerEntered == &d.A && d.plugin.m_directPointerSurface.isNull(), "the release empties the held set and hands the object back");
}

void chordAcrossCalls() {
    Desk d;
    d.humanKeyboardOn(&d.A);
    d.plugin.m_keyboardWindow = &d.winB;
    d.plugin.m_keyboardDirect = true;
    for (const auto& [key, pressed] : std::vector<std::pair<quint32, bool>>{{KEY_LEFTCTRL, true}, {KEY_A, true}, {KEY_A, false}, {KEY_LEFTCTRL, false}}) {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendKey(key, pressed);
    }
    std::vector<std::string> structural;
    for (const auto& k : kinds(d.X.keyboardLog)) if (k.rfind("modifiers", 0) != 0 && k.rfind("human-modifiers", 0) != 0) structural.push_back(k);
    check(structural == std::vector<std::string>{"leave(A)", "enter(B)", "key+", "key+", "key-", "key-", "leave(B)", "enter(A)"},
          "a four-call chord enters once and leaves once: got [" + join(structural) + "]");
    for (const Event& e : d.X.keyboardLog) if (e.kind == "key") check(e.entered == &d.B, "every key of the chord lands on the agent's surface");
    check(d.X.keyboardEntered == &d.A && d.plugin.m_directKeyboardSurface.isNull(), "the chord's last release hands the object back");
    check(d.X.keyboardLog.back().kind == "human-modifiers", "the human's modifiers come back after the chord, not in the middle of it");
}

void humanMovesDuringHold() {
    Desk d;
    d.humanPointerOn(&d.A, 100);
    d.plugin.m_pointerWindow = &d.winB;
    d.plugin.m_pointerDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, true);
    }
    const size_t from = d.X.pointerLog.size();
    // The spy, before KWin forwards the human's motion into A.
    d.plugin.handleHumanPointerInput();
    expectSequence(d.X.pointerLog, from, {"button-", "leave(B)", "enter(A)"}, "the human's first motion during a hold");
    check(find(d.X.pointerLog, "button", false).entered == &d.B, "the forced release lands on the agent's surface");
    check(d.X.pointerEntered == &d.A && d.plugin.m_pressedButtons.empty() && d.plugin.m_directPointerSurface.isNull(),
          "the object is the human's again before their motion is delivered");
    d.plugin.handleHumanPointerInput();
    check(d.X.pointerLog.size() == from + 3, "a human event with nothing borrowed sends nothing");

    // Unshared: the human's events elsewhere leave a held agent object alone.
    Desk e;
    e.humanPointerOn(&e.C, 100);
    e.plugin.m_pointerWindow = &e.winB;
    e.plugin.m_pointerDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&e.plugin);
        e.plugin.sendButton(BTN_LEFT, true);
    }
    const size_t before = e.X.pointerLog.size();
    e.plugin.handleHumanPointerInput();
    check(e.X.pointerLog.size() == before && e.plugin.m_pressedButtons.size() == 1, "the human moving in another client does not end the agent's drag");
}

void humanTypesDuringChord() {
    Desk d;
    d.humanKeyboardOn(&d.A);
    d.plugin.m_keyboardWindow = &d.winB;
    d.plugin.m_keyboardDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendKey(KEY_LEFTCTRL, true);
    }
    check(d.X.keyboardEntered == &d.B && d.plugin.agentXkb.depressed == CONTROL_MASK, "Ctrl is held on the borrowed object");
    const size_t from = d.X.keyboardLog.size();
    d.plugin.handleHumanKeyboardInput();
    std::vector<std::string> structural;
    for (const auto& k : kinds(d.X.keyboardLog, from)) if (k.rfind("modifiers", 0) != 0 && k.rfind("human-modifiers", 0) != 0) structural.push_back(k);
    check(structural == std::vector<std::string>{"key-", "leave(B)", "enter(A)"}, "the human's first key during a chord: got [" + join(structural) + "]");
    check(find(d.X.keyboardLog, "key", false).entered == &d.B, "the forced release lands on the agent's surface");
    check(d.X.keyboardEntered == &d.A && d.plugin.m_pressedKeys.isEmpty() && d.plugin.agentXkb.depressed == 0, "the object is the human's again with the agent's modifiers unwound");
    check(d.X.mods == Modifiers{0, 0, 0, 0} && d.X.keyboardLog.back().kind == "human-modifiers", "the human's real modifiers are the last word");
}

void sameSurfaceClickAcrossCalls() {
    Desk d;
    d.humanPointerOn(&d.B, 100);
    d.plugin.m_pointerWindow = &d.winB;
    d.plugin.m_pointerDirect = true;
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, true);
    }
    {
        SynaraComputerUsePlugin::DirectInjectionScope scope(&d.plugin);
        d.plugin.sendButton(BTN_LEFT, false);
    }
    expectSequence(d.X.pointerLog, 0, {"motion", "button+", "button-"}, "same-surface click across calls");
    check(d.X.pointerEntered == &d.B, "seat0's enter is untouched");
}

int main() {
    try {
        clickAcrossCalls();
        chordAcrossCalls();
        humanMovesDuringHold();
        humanTypesDuringChord();
        sameSurfaceClickAcrossCalls();
        pointerSharedSibling();
        pointerUnsharedPersistsThenHumanArrives();
        pointerSameSurface();
        motionNeverBorrowsSharedObject();
        keyboardSharedSibling();
        keyboardHumanArrivesWithHeldKey();
        refusalWhileHumanActiveInClient();
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "Direct injection hands every shared seat0 object back to the human.\n";
}
