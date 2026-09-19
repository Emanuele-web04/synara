// Compositor-free model of the shared wl_pointer/wl_keyboard problem. One
// client ("browser") holds two surfaces: `agent`, the agent's target, and
// `human`, the window the human's seat is on. The client keeps exactly one
// entered surface per object (`pointerEntered`, `keyboardEntered`): whichever
// enter it heard last, from the seat or from the agent. Every event the
// production code sends is checked against that, so a motion, button, axis or
// key routed to the wrong window fails loudly here instead of in the human's
// window, and an enter of another surface of the same client without a leave
// first fails too.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace sdbus {
struct Error : std::runtime_error {
    struct Name { std::string value; };
    std::string name;
    Error(Name name, const std::string& message) : std::runtime_error(message), name(name.value) {}
};
}
constexpr const char* ERR_HUMAN_ACTIVE = "org.synara.ComputerUse.Error.HumanActive";
constexpr const char* ERR_SESSION_LOCKED = "org.synara.ComputerUse.Error.SessionLocked";
bool locked = false;
void requireUnlockedSession() { if (locked) throw sdbus::Error(sdbus::Error::Name{ERR_SESSION_LOCKED}, "locked"); }

template<typename T> using SP = std::shared_ptr<T>;
template<typename T> using WP = std::weak_ptr<T>;
struct wl_client {};
struct CWLSurfaceResource;
struct wl_resource { CWLSurfaceResource* surface = nullptr; };
struct Resource { wl_resource value; wl_resource* resource() { return &value; } };
struct CWLSurfaceResource {
    wl_client* c;
    Resource resource{{this}};
    wl_client* client() { return c; }
    Resource* getResource() { return &resource; }
};
struct Vector2D { double x = 0, y = 0; };
struct CBox { double x = 0, y = 0, w = 1920, h = 1080; };
struct Window {};
using PHLWINDOW = SP<Window>;
struct Seat { struct { std::weak_ptr<CWLSurfaceResource> pointerFocus, keyboardFocus; } m_state; } seat;
Seat* g_pSeatManager = &seat;
struct SDeferredRelease {
    WP<CWLSurfaceResource> surface;
    Vector2D               local;
    std::set<uint32_t>     buttons;
};
struct {
    std::weak_ptr<CWLSurfaceResource> directPointerSurface, directKeyboardSurface, seatPointerFocus, seatKeyboardFocus;
    bool directPointerNeedsEnter = true, directKeyboardNeedsEnter = true;
    Vector2D directPointerLocal;
    std::vector<SDeferredRelease> deferredReleases;
    std::weak_ptr<Window> pointerWindow, targetWindow, keyboardWindow;
    std::set<uint32_t> pressedButtons;
    std::vector<uint32_t> pressedKeys;
    bool targetRequested = false;
    double axisRemainderH = 0, axisRemainderV = 0;
    Vector2D pos;
    void* xkbState = nullptr;
} g;
SP<CWLSurfaceResource> hitSurface;
PHLWINDOW hitWindow = std::make_shared<Window>();
CWLSurfaceResource* pointerEntered = nullptr;
CWLSurfaceResource* keyboardEntered = nullptr;
int buttonEvents = 0, axisEvents = 0, discreteSteps = 0, keyEvents = 0, pointerEnters = 0, keyboardEnters = 0;
int pointerVersion = 9;
bool refuse = false, reachable = true;
struct HitTest { SP<CWLSurfaceResource> windowSurfaceAt(Vector2D, PHLWINDOW, Vector2D& local) { local = {7, 9}; return hitSurface; } };
struct ViewState { HitTest& hitTest() { static HitTest h; return h; } };
namespace Desktop { ViewState* viewState() { static ViewState v; return &v; } }
bool usableWindow(PHLWINDOW w) { return bool(w); }
PHLWINDOW windowAtPoint(Vector2D) { return hitWindow; }
std::vector<wl_resource*> clientInputResources(wl_client*, const char*) { static wl_resource r; return {&r}; }
uint32_t directSerial(SP<CWLSurfaceResource>, bool = false) { return 1; }
uint32_t directTimestampMs() { return 1; }
int wl_fixed_from_double(double d) { return int(d); }
int wl_resource_get_version(wl_resource*) { return pointerVersion; }
constexpr int WL_POINTER_FRAME_SINCE_VERSION = 5, WL_POINTER_AXIS_SOURCE_SINCE_VERSION = 5;
constexpr int WL_POINTER_AXIS_DISCRETE_SINCE_VERSION = 5, WL_POINTER_AXIS_VALUE120_SINCE_VERSION = 8;
constexpr int WL_POINTER_AXIS_SOURCE_WHEEL = 0, WL_POINTER_AXIS_HORIZONTAL_SCROLL = 1, WL_POINTER_AXIS_VERTICAL_SCROLL = 0;
constexpr double SCROLL_PIXELS_PER_NOTCH = 80, AXIS_UNITS_PER_NOTCH = 15;
void check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

