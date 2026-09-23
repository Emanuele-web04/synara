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
#include <format>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

namespace sdbus {
struct Error : std::runtime_error {
    struct Name { std::string value; };
    std::string name;
    Error(Name name, const std::string& message) : std::runtime_error(message), name(name.value) {}
};
template <typename... T> using Struct = std::tuple<T...>;
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
// One wl_keyboard.modifiers worth of state, as the plugin declares it.
struct SModifierState {
    uint32_t depressed = 0, latched = 0, locked = 0, group = 0;
    bool operator==(const SModifierState&) const = default;
};
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
    bool directPointerHandedBack = false;
    std::vector<SDeferredRelease> deferredReleases;
    std::weak_ptr<Window> pointerWindow, targetWindow, keyboardWindow;
    std::set<uint32_t> pressedButtons;
    std::vector<uint32_t> pressedKeys;
    bool targetRequested = false;
    double axisRemainderH = 0, axisRemainderV = 0;
    Vector2D pos;
    struct xkb_state* xkbState = nullptr;
    bool agentModifiersInEffect = false;
    SModifierState agentModifiers;
    std::set<uint32_t> humanHeldKeys;
    int64_t lastAgentInputMs = -1;
    uint32_t burstStartSerial = 0;
} g;
int64_t clockMs = 1;
int64_t nowMs() { return clockMs; }
SP<CWLSurfaceResource> hitSurface;
PHLWINDOW hitWindow = std::make_shared<Window>();
CWLSurfaceResource* pointerEntered = nullptr;
// Where the client believes its pointer is on the entered surface: the
// coordinates of the last enter or motion it heard. The agent aims at local
// (7, 9) of the hit surface; the human's pointer is at (50, 60) of the seat's.
Vector2D pointerAt, buttonAt, axisAt;
constexpr Vector2D AGENT_LOCAL{7, 9}, SEAT_LOCAL{50, 60}, GRAB_LOCAL{11, 13};
// The surface an agent drag holds, while one is being checked.
CWLSurfaceResource* grabbedSurface = nullptr;
bool samePoint(Vector2D a, Vector2D b) { return a.x == b.x && a.y == b.y; }
int motions = 0;
CWLSurfaceResource* keyboardEntered = nullptr;
int buttonEvents = 0, axisEvents = 0, discreteSteps = 0, keyEvents = 0, pointerEnters = 0, keyboardEnters = 0, pointerLeaves = 0, keyboardLeaves = 0;
int pointerVersion = 9;
bool refuse = false, reachable = true;
// Strokes refuseIfHumanActive lets through before it starts refusing; -1 for
// never. Lets a batch be refused part-way.
int refuseAfter = -1;
struct HitTest { SP<CWLSurfaceResource> windowSurfaceAt(Vector2D, PHLWINDOW, Vector2D& local) { local = {7, 9}; return hitSurface; } };
void check(bool condition, const char* message);
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
    ++pointerLeaves;
}
void wl_pointer_send_enter(wl_resource*, uint32_t, wl_resource* surface, int x, int y) {
    enterPointer(surface->surface);
    pointerAt = {double(x), double(y)};
}
// The agent's motion (at AGENT_LOCAL) must reach the surface it aims at; a
// hand-back motion (at SEAT_LOCAL) must reach the seat's surface.
void wl_pointer_send_motion(wl_resource*, uint32_t, int x, int y) {
    const Vector2D at{double(x), double(y)};
    if (samePoint(at, SEAT_LOCAL))
        check(pointerEntered == seat.m_state.pointerFocus.lock().get(), "seat position sent to another surface");
    else if (samePoint(at, GRAB_LOCAL))
        check(grabbedSurface && pointerEntered == grabbedSurface, "grabbed motion misdirected");
    else
        check(pointerEntered == hitSurface.get(), "motion misdirected");
    pointerAt = at;
    ++motions;
}
void wl_pointer_send_frame(wl_resource*) {}
void wl_pointer_send_axis_source(wl_resource*, int) {}
void wl_pointer_send_axis(wl_resource*, uint32_t, int, int) {
    check(pointerEntered == hitSurface.get(), "axis misdirected"); ++axisEvents;
    axisAt = pointerAt;
}
void wl_pointer_send_axis_value120(wl_resource*, int, int) {}
void wl_pointer_send_axis_discrete(wl_resource*, int, int steps) { discreteSteps += steps; }
void restoreSeatPointerEnter(wl_client* client) {
    if (auto surface = seat.m_state.pointerFocus.lock(); surface && surface->client() == client) {
        enterPointer(surface.get());
        pointerAt = SEAT_LOCAL;
    }
}
Vector2D seatPointerLocal(SP<CWLSurfaceResource>) { return SEAT_LOCAL; }
Vector2D surfaceLocalPosition(SP<CWLSurfaceResource>, Vector2D) { return GRAB_LOCAL; }
void check(bool condition, const char* message);
// The client's keyboard modifiers: whatever wl_keyboard.modifiers it heard
// last, from the seat or from the agent. Keys are interpreted under them.
using Mods = SModifierState;
constexpr uint32_t SHIFT = 1, CAPS = 2, CTRL = 4, NUMLOCK = 16;
Mods clientMods, keyMods;
struct Keyboard { Mods m_modifiersState; } seatKb;
SP<Keyboard> seatKeyboard() { return SP<Keyboard>(&seatKb, [](Keyboard*) {}); }
// The agent's xkb state: Ctrl (evdev 29) is the one modifier key modelled.
struct xkb_state { Mods mods; } agentXkb;
enum { XKB_STATE_MODS_DEPRESSED, XKB_STATE_MODS_LATCHED, XKB_STATE_MODS_LOCKED, XKB_STATE_LAYOUT_EFFECTIVE };
uint32_t xkb_state_serialize_mods(xkb_state* s, int component) {
    return component == XKB_STATE_MODS_DEPRESSED ? s->mods.depressed : component == XKB_STATE_MODS_LATCHED ? s->mods.latched : s->mods.locked;
}
uint32_t xkb_state_serialize_layout(xkb_state* s, int) { return s->mods.group; }
void xkb_state_update_mask(xkb_state* s, uint32_t depressed, uint32_t latched, uint32_t locked, uint32_t, uint32_t, uint32_t group) {
    s->mods = {depressed, latched, locked, group};
}
// A modifiers event lands on whatever the client's keyboard is entered on,
// so one carrying the agent's state must only ever reach the agent's target;
// the human's windows only ever hear the seat's own.
void wl_keyboard_send_modifiers(wl_resource*, uint32_t, uint32_t depressed, uint32_t latched, uint32_t locked, uint32_t group) {
    const Mods mods{depressed, latched, locked, group};
    check(keyboardEntered != nullptr, "modifiers sent with nothing entered");
    check(keyboardEntered == hitSurface.get() || mods == seatKb.m_modifiersState, "agent modifiers sent into the human's window");
    clientMods = mods;
}
struct wl_array { std::vector<uint32_t> keys; };
void wl_array_init(wl_array*) {}
void* wl_array_add(wl_array* array, size_t) { array->keys.push_back(0); return &array->keys.back(); }
void wl_array_release(wl_array*) {}
void wl_keyboard_send_enter(wl_resource*, uint32_t, wl_resource* surface, wl_array*) { enterKeyboard(surface->surface); }
void wl_keyboard_send_leave(wl_resource*, uint32_t, wl_resource* surface) {
    if (keyboardEntered == surface->surface) keyboardEntered = nullptr;
    ++keyboardLeaves;
}
bool requireRunning() { return true; }
struct InputManagerFixture { bool held = false; bool hasHeldButtons() { return held; } } inputManager;
auto* g_pInputManager = &inputManager;
void requireReachableClient(PHLWINDOW, const char*) { if (!reachable) throw std::runtime_error("unreachable"); }
void refuseIfHumanActive(PHLWINDOW) {
    if (refuseAfter == 0) refuse = true;
    if (refuseAfter > 0) --refuseAfter;
    if (refuse) throw sdbus::Error(sdbus::Error::Name{ERR_HUMAN_ACTIVE}, "human active");
}
SP<CWLSurfaceResource> windowMainSurface(PHLWINDOW) { return hitSurface; }
void directPointerButtonEvent(SP<CWLSurfaceResource> surface, uint32_t, bool) {
    check(pointerEntered == surface.get(), "button misdirected"); ++buttonEvents;
    buttonAt = pointerAt;
}
void directKeyboardKeyEvent(SP<CWLSurfaceResource> surface, uint32_t, bool) {
    check(keyboardEntered == surface.get(), "key misdirected"); ++keyEvents;
    keyMods = clientMods;
}
void ensureXkbState() { g.xkbState = &agentXkb; }
constexpr int XKB_KEY_DOWN = 1, XKB_KEY_UP = 0;
void xkb_state_update_key(xkb_state* s, uint32_t key, int direction) {
    if (key == 29 + 8) s->mods.depressed = direction == XKB_KEY_DOWN ? (s->mods.depressed | CTRL) : (s->mods.depressed & ~CTRL);
}
CBox workspaceGeometry() { return {}; }
void damageCursorArea() {}
// The popup rule's bookkeeping; its decisions have their own fixture.
uint32_t displaySerialNow = 100;
uint32_t displaySerial() { return ++displaySerialNow; }
std::vector<std::pair<uint32_t, uint32_t>> agentBursts;
void noteAgentBurst(uint32_t after, uint32_t last) { agentBursts.push_back({after, last}); }
int popupDismissals = 0, agentPresses = 0;
void dismissAllAgentPopups() { ++popupDismissals; }
void handleAgentPress(wl_client*) { ++agentPresses; }

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
    grabbedSurface = agent.get(); // every drag below presses on the agent's surface
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

    agentBursts.clear();
    check(injectButton(272, true), "sibling click refused");
    check(agentPresses == 1, "an agent press did not reach the popup rule");
    check(agentBursts.size() == 1 && agentBursts[0].first < agentBursts[0].second, "a call is recorded as one burst of agent serials");
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

    // Implicit grab (P2): a button the agent holds keeps its pointer on the
    // pressed surface wherever the ghost goes - over another client's window
    // here - so the drag is neither released nor retargeted, and the motion
    // arrives in the pressed surface's own coordinates.
    clearPointerDelivery();
    hitSurface = agent;
    seat.m_state.pointerFocus = human;
    pointerEntered = human.get();
    onSeatPointerFocusChange();
    check(injectButton(272, true) && pointerEntered == agent.get(), "grab press refused");
    hitSurface = outsider;
    before = buttonEvents;
    check(movePointer(900, 900), "grabbed motion refused");
    check(buttonEvents == before && g.pressedButtons.contains(272), "drag released when another surface came under the ghost");
    check(pointerEntered == agent.get() && samePoint(pointerAt, GRAB_LOCAL), "grabbed motion not delivered to the pressed surface");
    // A stale enter mid-grab is re-stamped on the pressed surface.
    handBackPointerBeforeHumanEvent();
    check(pointerEntered == human.get(), "grab hand-back failed");
    check(movePointer(910, 910) && pointerEntered == agent.get() && samePoint(pointerAt, GRAB_LOCAL), "grab did not re-enter the pressed surface");
    check(injectButton(272, false) && buttonEvents == before + 1 && samePoint(buttonAt, GRAB_LOCAL), "grab release not delivered to the pressed surface");
    check(g.pressedButtons.empty() && pointerEntered == human.get(), "grab release did not hand back");
    hitSurface = agent;
    // Without a button held the hit test decides again.
    check(movePointer(100, 100) && g.directPointerSurface.lock() == agent, "hit test not restored after the grab");

    // Refusals come before any wire event (P2): a refused click, scroll or
    // key leaves no enter, leave or motion behind in the human's window.
    clearPointerDelivery();
    clearKeyboardDelivery();
    seat.m_state.keyboardFocus = human;
    keyboardEntered = human.get();
    pointerEntered = human.get();
    onSeatKeyboardFocusChange();
    onSeatPointerFocusChange();
    const int wireBefore = pointerEnters + pointerLeaves + keyboardEnters + keyboardLeaves + motions;
    g.lastAgentInputMs = -1;
    refuse = true;
    expectHumanActive([] { injectButton(272, true); }, "refused click");
    expectHumanActive([] { injectAxis(0, 80); }, "refused scroll");
    expectHumanActive([] { injectKey(30, true); }, "refused key");
    refuse = false;
    check(pointerEnters + pointerLeaves + keyboardEnters + keyboardLeaves + motions == wireBefore, "a refused action sent enter, leave or motion events first");
    check(pointerEntered == human.get() && keyboardEntered == human.get(), "a refused action moved the human's focus");
    // Only delivered input is what waitForSettle waits out.
    check(g.lastAgentInputMs == -1, "a refused action counted as agent input");
    clockMs = 42;
    check(injectKey(30, true) && injectKey(30, false) && g.lastAgentInputMs == 42, "a delivered key did not count as agent input");
    clockMs = 43;
    check(injectAxis(0, 80) && g.lastAgentInputMs == 43, "a delivered scroll did not count as agent input");

    // Same surface (N3): the human's pointer sits on the very surface the
    // agent aims at. The enter is shared and stays, but every agent burst ends
    // with the seat's position re-sent, so the human's bare scroll or click
    // lands under their own pointer, not at the agent's last spot.
    clearPointerDelivery();
    hitSurface = agent;
    seat.m_state.pointerFocus = agent;
    pointerEntered = agent.get();
    pointerAt = SEAT_LOCAL;
    onSeatPointerFocusChange();
    check(movePointer(300, 300), "same-surface move refused");
    check(pointerEntered == agent.get() && samePoint(pointerAt, SEAT_LOCAL), "same-surface move left the agent's position with the human");
    check(injectAxis(0, 80) && samePoint(axisAt, AGENT_LOCAL), "same-surface scroll not aimed at the agent's position");
    check(samePoint(pointerAt, SEAT_LOCAL), "same-surface scroll left the agent's position with the human");
    before = motions;
    check(injectKey(30, true) && injectKey(30, false), "key refused");
    check(motions == before, "position handed back again with nothing to hand back");
    // Mid-drag the agent stays at its grab point until the human acts; their
    // event is preceded by their own position, once.
    check(injectButton(272, true) && samePoint(buttonAt, AGENT_LOCAL) && samePoint(pointerAt, AGENT_LOCAL), "same-surface press misplaced");
    handBackPointerBeforeHumanEvent();
    check(pointerEntered == agent.get() && samePoint(pointerAt, SEAT_LOCAL), "human event during a same-surface drag landed at the agent's grab point");
    before = motions;
    handBackPointerBeforeHumanEvent();
    check(motions == before, "same-surface hand-back repeated for every human event");
    check(injectButton(272, false) && samePoint(buttonAt, GRAB_LOCAL), "same-surface release not at the agent's grab position");
    check(g.pressedButtons.empty() && samePoint(pointerAt, SEAT_LOCAL), "same-surface release did not hand the position back");
    // Leaving the shared surface revokes nothing, but the position goes back.
    check(movePointer(310, 310) && samePoint(pointerAt, SEAT_LOCAL), "move refused");
    g.directPointerHandedBack = false;
    pointerAt = AGENT_LOCAL;
    clearPointerDelivery();
    check(pointerEntered == agent.get() && samePoint(pointerAt, SEAT_LOCAL), "leaving the shared surface left the agent's position");
    seat.m_state.pointerFocus = human;
    pointerEntered = human.get();
    onSeatPointerFocusChange();

    // Same surface, keyboard (N4): the human's keyboard focus is on the very
    // surface the agent types into, with NumLock on. The agent's keys go out
    // under the human's locks, and the seat's own modifiers are back after
    // every burst.
    clearKeyboardDelivery();
    hitSurface = agent;
    seat.m_state.keyboardFocus = agent;
    keyboardEntered = agent.get();
    onSeatKeyboardFocusChange();
    seatKb.m_modifiersState = {0, 0, NUMLOCK, 0};
    clientMods = seatKb.m_modifiersState;
    check(injectKey(30, true) && injectKey(30, false), "same-surface key refused");
    check(keyMods.locked == NUMLOCK, "agent key sent with the human's NumLock forced off");
    check(clientMods == seatKb.m_modifiersState, "seat modifiers not restored after a same-surface burst");
    check(injectKey(29, true) && injectKey(30, true), "same-surface chord refused");
    check(keyMods == Mods{CTRL, 0, NUMLOCK, 0}, "chord key not sent under the agent's Ctrl and the human's NumLock");
    // The human types mid-chord: their key is under their own modifiers, and
    // the agent's next key under the agent's again.
    handBackKeyboardBeforeHumanKey();
    check(clientMods == seatKb.m_modifiersState && keyboardEntered == agent.get(), "human key mid-chord ran under the agent's Ctrl");
    check(injectKey(30, false) && keyMods.depressed == CTRL, "agent key after the human's not under the agent's Ctrl");
    check(injectKey(29, false) && clientMods == seatKb.m_modifiersState, "chord end did not restore the seat's modifiers");
    // The human toggles CapsLock between bursts; the agent follows it.
    seatKb.m_modifiersState = {0, 0, NUMLOCK | CAPS, 0};
    clientMods = seatKb.m_modifiersState;
    check(injectKey(30, true) && keyMods.locked == (NUMLOCK | CAPS), "agent did not pick up the human's CapsLock");
    check(injectKey(30, false), "release refused");
    // The human holds Shift on that surface: the agent's key is not shifted
    // by it, and their Shift is theirs again after the burst.
    seatKb.m_modifiersState = {SHIFT, 0, NUMLOCK, 0};
    clientMods = seatKb.m_modifiersState;
    check(injectKey(30, true) && keyMods == Mods{0, 0, NUMLOCK, 0}, "agent key shifted by the human's Shift");
    check(injectKey(30, false) && clientMods == seatKb.m_modifiersState, "the human's Shift was not restored after the burst");
    // A stop with a key held releases it and leaves the seat's modifiers.
    check(injectKey(29, true), "held key refused");
    clearKeyboardDelivery();
    check(g.pressedKeys.empty() && clientMods == seatKb.m_modifiersState, "same-surface release left the agent's modifiers");

    // No stray modifiers into the human's sibling (P2): with the agent's
    // enter gone stale and nothing held, clearing delivery sends nothing to
    // the window the client's keyboard now belongs to - the human holds Shift
    // there, which an agent modifiers(0) would have cleared.
    seat.m_state.keyboardFocus = human;
    keyboardEntered = human.get();
    onSeatKeyboardFocusChange();
    seatKb.m_modifiersState = {SHIFT, 0, 0, 0};
    clientMods = seatKb.m_modifiersState;
    check(injectKey(29, true) && keyboardEntered == agent.get(), "sibling chord refused");
    keyboardEntered = human.get(); // the human clicks their window mid-chord
    onSeatKeyboardFocusChange();
    clearKeyboardDelivery();
    check(g.pressedKeys.empty() && keyboardEntered == human.get() && clientMods == seatKb.m_modifiersState, "release did not leave the human's modifiers");
    check(injectKey(30, true) && injectKey(30, false) && keyboardEntered == human.get(), "key refused");
    keyboardEntered = human.get();
    onSeatKeyboardFocusChange();
    clearKeyboardDelivery();
    check(clientMods == seatKb.m_modifiersState, "stray agent modifiers reached the human's sibling");
    seatKb.m_modifiersState = {};
    clientMods = {};

    // keys: a batch is one agent burst. Every stroke is delivered in order to
    // the target, and the keyboard is handed back once, after the batch,
    // instead of after every stroke.
    seat.m_state.keyboardFocus = human;
    keyboardEntered = human.get();
    g.directKeyboardSurface.reset();
    g.directKeyboardNeedsEnter = true;
    before = keyEvents;
    int entersBefore = keyboardEnters;
    using Stroke = sdbus::Struct<uint32_t, bool>;
    check(injectKeys({Stroke{30, true}, Stroke{30, false}, Stroke{31, true}, Stroke{31, false}}) == 4, "batch not delivered");
    check(keyEvents == before + 4 && keyboardEntered == human.get() && g.pressedKeys.empty(), "batch misdirected or not handed back");
    check(keyboardEnters == entersBefore + 2, "batch handed the keyboard back between strokes");
    check(injectKeys({}) == 0, "empty batch delivered something");
    // The first stroke's refusal is the call's error, like `key`'s...
    refuse = true;
    before = keyEvents;
    expectHumanActive([] { injectKeys({Stroke{30, true}}); }, "first-stroke refusal was not the batch's error");
    check(keyEvents == before && keyboardEntered == human.get(), "refused batch sent input");
    refuse = false;
    // ... and a later one ends the batch with the count delivered so far.
    refuseAfter = 1;
    check(injectKeys({Stroke{30, true}, Stroke{31, true}, Stroke{31, false}}) == 1, "batch did not stop at the refused stroke");
    check(keyEvents == before + 1, "strokes after the refusal were sent");
    refuse = false;
    refuseAfter = -1;
    clearKeyboardDelivery();
    check(g.pressedKeys.empty() && keyboardEntered == human.get(), "partial batch left keys held");
    bool tooMany = false;
    try { injectKeys(std::vector<Stroke>(257, Stroke{30, true})); } catch (const sdbus::Error& error) { tooMany = error.name == "org.freedesktop.DBus.Error.InvalidArgs"; }
    check(tooMany && keyEvents == before + 2, "oversized batch was not refused up front");

    // ResetInputDelivery: everything held goes, addressed correctly, the
    // target is forgotten, and both shared objects are the seat's again.
    check(injectButton(272, true) && injectKey(29, true), "press before reset refused");
    g.targetWindow = hitWindow;
    g.targetRequested = true;
    pointerEntered = human.get();
    keyboardEntered = human.get();
    onSeatPointerFocusChange();
    onSeatKeyboardFocusChange();
    const int dismissalsBefore = popupDismissals;
    check(resetInputDelivery(), "reset failed");
    check(popupDismissals == dismissalsBefore + 1, "a lease reset left the agent's popups open");
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