// An enter of another surface of the same client while one is entered is a
// protocol violation the model refuses (P5). Surfaces of other clients are
// other objects and do not interact.
void enterPointer(CWLSurfaceResource* surface) {
    check(!pointerEntered || pointerEntered->c != surface->c || pointerEntered == surface, "pointer enter without leave");
    pointerEntered = surface;
    ++pointerEnters;
}
void enterKeyboard(CWLSurfaceResource* surface) {
    check(!keyboardEntered || keyboardEntered->c != surface->c || keyboardEntered == surface, "keyboard enter without leave");
    keyboardEntered = surface;
    ++keyboardEnters;
}
void wl_pointer_send_leave(wl_resource*, uint32_t, wl_resource* surface) {
    if (pointerEntered == surface->surface) pointerEntered = nullptr;
}
void wl_pointer_send_enter(wl_resource*, uint32_t, wl_resource* surface, int, int) { enterPointer(surface->surface); }
void wl_pointer_send_motion(wl_resource*, uint32_t, int, int) { check(pointerEntered == hitSurface.get(), "motion misdirected"); }
void wl_pointer_send_frame(wl_resource*) {}
void wl_pointer_send_axis_source(wl_resource*, int) {}
void wl_pointer_send_axis(wl_resource*, uint32_t, int, int) {
    check(pointerEntered == hitSurface.get(), "axis misdirected"); ++axisEvents;
}
void wl_pointer_send_axis_value120(wl_resource*, int, int) {}
void wl_pointer_send_axis_discrete(wl_resource*, int, int steps) { discreteSteps += steps; }
void restoreSeatPointerEnter(wl_client* client) {
    if (auto surface = seat.m_state.pointerFocus.lock(); surface && surface->client() == client) enterPointer(surface.get());
}
struct wl_array { std::vector<uint32_t> keys; };
void wl_array_init(wl_array*) {}
void* wl_array_add(wl_array* array, size_t) { array->keys.push_back(0); return &array->keys.back(); }
void wl_array_release(wl_array*) {}
void wl_keyboard_send_enter(wl_resource*, uint32_t, wl_resource* surface, wl_array*) { enterKeyboard(surface->surface); }
void wl_keyboard_send_leave(wl_resource*, uint32_t, wl_resource* surface) {
    if (keyboardEntered == surface->surface) keyboardEntered = nullptr;
}
void restoreSeatKeyboardEnter(wl_client* client) {
    if (auto surface = seat.m_state.keyboardFocus.lock(); surface && surface->client() == client) enterKeyboard(surface.get());
}
bool requireRunning() { return true; }
struct InputManagerFixture { bool held = false; bool hasHeldButtons() { return held; } } inputManager;
auto* g_pInputManager = &inputManager;
void requireReachableClient(PHLWINDOW, const char*) { if (!reachable) throw std::runtime_error("unreachable"); }
void refuseIfHumanActive(PHLWINDOW) { if (refuse) throw std::runtime_error("human active"); }
SP<CWLSurfaceResource> windowMainSurface(PHLWINDOW) { return hitSurface; }
void directPointerButtonEvent(SP<CWLSurfaceResource> surface, uint32_t, bool) {
    check(pointerEntered == surface.get(), "button misdirected"); ++buttonEvents;
}
void directKeyboardKeyEvent(SP<CWLSurfaceResource> surface, uint32_t, bool) {
    check(keyboardEntered == surface.get(), "key misdirected"); ++keyEvents;
}
void ensureXkbState() {}
constexpr int XKB_KEY_DOWN = 1, XKB_KEY_UP = 0;
void xkb_state_update_key(void*, uint32_t, int) {}
void directKeyboardModifiers() {}
CBox workspaceGeometry() { return {}; }
void damageCursorArea() {}

// PRODUCTION_DEFINITIONS

template <typename Action> void expectHumanActive(Action action, const char* message) {
    bool refused = false;
    try { action(); } catch (const sdbus::Error& error) { refused = error.name == ERR_HUMAN_ACTIVE; }
    check(refused, message);
}

int main() {
    wl_client browser, other;
    auto agent = std::make_shared<CWLSurfaceResource>(); agent->c = &browser;
    auto human = std::make_shared<CWLSurfaceResource>(); human->c = &browser;
    auto outsider = std::make_shared<CWLSurfaceResource>(); outsider->c = &other;
    hitSurface = agent;
    seat.m_state.pointerFocus = human;
    seat.m_state.keyboardFocus = human;
    pointerEntered = keyboardEntered = human.get();
    check(movePointer(100, 100), "standalone move refused");
    for (const double invalid : {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()}) {
        check(!movePointer(invalid, 200), "non-finite x accepted");
        check(!movePointer(200, invalid), "non-finite y accepted");
        check(g.pos.x == 100 && g.pos.y == 100, "invalid move changed cursor position");
        check(!injectAxis(invalid, 80), "non-finite horizontal scroll accepted");
        check(!injectAxis(80, invalid), "non-finite vertical scroll accepted");
        check(axisEvents == 0, "invalid scroll delivered input");
        check(pointerEntered == human.get(), "invalid input changed human focus");
    }

    // The human is mid-press: every pointer action is refused with the reason,
    // and nothing moves or re-aims.
    inputManager.held = true;
    const auto beforeDrag = pointerEntered;
    expectHumanActive([] { movePointer(250, 250); }, "agent moved during human drag");
    expectHumanActive([] { injectButton(272, true); }, "agent clicked during human drag");
    expectHumanActive([] { injectAxis(0, 80); }, "agent scrolled during human drag");
    check(pointerEntered == beforeDrag && g.pos.x == 100, "human drag target was changed");
    inputManager.held = false;
    check(movePointer(100, 100), "agent move stayed blocked after release");
    check(pointerEntered == human.get(), "motion did not return pointer");

    check(injectButton(272, true), "sibling click refused");
    check(pointerEntered == agent.get(), "held button lost pointer");
    check(keyboardEntered == human.get(), "click stole keyboard");
    check(movePointer(200, 200), "drag motion refused");
    check(pointerEntered == agent.get(), "drag lost pointer");
    check(injectButton(272, false), "release refused");
    check(pointerEntered == human.get(), "release did not return pointer");
    check(buttonEvents == 2, "click not delivered");
    check(injectAxis(0, 80), "sibling scroll refused");
    check(axisEvents == 1 && pointerEntered == human.get(), "scroll not returned");
    pointerVersion = 6;
    for (int i = 0; i < 8; ++i) check(injectAxis(0, 10), "fractional scroll refused");
    check(discreteSteps == 1, "handback discarded fractional scrolling");
    refuse = true;
    bool refused = false;
    try { injectButton(272, true); } catch (const std::runtime_error&) { refused = true; }
    check(refused, "expected refusal");
    check(pointerEntered == human.get(), "refusal stole pointer");
    refuse = false;

    // Same-client focus change mid-press (P2/P3): the agent holds a button on
    // its surface, then the human moves into the sibling window and the seat
    // enters it. The drag survives - nothing is released by the change - and
    // the agent's own release is re-stamped onto the pressed surface.
    check(injectButton(272, true), "press before focus change refused");
    check(pointerEntered == agent.get() && !g.directPointerNeedsEnter, "press did not keep the agent entered");
    pointerEntered = nullptr; // the seat's own leave for the agent's surface ...
    pointerEntered = human.get(); // ... and enter for the sibling
    int before = buttonEvents;
    onSeatPointerFocusChange();
    check(buttonEvents == before, "focus change released the drag");
    check(g.pressedButtons.contains(272) && g.directPointerNeedsEnter && !g.directPointerSurface.expired(), "focus change forgot the drag");
    check(pointerEntered == human.get(), "focus change touched the human's pointer");
    check(injectButton(272, false), "release after focus change refused");
    check(buttonEvents == before + 1 && g.pressedButtons.empty(), "release after focus change not delivered");
    check(pointerEntered == human.get(), "release after focus change did not hand back");

    // Drag-time hand-back (P4): while the agent holds a button on its surface
    // and the human's pointer is on the sibling, the human's own event must
    // reach the sibling, and the agent's next event must re-enter its target
    // with the button still held.
    check(injectButton(272, true), "drag press refused");
    check(pointerEntered == agent.get(), "drag press did not enter");
    handBackPointerBeforeHumanEvent();
    check(pointerEntered == human.get(), "human event during drag was routed to the agent's window");
    check(g.directPointerNeedsEnter && g.pressedButtons.contains(272), "drag hand-back dropped the held button");
    before = pointerEnters;
    handBackPointerBeforeHumanEvent();
    check(pointerEnters == before, "hand-back repeated for every human event");
    check(movePointer(120, 120), "drag motion after hand-back refused");
    check(pointerEntered == agent.get() && g.pressedButtons.contains(272), "drag motion did not re-enter the target");
    check(injectButton(272, false), "drag release refused");
    check(g.pressedButtons.empty() && pointerEntered == human.get(), "drag release did not hand back");

    // Deferred release (P3): the agent's enter went stale, then the human
    // pressed in the sibling. The agent's release is accepted but owed - the
    // human's pointer is not touched through their press - and paid at their
    // button-up, re-stamped onto the pressed surface.
    check(injectButton(272, true), "press before deferral refused");
    pointerEntered = human.get(); // the seat's enter for the sibling
    onSeatPointerFocusChange();
    inputManager.held = true;     // the human presses in the sibling
    before = buttonEvents;
    check(injectButton(272, false), "release during human press refused");
    check(buttonEvents == before && g.pressedButtons.empty(), "release was sent through the human's press");
    check(g.deferredReleases.size() == 1 && pointerEntered == human.get(), "release was not deferred");
    settleDeferredReleases();
    check(buttonEvents == before, "owed release paid while the human still held a button");
    inputManager.held = false;
    settleDeferredReleases();
    check(buttonEvents == before + 1 && g.deferredReleases.empty(), "owed release not paid at button-up");
    check(pointerEntered == human.get(), "owed release did not hand back");

    // ... and paid by the next agent action when no button-up timer ran.
    check(injectButton(272, true), "press before second deferral refused");
    pointerEntered = human.get();
    onSeatPointerFocusChange();
    inputManager.held = true;
    check(resetInputDelivery(), "reset during human press failed");
    check(g.deferredReleases.size() == 1 && g.pressedButtons.empty() && pointerEntered == human.get(), "reset released through the human's press");
    inputManager.held = false;
    before = buttonEvents;
    check(movePointer(130, 130), "move after deferral refused");
    check(buttonEvents == before + 1 && g.deferredReleases.empty(), "next agent action did not pay the owed release");

    // While the human presses in another client, the agent's enter on its
    // own client stands and its release goes out bare, at once.
    seat.m_state.pointerFocus = outsider;
    pointerEntered = outsider.get();
    check(injectButton(272, true), "press with seat elsewhere refused");
    inputManager.held = true;
    before = buttonEvents;
    check(injectButton(272, false), "release during other-client press refused");
    check(buttonEvents == before + 1 && g.deferredReleases.empty(), "release deferred needlessly");
    expectHumanActive([] { injectButton(273, false); }, "stray release accepted during human hold");
    inputManager.held = false;

    g.directKeyboardSurface.reset();
    g.directKeyboardNeedsEnter = true;
    check(injectButton(272, true) && injectButton(272, false), "different-client click refused");
    check(keyboardEntered == human.get(), "pointer action stole sibling keyboard");
    check(injectKey(29, true), "modifier refused");
    check(keyboardEntered == agent.get(), "held modifier lost keyboard");
    check(injectKey(30, true) && injectKey(30, false) && injectKey(29, false), "chord refused");
    check(keyboardEntered == human.get() && keyEvents == 4, "chord failed to restore keyboard");
    g.directKeyboardSurface.reset();
    g.directKeyboardNeedsEnter = true;
    reachable = false;
    refused = false;
    try { injectKey(30, true); } catch (const std::runtime_error&) { refused = true; }
    check(refused, "expected unreachable refusal");
    check(keyboardEntered == human.get(), "failed key stole keyboard");
    reachable = true;
    seat.m_state.pointerFocus = human;
    onSeatPointerFocusChange();
    check(injectButton(272, true) && injectButton(272, false), "seat-focus change broke next click");

    // Keyboard hand-back during a chord: the agent holds Ctrl on its surface,
    // the human types into the sibling. Their key must reach the sibling; the
    // agent's next key re-stamps its target with Ctrl still held.
    check(injectKey(29, true), "modifier before hand-back refused");
    check(keyboardEntered == agent.get() && !g.directKeyboardNeedsEnter, "modifier did not keep the agent entered");
    handBackKeyboardBeforeHumanKey();
    check(keyboardEntered == human.get() && g.directKeyboardNeedsEnter, "human key during chord was routed to the agent's window");
    check(g.pressedKeys.size() == 1, "keyboard hand-back dropped the held modifier");
    before = keyboardEnters;
    handBackKeyboardBeforeHumanKey();
    check(keyboardEnters == before, "keyboard hand-back repeated for every human key");
    before = keyEvents;
    check(injectKey(30, true), "key after hand-back refused");
    check(keyEvents == before + 1 && keyboardEntered == agent.get(), "key after hand-back did not re-enter the target");
    check(injectKey(30, false) && injectKey(29, false), "chord end refused");
    check(keyboardEntered == human.get() && g.pressedKeys.empty(), "chord end did not hand back");

    // Seat keyboard focus change mid-chord: the enter goes stale, the chord
    // survives, the next key re-stamps.
    check(injectKey(29, true), "modifier before focus change refused");
    keyboardEntered = human.get(); // the seat's own enter for the sibling
    onSeatKeyboardFocusChange();
    check(g.directKeyboardNeedsEnter && g.pressedKeys.size() == 1, "keyboard focus change dropped the chord");
    before = keyEvents;
    check(injectKey(30, true), "key after focus change refused");
    check(keyEvents == before + 1 && keyboardEntered == agent.get(), "key after focus change misdirected");
    // Held keys are released on the surface that saw them even after the
    // human's click moved the seat's keyboard focus to the sibling.
    keyboardEntered = human.get();
    onSeatKeyboardFocusChange();
    before = keyEvents;
    clearKeyboardDelivery();
    check(keyEvents == before + 2 && g.pressedKeys.empty(), "held keys were not released");
    check(keyboardEntered == human.get(), "key release did not hand the keyboard back");

    // ResetInputDelivery: everything held goes, addressed correctly, the
    // target is forgotten, and both shared objects are the seat's again.
    check(injectButton(272, true) && injectKey(29, true), "press before reset refused");
    g.targetWindow = hitWindow;
    g.targetRequested = true;
    pointerEntered = human.get();
    keyboardEntered = human.get();
    onSeatPointerFocusChange();
    onSeatKeyboardFocusChange();
    check(resetInputDelivery(), "reset failed");
    check(!g.targetRequested && g.targetWindow.expired(), "reset kept the target");
    check(g.pressedButtons.empty() && g.pressedKeys.empty() && g.deferredReleases.empty(), "reset kept held input");
    check(g.directPointerSurface.expired() && g.directKeyboardSurface.expired() && g.directPointerNeedsEnter && g.directKeyboardNeedsEnter, "reset kept enter bookkeeping");
    check(pointerEntered == human.get() && keyboardEntered == human.get(), "reset did not hand the shared objects back");

    // Locked desktop: every input entry point answers SessionLocked first.
    locked = true;
    const double xBefore = g.pos.x;
    for (const auto& action : {std::function<void()>{[] { movePointer(10, 10); }}, std::function<void()>{[] { injectButton(272, true); }},
                               std::function<void()>{[] { injectAxis(0, 80); }}, std::function<void()>{[] { injectKey(30, true); }}}) {
        bool lockedRefused = false;
        try { action(); } catch (const sdbus::Error& error) { lockedRefused = error.name == ERR_SESSION_LOCKED; }
        check(lockedRefused, "locked input accepted");
    }
    check(g.pos.x == xBefore && g.pressedButtons.empty() && g.pressedKeys.empty(), "locked input changed state");
    locked = false;
    std::cout << "Focus delivery, drag, scroll, refusal cleanup, focus-change addressing, deferred releases, keyboard hand-back, and reset passed.\n";
}
