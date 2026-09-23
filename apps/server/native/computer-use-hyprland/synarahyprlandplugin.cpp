/*
    SPDX-FileCopyrightText: 2026 Synara

    SPDX-License-Identifier: GPL-2.0-or-later
*/

// The Hyprland twin of the KWin computer-use plugin.
//
// Same D-Bus surface — `org.synara.ComputerUse` at `/org/synara/ComputerUse`,
// interface `org.synara.ComputerUse1`, the same methods (described in
// org.synara.ComputerUse.xml next to this file) and the same `sessionStopped`
// signal — so the entire server-side driving path built for the KWin plugin
// works unchanged; only how the plugin gets loaded differs (`hyprctl plugin
// load` here, `org.kde.KWin.Plugins` there).
//
// This plugin only ever runs on the human's live compositor, so it is always
// the `!ownsCompositor` shape of the KWin plugin: the agent gets a drawn ghost
// cursor and per-client direct injection, and never a real seat or the human's
// pointer. See the KWin plugin for the full design discussion; comments here
// cover only what Hyprland does differently.
//
// Threading: everything runs on the compositor thread. The D-Bus connection is
// driven by Hyprland's own Wayland event loop (its fds are registered as event
// sources), so method handlers may touch compositor state directly, exactly
// like the KWin plugin's QDBus slots.

#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/plugins/PluginSystem.hpp>
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/SharedDefs.hpp>
#include <hyprland/src/event/EventBus.hpp>
#include <hyprland/src/render/OpenGL.hpp>
#include <hyprland/src/render/Renderer.hpp>
#include <hyprland/src/render/Texture.hpp>
#include <hyprland/src/render/pass/TexPassElement.hpp>
#include <hyprland/src/render/pass/ClearPassElement.hpp>
#include <hyprland/src/render/Framebuffer.hpp>
#include <hyprland/src/render/gl/GLFramebuffer.hpp>
#include <hyprland/src/helpers/time/Time.hpp>
#include <hyprland/src/desktop/state/WindowState.hpp>
#include <hyprland/src/desktop/state/FocusState.hpp>
#include <hyprland/src/desktop/state/ViewState.hpp>
#include <hyprland/src/desktop/state/ViewStateTracker.hpp>
#include <hyprland/src/desktop/state/ViewHitTester.hpp>
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/Workspace.hpp>
#include <hyprland/src/state/MonitorState.hpp>
#include <hyprland/src/output/Monitor.hpp>
#include <hyprland/src/managers/input/InputManager.hpp>
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/managers/SessionLockManager.hpp>
#include <aquamarine/backend/Session.hpp>
#include <hyprland/src/devices/IKeyboard.hpp>
#include <hyprland/src/devices/ITouch.hpp>
#include <hyprland/src/devices/Tablet.hpp>
#include <hyprland/src/protocols/core/Seat.hpp>
#include <hyprland/src/protocols/core/Compositor.hpp>
#include <hyprland/src/protocols/core/Subcompositor.hpp>
#include <hyprland/src/protocols/XDGShell.hpp>
#include <hyprland/src/desktop/view/WLSurface.hpp>
#include <hyprland/src/desktop/view/Popup.hpp>
#include <hyprland/src/xwayland/XSurface.hpp>
#include <hyprland/src/managers/KeybindManager.hpp>
#include <hyprland/src/debug/log/Logger.hpp>

#include <cairo/cairo.h>
#include "capturetransform.h"
#include <png.h>
#include "sessionauth.h"
#include <poll.h>
#include <sdbus-c++/sdbus-c++.h>
#include <sys/eventfd.h>
#include <turbojpeg.h>
#include <unistd.h>
#include <wayland-server-core.h>
#include <wayland-server-protocol.h>
#include <xkbcommon/xkbcommon.h>

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <format>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#ifndef SYNARA_CU_BUILD_ID
#define SYNARA_CU_BUILD_ID "dev"
#endif
#ifndef SYNARA_CU_GIT_HASH
#define SYNARA_CU_GIT_HASH "unknown"
#endif
#ifndef SYNARA_CU_BUILD_TS
#define SYNARA_CU_BUILD_TS ""
#endif

inline HANDLE PHANDLE = nullptr;

namespace {

// Runs the D-Bus connection's processing passes and re-arms its poll sources;
// defined with the plumbing below, needed by anything that emits a signal
// from outside a pass.
void driveDbus();
// Frees the capture stream's idle pixel-pack buffers; defined with the
// capture jobs, needed when a session stops.
void releaseIdlePixelPackBuffers();
// waitForSettle's commit observation, which lives as long as a session;
// defined with waitForSettle.
void startCommitTracking();
void stopCommitTracking();

// ---------------------------------------------------------------------------
// Constants shared with the KWin plugin. Names and values must stay in lock
// step with synaracomputeruseplugin.cpp: the server treats both plugins as the
// same service.
// ---------------------------------------------------------------------------

constexpr const char* SERVICE_NAME   = "org.synara.ComputerUse";
constexpr const char* OBJECT_PATH    = "/org/synara/ComputerUse";
constexpr const char* INTERFACE_NAME = "org.synara.ComputerUse1";

constexpr const char* ERR_CAPTURE          = "org.synara.ComputerUse.Error.CaptureFailed";
constexpr const char* ERR_RELEASED         = "org.synara.ComputerUse.Error.ControlReleased";
constexpr const char* ERR_SEAT_UNSUPPORTED = "org.synara.ComputerUse.Error.SeatUnsupported";
constexpr const char* ERR_HUMAN_ACTIVE     = "org.synara.ComputerUse.Error.HumanActive";
constexpr const char* ERR_SESSION_LOCKED   = "org.synara.ComputerUse.Error.SessionLocked";

constexpr uint32_t MIN_IDLE_TIMEOUT_MS     = 1000;
constexpr uint32_t MAX_IDLE_TIMEOUT_MS     = 60 * 60 * 1000;
constexpr uint32_t DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

constexpr uint32_t MIN_HUMAN_ACTIVE_GUARD_MS     = 100;
constexpr uint32_t MAX_HUMAN_ACTIVE_GUARD_MS     = 60 * 1000;
constexpr uint32_t DEFAULT_HUMAN_ACTIVE_GUARD_MS = 2000;

constexpr const char* AGENT_FALLBACK_NAME = "Agent";
// The panic chord goes through Hyprland's own keybind manager, like any
// `bind =` line: a dispatcher the user can bind to whatever they like, and a
// default bind on the same chord as the KWin plugin when the user has left
// that chord free. Recognising the chord from raw key events instead would
// fire under a client's keyboard grab, shadow a user's own bind on the chord,
// and swallow the Escape press before the compositor saw it.
constexpr const char* RELEASE_DISPATCHER     = "synara:releasecontrol";
constexpr const char* RELEASE_KEY            = "Escape";
constexpr uint32_t    RELEASE_MODMASK        = HL_MODIFIER_META | HL_MODIFIER_SHIFT;
// The default bind, spelled the way the availability card shows it.
constexpr const char* RELEASE_SHORTCUT_LABEL = "Meta+Shift+Esc";

// Ghost cursor artwork, identical to the KWin plugin's: Synara violet fill,
// white rim, dark translucent ink outline, and a name badge below-right of the
// hotspot. The silhouette is the same tip-at-origin arrow, in fractions of the
// cursor size.
constexpr struct {
    double x, y;
} CURSOR_OUTLINE[] = {
    {0.00, 0.00}, {0.00, 0.76}, {0.19, 0.58}, {0.30, 0.88}, {0.44, 0.82}, {0.32, 0.54}, {0.56, 0.54},
};

struct SColor {
    double r, g, b, a;
};
constexpr SColor ACCENT_COLOR = {0x7c / 255.0, 0x3a / 255.0, 0xed / 255.0, 1.0};
constexpr SColor RIM_COLOR    = {1.0, 1.0, 1.0, 1.0};
constexpr SColor INK_COLOR    = {0x14 / 255.0, 0x0a / 255.0, 0x2e / 255.0, 0x99 / 255.0};

constexpr double INK_STROKE_RATIO     = 0.085;
constexpr double RIM_STROKE_RATIO     = 0.045;
constexpr double MIN_INK_STROKE_WIDTH = 1.8;
constexpr double MIN_RIM_STROKE_WIDTH = 1.0;
constexpr int    BADGE_MIN_TEXT_PIXELS      = 11;
constexpr double BADGE_MAX_TEXT_WIDTH_RATIO = 8;
constexpr int64_t BADGE_HOLD_MS = 2000;
constexpr int64_t BADGE_FADE_MS = 320;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Whether the desktop is off limits: a session lock is held (from the moment a
// locker asks for one until it is released, including a locker that died with
// the screen still locked), or the compositor's logind session is inactive
// because the human switched to another VT or a greeter. Both are the
// compositor's own answers - it gates its input routing and lock-screen
// rendering on the same two facts - so the plugin cannot disagree with what
// the human sees on screen.
bool sessionLocked() {
    if (g_pSessionLockManager && g_pSessionLockManager->isSessionLocked())
        return true;
    return g_pCompositor && !g_pCompositor->m_sessionActive;
}

double inkStrokeWidth(double size) {
    return std::max(MIN_INK_STROKE_WIDTH, size * INK_STROKE_RATIO);
}

double rimStrokeWidth(double size) {
    return std::max(MIN_RIM_STROKE_WIDTH, size * RIM_STROKE_RATIO);
}

// Transparent room for the strokes, which extend outward past the silhouette on
// every side including the tip. In logical pixels, and therefore also the
// offset from the drawn image's corner to the hotspot.
double strokeMargin(double size) {
    return inkStrokeWidth(size) / 2 + 1;
}

// ---------------------------------------------------------------------------
// JSON building. The KWin plugin has Qt's JSON classes; here a minimal builder
// keeps the payloads byte-compatible without pulling a JSON library into the
// compositor.
// ---------------------------------------------------------------------------

std::string jsonEscape(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (const char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20)
                    out += std::format("\\u{:04x}", static_cast<unsigned char>(c));
                else
                    out += c;
        }
    }
    return out;
}

std::string jsonNumber(double v) {
    if (!std::isfinite(v))
        return "0";
    // Integral values print without a fraction, like Qt's JSON writer.
    if (v == std::floor(v) && std::abs(v) < 1e15)
        return std::format("{}", static_cast<int64_t>(v));
    return std::format("{}", v);
}

class JsonObj {
  public:
    JsonObj& raw(std::string_view key, std::string_view rawValue) {
        m_out += m_first ? "\"" : ",\"";
        m_first = false;
        m_out += jsonEscape(key);
        m_out += "\":";
        m_out += rawValue;
        return *this;
    }
    JsonObj& str(std::string_view key, std::string_view value) {
        return raw(key, "\"" + jsonEscape(value) + "\"");
    }
    JsonObj& num(std::string_view key, double value) {
        return raw(key, jsonNumber(value));
    }
    JsonObj& boolean(std::string_view key, bool value) {
        return raw(key, value ? "true" : "false");
    }
    std::string build() const {
        return "{" + m_out + "}";
    }

  private:
    std::string m_out;
    bool        m_first = true;
};

class JsonArr {
  public:
    JsonArr& raw(std::string_view rawValue) {
        if (!m_out.empty())
            m_out += ",";
        m_out += rawValue;
        return *this;
    }
    JsonArr& str(std::string_view value) {
        return raw("\"" + jsonEscape(value) + "\"");
    }
    std::string build() const {
        return "[" + m_out + "]";
    }

  private:
    std::string m_out;
};

std::string rectJson(const CBox& box) {
    return JsonObj{}.num("x", box.x).num("y", box.y).num("width", box.w).num("height", box.h).build();
}

std::string pointJson(const Vector2D& p) {
    return JsonObj{}.num("x", p.x).num("y", p.y).build();
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

struct SListeners {
    CHyprSignalListener renderStage;
    CHyprSignalListener mouseMove;
    CHyprSignalListener mouseButton;
    CHyprSignalListener mouseAxis;
    CHyprSignalListener keyboardKey;
    CHyprSignalListener pointerFocusChange;
    CHyprSignalListener sessionLock;
    CHyprSignalListener sessionUnlock;
    CHyprSignalListener sessionActive;
    CHyprSignalListener tabletAxis;
    CHyprSignalListener tabletButton;
    CHyprSignalListener tabletProximity;
    CHyprSignalListener tabletTip;
    CHyprSignalListener touchDown;
    CHyprSignalListener touchUp;
    CHyprSignalListener touchMotion;
    CHyprSignalListener touchCancel;
    CHyprSignalListener configReloaded;
    CHyprSignalListener keyboardFocusChange;
    CHyprSignalListener viewCreate;
};

// The display serials one burst of agent input minted: every serial after
// `after`, up to and including `last`, compared with wrap-around.
struct SSerialBurst {
    uint32_t after = 0;
    uint32_t last  = 0;
};

// A popup whose grab request this plugin answers, and the handler Hyprland
// installed for it, which human grabs are passed to and which goes back on
// the popup at unload.
struct SWatchedPopup {
    WP<CXDGPopupResource>                                popup;
    std::function<void(CXdgPopup*, wl_resource*, uint32_t)> hyprlandHandler;
};

// Releases the agent owes on a surface whose enter is stale while the human
// holds a mouse button (see P3): delivered at the human's button-up.
struct SDeferredRelease {
    WP<CWLSurfaceResource> surface;
    Vector2D               local;
    std::set<uint32_t>     buttons;
};

// Whether a release may wait for the human's button-up (every agent path) or
// must go out now regardless (plugin unload, where a stuck button outweighs
// a disturbed grab).
enum class ReleaseMode : uint8_t {
    Deferrable,
    Immediate,
};

enum class StopReason : uint8_t {
    Request,
    IdleTimeout,
    UserRelease,
    SessionLocked,
};

// One wl_keyboard.modifiers worth of state.
struct SModifierState {
    uint32_t depressed = 0, latched = 0, locked = 0, group = 0;
    bool     operator==(const SModifierState&) const = default;
};

struct SState {
    bool     running        = false;
    bool     releasedByUser = false;
    uint32_t idleTimeoutMs      = DEFAULT_IDLE_TIMEOUT_MS;
    uint32_t humanActiveGuardMs = DEFAULT_HUMAN_ACTIVE_GUARD_MS;

    std::string agentName;
    std::string stopReason;

    Vector2D pos;

    // Wall-clock bookkeeping, all in steady-clock milliseconds.
    int64_t lastActivityMs   = 0;
    int64_t lastHumanInputMs = -1;
    // The last input the agent delivered, which waitForSettle waits out.
    int64_t lastAgentInputMs = -1;

    // Bumped on every lock/unlock/VT change. Work started under one epoch
    // (a capture being encoded) answers SessionLocked instead of completing
    // when it finds the epoch moved on.
    uint64_t lockEpoch = 0;

    PHLWINDOWREF pointerWindow;
    PHLWINDOWREF keyboardWindow;
    PHLWINDOWREF targetWindow;
    // Distinct from targetWindow being expired: the ref clears itself when the
    // window dies, and the agent still needs to know it asked for that window
    // so the input path can refuse rather than retarget.
    bool targetRequested = false;

    // Direct injection state: the surfaces the agent has told about its pointer
    // and keyboard (its enter/leave bookkeeping, independent of the seat's),
    // and everything it is currently holding down there.
    //
    // A client's wl_pointer is one object, written to by the human's seat and
    // by the agent's injection alike, and the client keeps exactly one
    // "entered" surface on it: the last enter it heard, from either of us.
    // wl_pointer.motion/button/axis name no surface, so where an event lands
    // is decided by whoever entered last. Everything below keeps these
    // invariants, and every function that sends pointer events relies on them:
    //
    //  (P1) directPointerNeedsEnter == false  =>  the client's wl_pointer is
    //       entered on directPointerSurface by the agent's own enter. No seat
    //       focus change has touched a surface of that client since
    //       (onSeatPointerFocusChange clears this), and no hand-back has run
    //       since (returnPointerToSeat, handBackPointerBeforeHumanEvent).
    //       Only under P1 may motion, button and axis events be sent bare.
    //  (P2) directPointerNeedsEnter == true  =>  the client's wl_pointer is
    //       wherever the seat left it: the human's surface of that client, or
    //       nowhere. Anything aimed at the agent's target - including the
    //       release of a button pressed before the invalidation - must be
    //       preceded by a fresh enter on that target (releasePressedButtons,
    //       directPointerMotion).
    //  (P3) pressedButtons are buttons the agent pressed on directPointerSurface
    //       and only the agent releases them, always addressed under P1/P2, so
    //       a release can never land in the human's window as a phantom. A
    //       stale enter is never re-stamped while the human holds a mouse
    //       button: the enter/leave pair would run through their own press in
    //       the sibling window, which toolkits treat as a broken grab. Such a
    //       release is owed instead (deferredReleases) and delivered at the
    //       human's button-up, or by the next agent pointer action, whichever
    //       comes first. The drag itself survives a seat focus change: the
    //       buttons stay held and the next agent event re-stamps the enter.
    //  (P4) When an agent action ends (InputFocusHandback) with the seat's
    //       focus on a sibling surface of the target, the seat's enter has been
    //       re-sent so the human's next event routes to their window. During a
    //       drag, when the agent must stay entered, the same hand-back happens
    //       lazily just before the human's own event instead
    //       (handBackPointerBeforeHumanEvent).
    //  (P5) A client hears one leave before every enter of a different
    //       surface on the same object: whenever the agent enters while the
    //       seat's surface of that client is entered, that surface is left
    //       first, and it is re-entered after the agent's leave.
    //
    // The keyboard has the same shape: directKeyboardSurface and
    // directKeyboardNeedsEnter are its P1/P2 (sendKeyboardEnterEvent re-stamps
    // only when the enter no longer stands), releasePressedKeys addresses
    // releases the same way, onSeatKeyboardFocusChange and
    // handBackKeyboardBeforeHumanKey invalidate and hand back, and
    // returnKeyboardToSeat is its P4. Keys are never deferred: a keyboard has
    // no implicit grab to disturb.
    WP<CWLSurfaceResource> directPointerSurface;
    bool directPointerNeedsEnter = true;
    // Where the agent's pointer last was in directPointerSurface's coordinates:
    // what an enter re-stamped under P2 quotes.
    Vector2D                      directPointerLocal;
    // Set once the seat's own position has been re-sent on a surface the
    // agent and the human's seat share (N3): the client's pointer is back
    // where the human's is, so there is nothing to hand back again until
    // the agent next moves there.
    bool                          directPointerHandedBack = false;
    std::vector<SDeferredRelease> deferredReleases;
    WP<CWLSurfaceResource>        directKeyboardSurface;
    bool                          directKeyboardNeedsEnter = true;
    // The seat's keyboard focus as of its last change signal, for the same
    // reason seatPointerFocus is kept below.
    WP<CWLSurfaceResource> seatKeyboardFocus;
    std::set<uint32_t>     pressedButtons;
    // The seat's pointer focus as of its last change signal. The signal carries
    // no payload, so the surface the seat just left is remembered here: a leave
    // from a sibling surface of the agent's target invalidates the target's
    // enter just as an enter into one does (see onSeatPointerFocusChange).
    WP<CWLSurfaceResource> seatPointerFocus;
    // Ordered, because wl_keyboard.enter carries the held keys as an array and
    // the press order is the honest one to replay.
    std::vector<uint32_t> pressedKeys;
    // Sub-notch scroll owed to clients too old for axis_value120.
    double axisRemainderH = 0;
    double axisRemainderV = 0;
    // The agent's own xkb modifier state, built from the seat keyboard's keymap
    // and fed only the agent's keys, so its Ctrl is never the human's Ctrl.
    // Its locks and latches are the seat's, re-seeded whenever the agent holds
    // nothing (N4): CapsLock and NumLock are the state of the human's keyboard,
    // which the agent's typing lands under too, not something it may reset.
    xkb_state*  xkbState       = nullptr;
    xkb_keymap* xkbStateKeymap = nullptr;
    // Whether the modifiers the agent's keyboard client last heard are the
    // agent's (directKeyboardModifiers) rather than the seat's. A key is only
    // ever sent under the agent's own modifiers, and a hand-back on a surface
    // the human's keyboard focus shares puts the seat's back.
    bool agentModifiersInEffect = false;
    // What the agent last sent there, so an unchanged state is not re-sent.
    SModifierState agentModifiers;

    // Physical keycodes currently held on the human's keyboard: what the
    // seat's enter re-sent by restoreSeatKeyboardEnter reports as held. The
    // human's held buttons are not mirrored here: the input manager's own
    // list (hasHeldButtons) is the one source of truth for those.
    std::set<uint32_t> humanHeldKeys;

    // Ghost cursor render state. Textures are (re)built inside the render hook
    // where a GL context is current, whenever `cursorArtDirty` or the output
    // scale changed.
    bool                    cursorVisible = false;
    bool                    cursorArtDirty = true;
    double                  cursorArtScale = 0;
    double                  cursorSize     = 0;
    SP<Render::ITexture>    cursorTex;
    SP<Render::ITexture>    badgeTex;
    Vector2D                cursorTexLogicalSize;
    Vector2D                badgeTexLogicalSize;
    double                  lastBadgeAlpha = 0;

    // Offscreen framebuffers for region captures, one per monitor, kept for
    // the life of a session: a capture stream re-renders each tick, and a
    // monitor-sized GPU allocation per tick was most of the cost of one.
    std::unordered_map<MONITORID, SP<Render::IFramebuffer>> captureFbs;

    // D-Bus plumbing, driven from the compositor's event loop.
    std::unique_ptr<sdbus::IConnection> dbus;
    std::unique_ptr<sdbus::IObject>     dbusObject;
    std::unique_ptr<SynaraSessionAuth>  authentication;
    wl_event_source*                    dbusFdSource     = nullptr;
    wl_event_source*                    dbusEvtFdSource  = nullptr;
    wl_event_source*                    dbusTimerSource  = nullptr;
    wl_event_source*                    idleTimerSource  = nullptr;
    wl_event_source*                    badgeTimerSource = nullptr;
    // Delivers owed releases once the human's button is up (P3).
    wl_event_source*                    deferredReleaseTimer = nullptr;
    // A pending idle callback for a lock/unlock/VT change, so the state is
    // read after every listener of the emitting signal has run.
    wl_event_source*                    sessionStateIdle = nullptr;
    int                                 dbusEventFd      = -1;
    // driveDbus runs processing passes; a signal emitted from inside one
    // (a method handler stopping the session) must not start another.
    bool                                drivingDbus      = false;

    SListeners listeners;

    // The serials the agent's recent bursts minted, on every path, as a ring
    // of ranges (noteAgentBurst): a popup grab quoting one of them comes from
    // the agent's input, never the human's.
    std::array<SSerialBurst, 512> agentBursts{};
    size_t                        agentBurstNext   = 0;
    size_t                        agentBurstCount  = 0;
    uint32_t                      burstStartSerial = 0;
    // Popups whose grab this plugin answers (watchPopup), and those of them
    // the agent opened, held without a grab, oldest first.
    std::vector<SWatchedPopup>         watchedPopups;
    std::vector<WP<CXDGPopupResource>> agentPopups;
    uint64_t                           popupsDismissed = 0;

    // The release chord as registered with the keybind manager: the default
    // bind if this plugin installed it, and the label of whichever bind is in
    // effect (a user's own bind to the dispatcher wins), or none when the
    // default chord is taken and no user bind names the dispatcher.
    SP<SKeybind>               releaseKeybind;
    std::optional<std::string> effectiveReleaseShortcut;

    std::string hyprlandVersion;
};

SState g;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// Window ids are the CWindow's address, which Hyprland itself uses as the
// window's identity (`hyprctl clients`), plus a generation: the allocator
// reuses an address after a window closes, and a server still holding the
// old id would otherwise aim its next click or Ctrl+Q at whatever new window
// landed there. The first time an address is seen holding a given window it
// takes the next generation, a different window at a reused address takes a
// fresh one, and an id of a closed window never resolves again.
struct SWindowIdentity {
    uint64_t     generation = 0;
    PHLWINDOWREF window;
};
std::unordered_map<uintptr_t, SWindowIdentity> windowIdentities;
uint64_t                                       nextWindowGeneration = 1;

std::string windowId(const PHLWINDOW& w) {
    const auto address  = reinterpret_cast<uintptr_t>(w.get());
    auto&      identity = windowIdentities[address];
    if (identity.window.lock() != w) {
        identity.generation = nextWindowGeneration++;
        identity.window     = w;
    }
    return std::format("{:x}-{}", address, identity.generation);
}

PHLWINDOW findWindowById(const std::string& id) {
    const auto dash = id.find('-');
    if (dash == std::string::npos || dash == 0 || dash + 1 >= id.size())
        return nullptr;
    std::string hex = id.substr(0, dash);
    if (hex.starts_with("0x") || hex.starts_with("0X"))
        hex = hex.substr(2);
    const std::string generationText = id.substr(dash + 1);
    if (hex.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos || generationText.find_first_not_of("0123456789") != std::string::npos)
        return nullptr;
    uintptr_t address    = 0;
    uint64_t  generation = 0;
    try {
        address    = static_cast<uintptr_t>(std::stoull(hex, nullptr, 16));
        generation = std::stoull(generationText, nullptr, 10);
    } catch (...) {
        return nullptr;
    }
    const auto identity = windowIdentities.find(address);
    if (identity == windowIdentities.end() || identity->second.generation != generation)
        return nullptr;
    const auto w = identity->second.window.lock();
    if (!w)
        return nullptr;
    // Alive is not enough: a window object can outlive its place in the
    // desktop (fading out, being destroyed), and only a listed window is one
    // the agent may aim at.
    for (const auto& listed : Desktop::windowState()->windows()) {
        if (listed == w)
            return w;
    }
    return nullptr;
}

// Entries for closed windows are only needed until their address is reused,
// which windowId handles on its own; the map is pruned on every listing so
// it stays bounded by the windows that have existed since the last one.
void forgetDeadWindowIds() {
    std::erase_if(windowIdentities, [](const auto& entry) { return entry.second.window.expired(); });
}

// Every requirement of a window that can be aimed at: mapped, not hidden, and
// on a workspace that is actually on screen.
bool usableWindow(const PHLWINDOW& w) {
    if (!w || !w->m_isMapped || w->isHidden())
        return false;
    if (w->m_workspace && !w->m_workspace->isVisible())
        return false;
    return true;
}

CBox windowBounds(const PHLWINDOW& w) {
    if (const auto box = w->logicalBox(); box.has_value())
        return *box;
    return w->getFullWindowBoundingBox();
}

// The union of every monitor, which is what the KWin plugin reports as the
// workspace geometry. Hyprland has no single-call equivalent, so fold.
CBox workspaceGeometry() {
    bool   any = false;
    double x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    for (const auto& mon : State::monitorState()->monitors()) {
        if (!mon)
            continue;
        const CBox box = mon->logicalBox();
        if (!any) {
            x1 = box.x;
            y1 = box.y;
            x2 = box.x + box.w;
            y2 = box.y + box.h;
            any = true;
        } else {
            x1 = std::min(x1, box.x);
            y1 = std::min(y1, box.y);
            x2 = std::max(x2, box.x + box.w);
            y2 = std::max(y2, box.y + box.h);
        }
    }
    if (!any)
        return CBox{0, 0, 0, 0};
    return CBox{x1, y1, x2 - x1, y2 - y1};
}

PHLWINDOW windowAtPoint(const Vector2D& pos) {
    return Desktop::viewState()->hitTest().windowAt(pos, Desktop::View::RESERVED_EXTENTS | Desktop::View::INPUT_EXTENTS | Desktop::View::ALLOW_FLOATING);
}

// ---------------------------------------------------------------------------
// Ghost cursor drawing (cairo). Layout mirrors the KWin item pixel for pixel:
// the arrow image's corner sits at hotspot - margin, the badge below-right of
// the hotspot, clear of the arrow.
// ---------------------------------------------------------------------------

double agentCursorSize() {
    // The human's own cursor size, so the ghost is the same physical size as
    // the pointer it sits beside. Hyprland publishes it through XCURSOR_SIZE.
    if (const char* env = std::getenv("XCURSOR_SIZE")) {
        const int size = std::atoi(env);
        if (size > 0)
            return size;
    }
    return 24;
}

void cursorPath(cairo_t* cr, double size) {
    cairo_new_path(cr);
    cairo_move_to(cr, CURSOR_OUTLINE[0].x * size, CURSOR_OUTLINE[0].y * size);
    for (size_t i = 1; i < std::size(CURSOR_OUTLINE); ++i)
        cairo_line_to(cr, CURSOR_OUTLINE[i].x * size, CURSOR_OUTLINE[i].y * size);
    cairo_close_path(cr);
}

void setColor(cairo_t* cr, const SColor& c) {
    cairo_set_source_rgba(cr, c.r, c.g, c.b, c.a);
}

void roundedRectPath(cairo_t* cr, double x, double y, double w, double h, double r) {
    cairo_new_path(cr);
    cairo_arc(cr, x + r, y + r, r, M_PI / 2 * 2, M_PI / 2 * 3);
    cairo_arc(cr, x + w - r, y + r, r, M_PI / 2 * 3, M_PI / 2 * 4);
    cairo_arc(cr, x + w - r, y + h - r, r, 0, M_PI / 2);
    cairo_arc(cr, x + r, y + h - r, r, M_PI / 2, M_PI);
    cairo_close_path(cr);
}

struct SRenderedImage {
    cairo_surface_t* surface = nullptr;
    Vector2D         logicalSize;
};

SRenderedImage renderImage(const Vector2D& logicalSize, double scale, auto&& paint) {
    const int pw = std::max(1, static_cast<int>(std::ceil(logicalSize.x * scale)));
    const int ph = std::max(1, static_cast<int>(std::ceil(logicalSize.y * scale)));
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, pw, ph);
    cairo_t*         cr      = cairo_create(surface);
    cairo_scale(cr, scale, scale);
    paint(cr);
    cairo_destroy(cr);
    cairo_surface_flush(surface);
    return {surface, logicalSize};
}

SRenderedImage renderCursorImage(double size, double scale) {
    const double margin  = strokeMargin(size);
    const double boundsW = 0.56 * size; // rightmost outline point
    const double boundsH = 0.88 * size; // lowest outline point
    return renderImage({boundsW + 2 * margin, boundsH + 2 * margin}, scale, [&](cairo_t* cr) {
        cairo_translate(cr, margin, margin);
        cairo_set_line_join(cr, CAIRO_LINE_JOIN_ROUND);
        cursorPath(cr, size);
        setColor(cr, INK_COLOR);
        cairo_set_line_width(cr, inkStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, RIM_COLOR);
        cairo_set_line_width(cr, rimStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, ACCENT_COLOR);
        cairo_fill(cr);
    });
}

void selectBadgeFont(cairo_t* cr, double size) {
    cairo_select_font_face(cr, "sans-serif", CAIRO_FONT_SLANT_NORMAL, CAIRO_FONT_WEIGHT_BOLD);
    cairo_set_font_size(cr, std::max(double(BADGE_MIN_TEXT_PIXELS), std::round(size * 0.5)));
}

// Drops whole UTF-8 code points from the end, for the badge's eliding.
void utf8PopBack(std::string& s) {
    while (!s.empty() && (static_cast<unsigned char>(s.back()) & 0xC0) == 0x80)
        s.pop_back();
    if (!s.empty())
        s.pop_back();
}

SRenderedImage renderBadgeImage(const std::string& name, double size, double scale) {
    const double margin = strokeMargin(size);

    // Measure with a scratch context so the real surface can be allocated at
    // the right size before any drawing happens.
    cairo_surface_t* scratchSurface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 1, 1);
    cairo_t*         scratch        = cairo_create(scratchSurface);
    selectBadgeFont(scratch, size);

    std::string text     = name;
    const double maxWidth = size * BADGE_MAX_TEXT_WIDTH_RATIO;
    cairo_text_extents_t textExtents;
    cairo_text_extents(scratch, text.c_str(), &textExtents);
    if (textExtents.x_advance > maxWidth) {
        while (!text.empty()) {
            cairo_text_extents(scratch, (text + "…").c_str(), &textExtents);
            if (textExtents.x_advance <= maxWidth)
                break;
            utf8PopBack(text);
        }
        text += "…";
        cairo_text_extents(scratch, text.c_str(), &textExtents);
    }
    cairo_font_extents_t fontExtents;
    cairo_font_extents(scratch, &fontExtents);
    cairo_destroy(scratch);
    cairo_surface_destroy(scratchSurface);

    const double paddingX = std::round(size * 0.30);
    const double paddingY = std::round(size * 0.14);
    const double bodyW    = std::ceil(textExtents.x_advance + 2 * paddingX);
    const double bodyH    = std::ceil(fontExtents.ascent + fontExtents.descent + 2 * paddingY);

    return renderImage({bodyW + 2 * margin, bodyH + 2 * margin}, scale, [&](cairo_t* cr) {
        const double radius = bodyH / 2;
        roundedRectPath(cr, margin, margin, bodyW, bodyH, radius);
        setColor(cr, INK_COLOR);
        cairo_set_line_width(cr, inkStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, ACCENT_COLOR);
        cairo_fill_preserve(cr);
        setColor(cr, RIM_COLOR);
        cairo_set_line_width(cr, rimStrokeWidth(size));
        cairo_stroke(cr);

        selectBadgeFont(cr, size);
        cairo_text_extents_t te;
        cairo_text_extents(cr, text.c_str(), &te);
        cairo_font_extents_t fe;
        cairo_font_extents(cr, &fe);
        setColor(cr, RIM_COLOR);
        cairo_move_to(cr, margin + (bodyW - te.x_advance) / 2, margin + (bodyH - (fe.ascent + fe.descent)) / 2 + fe.ascent);
        cairo_show_text(cr, text.c_str());
    });
}

// The on-screen footprint of the arrow, in global logical coordinates.
CBox cursorBox() {
    const double size   = g.cursorSize > 0 ? g.cursorSize : agentCursorSize();
    const double margin = strokeMargin(size);
    const Vector2D texSize = g.cursorTexLogicalSize.x > 0 ? g.cursorTexLogicalSize : Vector2D{0.56 * size + 2 * margin, 0.88 * size + 2 * margin};
    return CBox{g.pos.x - margin, g.pos.y - margin, texSize.x, texSize.y};
}

// Below and right of the hotspot, clear of the arrow, so the badge never covers
// the pixel the agent is about to click.
CBox badgeBox() {
    const double size   = g.cursorSize > 0 ? g.cursorSize : agentCursorSize();
    const double margin = strokeMargin(size);
    const Vector2D texSize = g.badgeTexLogicalSize.x > 0 ? g.badgeTexLogicalSize : Vector2D{size * 4, size};
    return CBox{g.pos.x + std::round(size * 0.55) - margin, g.pos.y + std::round(size * 0.90) - margin, texSize.x, texSize.y};
}

void damageCursorArea() {
    if (!g_pHyprRenderer)
        return;
    g_pHyprRenderer->damageBox(cursorBox());
    g_pHyprRenderer->damageBox(badgeBox());
}

double easeInOutQuad(double t) {
    return t < 0.5 ? 2 * t * t : 1 - std::pow(-2 * t + 2, 2) / 2;
}

// 1 while held after activity, easing to 0 over the fade window — the KWin
// badge's hold-then-fade, computed per frame instead of with an animation
// object.
double badgeAlpha() {
    const int64_t elapsed = nowMs() - g.lastActivityMs;
    if (elapsed < BADGE_HOLD_MS)
        return 1;
    if (elapsed < BADGE_HOLD_MS + BADGE_FADE_MS)
        return 1 - easeInOutQuad(double(elapsed - BADGE_HOLD_MS) / BADGE_FADE_MS);
    return 0;
}

void ensureCursorTextures(double scale) {
    const double size = agentCursorSize();
    if (!g.cursorArtDirty && g.cursorArtScale == scale && g.cursorSize == size && g.cursorTex)
        return;

    SRenderedImage cursor = renderCursorImage(size, scale);
    SRenderedImage badge  = renderBadgeImage(g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName, size, scale);

    g.cursorTex            = g_pHyprRenderer->createTexture(cursor.surface);
    g.badgeTex             = g_pHyprRenderer->createTexture(badge.surface);
    g.cursorTexLogicalSize = cursor.logicalSize;
    g.badgeTexLogicalSize  = badge.logicalSize;
    cairo_surface_destroy(cursor.surface);
    cairo_surface_destroy(badge.surface);

    g.cursorArtDirty = false;
    g.cursorArtScale = scale;
    g.cursorSize     = size;
}

void onRenderLastMoment() {
    // Never over the lock screen: the session is stopped on lock, and this
    // covers the frames between the lock and that stop.
    if (!g.running || !g.cursorVisible || !g_pHyprRenderer || sessionLocked())
        return;
    const auto monitor = g_pHyprRenderer->m_renderData.pMonitor.lock();
    if (!monitor)
        return;

    const CBox monitorBox = monitor->logicalBox();
    const CBox arrow      = cursorBox();
    const CBox badge      = badgeBox();
    const double alpha    = badgeAlpha();

    const auto overlaps = [&](const CBox& box) {
        return box.x < monitorBox.x + monitorBox.w && box.x + box.w > monitorBox.x && box.y < monitorBox.y + monitorBox.h && box.y + box.h > monitorBox.y;
    };
    if (!overlaps(arrow) && !(alpha > 0 && overlaps(badge)))
        return;

    ensureCursorTextures(monitor->m_scale);
    if (!g.cursorTex)
        return;

    // Pass element boxes are monitor-local pixels, like every box the core
    // renderer queues.
    const auto toLocal = [&](CBox box) {
        return box.translate(-monitor->m_position).scale(monitor->m_scale).round();
    };

    if (alpha > 0 && g.badgeTex && overlaps(badge)) {
        CTexPassElement::SRenderData data;
        data.tex = g.badgeTex;
        data.box = toLocal(badge);
        data.a   = static_cast<float>(alpha);
        g_pHyprRenderer->m_renderPass.add(makeUnique<CTexPassElement>(std::move(data)));
    }
    if (overlaps(arrow)) {
        CTexPassElement::SRenderData data;
        data.tex = g.cursorTex;
        data.box = toLocal(arrow);
        g_pHyprRenderer->m_renderPass.add(makeUnique<CTexPassElement>(std::move(data)));
    }
}

// Keeps the badge fade animating: while its alpha is changing, each rendered
// frame damages the badge so the next one gets scheduled.
void onRenderPre() {
    if (!g.running || !g.cursorVisible || sessionLocked())
        return;
    const double alpha = badgeAlpha();
    if (alpha != g.lastBadgeAlpha) {
        g.lastBadgeAlpha = alpha;
        if (g_pHyprRenderer)
            g_pHyprRenderer->damageBox(badgeBox());
    }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const char* stopReasonName(StopReason reason) {
    switch (reason) {
        case StopReason::IdleTimeout: return "idle-timeout";
        case StopReason::UserRelease: return "user-release";
        case StopReason::SessionLocked: return "session-locked";
        case StopReason::Request: break;
    }
    return "request";
}

void armIdleTimer() {
    if (!g.idleTimerSource)
        return;
    if (g.running && g.idleTimeoutMs > 0) {
        const int64_t remaining = int64_t(g.idleTimeoutMs) - (nowMs() - g.lastActivityMs);
        wl_event_source_timer_update(g.idleTimerSource, static_cast<int>(std::max<int64_t>(1, remaining)));
    } else {
        wl_event_source_timer_update(g.idleTimerSource, 0);
    }
}

void noteActivity() {
    g.lastActivityMs = nowMs();
    armIdleTimer();
    if (g.running && g.cursorVisible && g_pHyprRenderer)
        g_pHyprRenderer->damageBox(badgeBox());
    // The badge holds at full alpha and then fades, but a fade needs frames
    // and a still desktop renders none: this timer damages the badge when
    // the hold ends, and onRenderPre keeps damaging it while its alpha moves.
    if (g.badgeTimerSource)
        wl_event_source_timer_update(g.badgeTimerSource, static_cast<int>(BADGE_HOLD_MS + 1));
}

int64_t idleMilliseconds() {
    return nowMs() - g.lastActivityMs;
}

int64_t humanInputAgeMilliseconds() {
    if (g.lastHumanInputMs < 0)
        return -1;
    return nowMs() - g.lastHumanInputMs;
}

// ---------------------------------------------------------------------------
// Direct per-client input injection.
//
// The KWin plugin's direct path, on Hyprland: events are written straight to
// the target client's own wl_pointer/wl_keyboard resources, never through the
// compositor's input pipeline. The human's seat state is untouched — Hyprland's
// CSeatManager and CWLPointerResource focus bookkeeping never see these events,
// which is exactly the point: the compositor keeps routing the human's devices
// as if the agent did not exist. The only compositor state used is the serial
// counter, so that a client quoting an agent click's serial back (for a popup
// grab or a drag) passes Hyprland's serial validation.
// ---------------------------------------------------------------------------

std::vector<wl_resource*> clientInputResources(wl_client* client, const char* interfaceName) {
    struct SFilter {
        const char*               name;
        std::vector<wl_resource*> out;
    } filter{interfaceName, {}};
    wl_client_for_each_resource(
        client,
        [](wl_resource* resource, void* data) {
            auto* f = static_cast<SFilter*>(data);
            if (std::string_view{wl_resource_get_class(resource)} == f->name)
                f->out.push_back(resource);
            return WL_ITERATOR_CONTINUE;
        },
        &filter);
    return filter.out;
}

SP<CWLSurfaceResource> windowMainSurface(const PHLWINDOW& w) {
    return w ? w->resource() : nullptr;
}

uint32_t directTimestampMs() {
    // Same steady clock as the compositor's own input timestamps, so deltas
    // (double-click detection, kinetic scroll) stay meaningful across the two.
    return static_cast<uint32_t>(nowMs());
}

// A serial the client can quote back: allocated through the seat manager so it
// lands in the client's seat-resource serial list that Hyprland validates
// grab/drag requests against. The display counter is only a fallback for a
// client that somehow holds input resources without a seat resource.
uint32_t directSerial(const SP<CWLSurfaceResource>& surface, bool enter = false) {
    if (surface && g_pSeatManager) {
        if (const auto seatResource = g_pSeatManager->seatResourceForClient(surface->client()))
            return g_pSeatManager->nextSerial(seatResource, enter);
    }
    return wl_display_next_serial(g_pCompositor->m_wlDisplay);
}

void directPointerButtonEvent(const SP<CWLSurfaceResource>& surface, uint32_t code, bool pressed) {
    const auto seatResource = g_pSeatManager ? g_pSeatManager->seatResourceForClient(surface->client()) : nullptr;
    if (!pressed && seatResource)
        g_pSeatManager->clearPointerButtonSerials(seatResource, surface, code);
    const uint32_t serial = seatResource ? g_pSeatManager->nextSerial(seatResource) : wl_display_next_serial(g_pCompositor->m_wlDisplay);
    if (pressed && seatResource)
        g_pSeatManager->recordPointerButtonSerial(seatResource, serial, surface, code);
    const uint32_t time = directTimestampMs();
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_pointer")) {
        wl_pointer_send_button(resource, serial, time, code, pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

// The two enter/leave primitives every path below goes through, so an enter
// always carries an enter serial and every event batch ends in a frame.
void sendPointerEnter(const SP<CWLSurfaceResource>& surface, const Vector2D& local) {
    const uint32_t serial = directSerial(surface, true);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_pointer")) {
        wl_pointer_send_enter(resource, serial, surface->getResource()->resource(), wl_fixed_from_double(local.x), wl_fixed_from_double(local.y));
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

void sendPointerLeave(const SP<CWLSurfaceResource>& surface) {
    const uint32_t serial = directSerial(surface);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_pointer")) {
        wl_pointer_send_leave(resource, serial, surface->getResource()->resource());
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

// A global desktop point in `surface`'s own coordinates.
Vector2D surfaceLocalPosition(const SP<CWLSurfaceResource>& surface, const Vector2D& global) {
    if (const auto hlSurface = surface->m_hlSurface.lock()) {
        if (const auto box = hlSurface->getSurfaceBoxGlobal())
            return global - box->pos();
    }
    return {};
}

// Where the human's pointer is, in the coordinates of the surface the seat
// has entered: the position the seat itself would quote in an enter.
Vector2D seatPointerLocal(const SP<CWLSurfaceResource>& surface) {
    if (!g_pInputManager)
        return {};
    return surfaceLocalPosition(surface, g_pInputManager->getMouseCoordsInternal());
}

void sendPointerMotion(const SP<CWLSurfaceResource>& surface, const Vector2D& local) {
    const uint32_t time = directTimestampMs();
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_pointer")) {
        wl_pointer_send_motion(resource, time, wl_fixed_from_double(local.x), wl_fixed_from_double(local.y));
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

// The hand-back when there is no other surface to hand back to (N3): the
// human's pointer is on the very surface the agent's events went to, so the
// enter is shared and stays, but the client's idea of where the pointer is
// on that surface is the agent's last motion. wl_pointer.axis and .button
// carry no position, so the human's next scroll or click - with no motion of
// theirs in between - would land at the agent's spot. Re-sending the seat's
// position puts it back under the human's hand; the agent's next event sends
// its own motion first, as every agent pointer event does.
void restoreSeatPointerPosition(const SP<CWLSurfaceResource>& surface) {
    if (g.directPointerHandedBack)
        return;
    g.directPointerHandedBack = true;
    sendPointerMotion(surface, seatPointerLocal(surface));
}

// Re-sends the seat's own wl_pointer.enter for the surface the human's pointer
// is on, if that surface belongs to `client`. The agent's enter above took the
// client's shared wl_pointer away from the seat; this gives it back, so the
// human's next motion, scroll, or click is routed to their window again.
void restoreSeatPointerEnter(wl_client* client) {
    if (!g_pSeatManager)
        return;
    const auto seatSurface = g_pSeatManager->m_state.pointerFocus.lock();
    if (!seatSurface || seatSurface->client() != client)
        return;
    sendPointerEnter(seatSurface, seatPointerLocal(seatSurface));
}

bool humanHoldsButton() {
    return g_pInputManager && g_pInputManager->hasHeldButtons();
}

// P5 for the pointer: before the agent enters `surface`, the seat's surface of
// the same client, if entered, is left. restoreSeatPointerEnter puts it back
// once the agent has left again.
void leaveSeatSiblingBeforePointerEnter(const SP<CWLSurfaceResource>& surface) {
    if (!g_pSeatManager)
        return;
    const auto seatSurface = g_pSeatManager->m_state.pointerFocus.lock();
    if (seatSurface && seatSurface != surface && seatSurface->client() == surface->client())
        sendPointerLeave(seatSurface);
}

// Delivery of releases the agent owes on `surface` (P2/P3). Bare when the
// client's pointer is on that surface already (the agent's enter stands, or
// the seat is there); otherwise re-stamped: the seat's sibling is left, the
// pressed surface entered with a fresh serial, the releases sent, the surface
// left, and the seat's own enter restored.
void deliverReleases(const SP<CWLSurfaceResource>& surface, const Vector2D& local, const std::vector<uint32_t>& codes, bool restamp) {
    if (restamp) {
        leaveSeatSiblingBeforePointerEnter(surface);
        sendPointerEnter(surface, local);
    }
    for (const uint32_t code : codes)
        directPointerButtonEvent(surface, code, false);
    if (restamp) {
        sendPointerLeave(surface);
        restoreSeatPointerEnter(surface->client());
    }
}

void deferReleases(const SP<CWLSurfaceResource>& surface, const std::vector<uint32_t>& codes) {
    for (SDeferredRelease& owed : g.deferredReleases) {
        if (owed.surface.lock() == surface) {
            owed.buttons.insert(codes.begin(), codes.end());
            return;
        }
    }
    g.deferredReleases.push_back({surface, g.directPointerLocal, {codes.begin(), codes.end()}});
}

// Pays every owed release (P3). A surface that has gone away took the client's
// memory of the press with it.
void deliverDeferredReleases() {
    std::vector<SDeferredRelease> owed;
    owed.swap(g.deferredReleases);
    for (const SDeferredRelease& entry : owed) {
        const auto surface = entry.surface.lock();
        if (!surface)
            continue;
        // Owed because the enter was stale; only the seat sitting on the
        // pressed surface by now makes a bare release land there.
        const bool seatHere = g_pSeatManager && g_pSeatManager->m_state.pointerFocus.lock() == surface;
        deliverReleases(surface, entry.local, {entry.buttons.begin(), entry.buttons.end()}, !seatHere);
    }
}

// Owed releases go out as soon as the human holds nothing: from the timer the
// human's button-up arms, and before any agent pointer action.
void settleDeferredReleases() {
    if (!g.deferredReleases.empty() && !humanHoldsButton())
        deliverDeferredReleases();
}

// Everything still held is released on the surface that saw the press, because
// nothing else will ever release it: a button left down while the pointer
// migrates stays down in the client being left forever. With `only` set, just
// that one button is released.
//
// Addressing is the whole point (P2/P3). wl_pointer.button names no surface:
// the release lands wherever the client's shared wl_pointer is entered right
// now. That is the pressed surface only while the agent's own enter still
// stands (P1) or while the human's seat happens to be on that very surface.
// Otherwise - after the seat entered a sibling window of the same client,
// which is exactly when onSeatPointerFocusChange invalidates the enter - a bare
// release would arrive in the human's window as a phantom button-up while the
// agent's target kept its button down forever. So the enter is re-stamped on
// the pressed surface first, the releases follow it, a leave closes it, and
// the seat's own enter is put back so the human's next event routes as before.
// Unless the human is mid-press: then the re-stamp waits for their button-up
// (deferReleases), because it would run through their press.
void releasePressedButtons(std::optional<uint32_t> only = std::nullopt, ReleaseMode mode = ReleaseMode::Deferrable) {
    const auto surface = g.directPointerSurface.lock();
    std::vector<uint32_t> codes;
    if (only) {
        if (g.pressedButtons.contains(*only))
            codes.push_back(*only);
    } else {
        codes.assign(g.pressedButtons.begin(), g.pressedButtons.end());
    }
    if (surface && !codes.empty()) {
        const bool seatHere = g_pSeatManager && g_pSeatManager->m_state.pointerFocus.lock() == surface;
        const bool restamp  = g.directPointerNeedsEnter && !seatHere;
        if (restamp && mode == ReleaseMode::Deferrable && humanHoldsButton())
            deferReleases(surface, codes);
        else
            deliverReleases(surface, g.directPointerLocal, codes, restamp);
    }
    for (const uint32_t code : codes)
        g.pressedButtons.erase(code);
    if (!only)
        g.pressedButtons.clear();
}

void directPointerLeave(bool forgetSurface = true) {
    const auto surface = g.directPointerSurface.lock();
    const bool entered = !g.directPointerNeedsEnter;
    g.directPointerNeedsEnter = true;
    if (forgetSurface) {
        g.directPointerSurface.reset();
        // Owed sub-notch clicks belong to the surface that was being scrolled.
        g.axisRemainderH = 0;
        g.axisRemainderV = 0;
    }
    if (!surface || !entered)
        return;
    // Never revoke a focus the human is holding: if their pointer sits on this
    // surface, the enter the client believes in is the seat's, not ours - but
    // the position it holds is the agent's, and goes back to the human's.
    if (g_pSeatManager && g_pSeatManager->m_state.pointerFocus.lock() == surface) {
        restoreSeatPointerPosition(surface);
        return;
    }
    sendPointerLeave(surface);
    // A leave from our surface leaves the client with no entered surface at
    // all, even when the human's pointer is on a sibling window of it.
    restoreSeatPointerEnter(surface->client());
}

// The hand-back, the other half of the shared-object problem. While the human's
// pointer is on another surface of the client the agent is entered on, the
// client's one wl_pointer belongs to whichever of us entered last, and the
// human's motion, scroll, and clicks name no surface: after the agent's enter
// they would all land in the agent's window until the seat happened to send a
// fresh enter of its own. So every agent burst ends by returning the pointer to
// the seat's surface. The logical target and fractional scroll remain, but the
// next agent event re-enters its target first (see directPointerMotion), so the two
// take turns and the human always ends up in possession. Hover state on the
// agent's target does not survive this, which is the right trade: the human is
// using that application right now. A held button is the one exception — a
// drag cannot change surfaces mid-way — so the eager hand-back waits for its
// release, and handBackPointerBeforeHumanEvent covers the drag lazily.
void returnPointerToSeat() {
    if (!g_pSeatManager || !g.pressedButtons.empty())
        return;
    const auto agentSurface = g.directPointerSurface.lock();
    const auto seatSurface  = g_pSeatManager->m_state.pointerFocus.lock();
    if (!agentSurface || !seatSurface || seatSurface->client() != agentSurface->client())
        return;
    if (seatSurface == agentSurface) {
        // One surface, one enter: only the position is the agent's (N3).
        if (!g.directPointerNeedsEnter)
            restoreSeatPointerPosition(agentSurface);
        return;
    }
    // Keep the logical target and its fractional scroll while returning the
    // protocol object. The next motion must enter again before sending input.
    directPointerLeave(false);
}

// The drag-time hand-back (P4's second half). While the agent holds a button
// it stays entered on its target, and if the human's pointer is on a sibling
// window of the same client, their motion, scroll and clicks - which name no
// surface - would all be routed by the client into the agent's window for as
// long as that enter stands. This runs from the input-manager listeners, which
// fire before the seat routes the human's event, and re-sends the seat's enter
// so the event lands in the human's window. The agent's next event re-enters
// its target first (P2), its button still held: wl_pointer.enter carries no
// button state, so the client keeps what it was told. The target's drag may
// not survive an enter/leave in every toolkit; the human's routing is worth
// that, because it is their window and their hand on the mouse.
void handBackPointerBeforeHumanEvent() {
    if (g.directPointerNeedsEnter || !g_pSeatManager)
        return;
    const auto agentSurface = g.directPointerSurface.lock();
    const auto seatSurface  = g_pSeatManager->m_state.pointerFocus.lock();
    if (!agentSurface || !seatSurface || seatSurface->client() != agentSurface->client())
        return;
    if (seatSurface == agentSurface) {
        // The agent's drag is on the human's own surface: their event must
        // still land where their pointer is, not at the agent's grab point.
        restoreSeatPointerPosition(agentSurface);
        return;
    }
    g.directPointerNeedsEnter = true;
    sendPointerLeave(agentSurface);
    restoreSeatPointerEnter(agentSurface->client());
}

// Enter-if-needed plus motion, aimed by the ghost cursor's position. The hit
// test descends into the window's popups and subsurfaces, so an open dropdown
// of the target receives the events meant for the pixel it covers.
void directPointerMotion(const PHLWINDOW& window) {
    Vector2D   local;
    const auto surface = Desktop::viewState()->hitTest().windowSurfaceAt(g.pos, window, local);
    if (!surface) {
        releasePressedButtons();
        directPointerLeave();
        return;
    }
    if (!g.directPointerSurface.expired() && g.directPointerSurface.lock() != surface) {
        releasePressedButtons();
        directPointerLeave();
    }
    const auto resources = clientInputResources(surface->client(), "wl_pointer");
    if (resources.empty()) {
        // A client holding no wl_pointer cannot be told about an enter, and
        // claiming the surface as entered anyway would swallow the enter it
        // still needs if it binds a pointer later (a client binds one the
        // moment the seat first advertises the capability). Left unclaimed,
        // the next motion retries the enter against whatever it holds then.
        releasePressedButtons();
        directPointerLeave();
        return;
    }
    const bool reenter    = g.directPointerNeedsEnter || g.directPointerSurface.lock() != surface;
    g.directPointerSurface = surface;
    g.directPointerNeedsEnter = false;
    g.directPointerLocal      = local;
    g.directPointerHandedBack = false;
    if (reenter)
        leaveSeatSiblingBeforePointerEnter(surface);
    const uint32_t time   = directTimestampMs();
    const uint32_t serial = reenter ? directSerial(surface, true) : 0;
    for (wl_resource* resource : resources) {
        if (reenter)
            wl_pointer_send_enter(resource, serial, surface->getResource()->resource(), wl_fixed_from_double(local.x), wl_fixed_from_double(local.y));
        wl_pointer_send_motion(resource, time, wl_fixed_from_double(local.x), wl_fixed_from_double(local.y));
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

// The implicit grab. A pointer that presses a button belongs to the surface
// that saw the press until the last button is up, wherever it moves: a
// scrollbar dragged past the window's edge, a selection dragged out of a
// text field, a drag between windows. So while the agent holds a button its
// motion keeps going to the pressed surface in that surface's own
// coordinates, whatever the hit test at the ghost's position says, instead
// of releasing the button the moment another surface is under it.
bool pointerGrabbed() {
    return !g.pressedButtons.empty() && !g.directPointerSurface.expired() && usableWindow(g.pointerWindow.lock());
}

void directPointerGrabbedMotion() {
    const auto surface = g.directPointerSurface.lock();
    if (!surface)
        return;
    const Vector2D local   = surfaceLocalPosition(surface, g.pos);
    const bool     reenter = g.directPointerNeedsEnter;
    g.directPointerNeedsEnter = false;
    g.directPointerLocal      = local;
    g.directPointerHandedBack = false;
    if (reenter) {
        // The enter went stale mid-drag (P2); the buttons are still held
        // there, and wl_pointer.enter carries no button state to undo that.
        leaveSeatSiblingBeforePointerEnter(surface);
        sendPointerEnter(surface, local);
    }
    sendPointerMotion(surface, local);
}

void clearPointerDelivery() {
    releasePressedButtons();
    directPointerLeave();
    g.pointerWindow.reset();
}

// The human is mid-press: a click or drag of theirs is in flight on their own
// pointer, and the ghost moving, clicking or scrolling now would interleave
// with it. Refused with the reason rather than returned as a bare false (which
// the server can only report as "plugin rejected"), so the caller knows to
// retry once the button is up. The input manager's own held-button list is the
// only source consulted: it is kept by the code that routes the human's
// presses and releases, so it cannot fall out of step with them the way a
// mirror kept here did when a device went away between its press and release.
void refuseIfHumanHoldsButton() {
    if (!g_pInputManager || !g_pInputManager->hasHeldButtons())
        return;
    throw sdbus::Error(sdbus::Error::Name{ERR_HUMAN_ACTIVE},
                       "The human is holding a mouse button down right now, so the pointer action was not "
                       "performed. It can be retried once they release it.");
}

// The window the agent's pointer is aimed at, decided without a single wire
// event, so that every refusal can be made before any client hears anything:
// the explicit target when one was asked for, the window holding the agent's
// grab while it holds a button, else whatever is under the ghost. Null when
// that is nothing usable. An explicit target owns the pointer: a point it
// does not claim is refused rather than delivered to whatever covers it,
// because the caller can recover from a refusal and cannot recover from a
// click it never made.
PHLWINDOW resolvePointerWindow() {
    if (g.targetRequested) {
        const auto target = g.targetWindow.lock();
        return usableWindow(target) ? target : nullptr;
    }
    if (pointerGrabbed())
        return g.pointerWindow.lock();
    const auto window = windowAtPoint(g.pos);
    return usableWindow(window) ? window : nullptr;
}

// Maintains the pointer's enter/leave state to match the ghost cursor over
// `window` (from resolvePointerWindow), and says whether there is a surface
// to deliver to.
bool deliverPointerFocus(const PHLWINDOW& window) {
    if (!window) {
        clearPointerDelivery();
        return false;
    }
    const bool grabbed = pointerGrabbed() && g.pointerWindow.lock() == window;
    g.pointerWindow    = window;
    if (grabbed)
        directPointerGrabbedMotion();
    else
        directPointerMotion(window);
    return !g.directPointerSurface.expired();
}

bool updatePointerFocus() {
    return deliverPointerFocus(resolvePointerWindow());
}

// The shared-object focus invalidation, the pointer twin of the keyboard's
// enter re-stamp below. A client's wl_pointer is one object, shared between the
// human's seat and the agent's direct injection, and the client keeps exactly
// one "entered" surface on it: whichever enter it heard last, from either of
// us. wl_pointer.motion and .button name no surface, so once the seat has
// entered another surface of the same client — the human moving into the
// second window of the same browser — every agent event still aimed at its
// target is routed by the client to the human's window instead, and once the
// seat leaves that window, to nothing. The agent's own bookkeeping cannot see
// any of that; only this signal can. So whenever the seat's focus moves into or
// out of a surface of the client the agent is entered on, the agent forgets its
// enter (without a leave: the enter the client now believes in is the seat's,
// not ours to revoke — the same rule directPointerLeave already follows for a
// surface the human sits on), and the next motion re-enters the target with a
// fresh serial before anything else is delivered. Buttons the agent is holding
// are released first: they were pressed on a surface the agent can no longer
// address, and a press nobody releases stays down in that client forever.
// Focus changes between other clients are left alone, so hover state on the
// target survives ordinary agent motion.
void onSeatPointerFocusChange() {
    const auto previous = g.seatPointerFocus.lock();
    const auto current  = g_pSeatManager ? g_pSeatManager->m_state.pointerFocus.lock() : nullptr;
    g.seatPointerFocus  = current;

    const auto agentSurface = g.directPointerSurface.lock();
    if (!agentSurface)
        return;
    wl_client* const agentClient = agentSurface->client();
    const bool       touchesAgentClient = (previous && previous->client() == agentClient) || (current && current->client() == agentClient);
    if (!touchesAgentClient)
        return;

    // The enter is stale from here on (P2). Held buttons stay held and the
    // pressed surface is remembered: the drag is addressed by the re-stamp
    // when the agent next moves or releases, and is never released through
    // the human's own press (P3).
    g.directPointerNeedsEnter = true;
    // Owed sub-notch clicks belonged to the enter just invalidated.
    g.axisRemainderH = 0;
    g.axisRemainderV = 0;
}

SP<IKeyboard> seatKeyboard() {
    return g_pSeatManager ? g_pSeatManager->m_keyboard.lock() : nullptr;
}

// The keymap's descriptive name for the seat keyboard's active layout,
// "English (US)", for messages.
std::string keyboardLayoutName() {
    const auto keyboard = seatKeyboard();
    if (!keyboard || !keyboard->m_xkbKeymap)
        return "";
    const char* name = xkb_keymap_layout_get_name(keyboard->m_xkbKeymap, keyboard->m_activeLayout);
    return name ? name : "";
}

// The xkb (RMLVO) name of that layout, "us" or "de", which is what the
// server's typing gate compares: the active entry of the layout list the
// keymap was built from (`kb_layout`, a comma list). A keymap that did not
// come from a layout list - a file, or a virtual keyboard's own map - has no
// short names; the descriptive name stands in, which the server's gate reads
// as it reads the short one: plain US passes, anything else is refused and
// named in the refusal.
std::string keyboardLayout() {
    const auto keyboard = seatKeyboard();
    if (!keyboard)
        return "";
    if (!keyboard->m_keymapOverridden && keyboard->m_xkbFilePath.empty()) {
        std::string_view layouts = keyboard->m_currentRules.layout;
        if (layouts.empty())
            layouts = "us"; // Hyprland's default when kb_layout is unset
        for (uint32_t index = 0; !layouts.empty(); ++index) {
            const auto       comma = layouts.find(',');
            std::string_view entry = layouts.substr(0, comma);
            while (!entry.empty() && entry.front() == ' ')
                entry.remove_prefix(1);
            while (!entry.empty() && entry.back() == ' ')
                entry.remove_suffix(1);
            if (index == keyboard->m_activeLayout)
                return entry.empty() ? keyboardLayoutName() : std::string(entry);
            if (comma == std::string_view::npos)
                break;
            layouts.remove_prefix(comma + 1);
        }
    }
    return keyboardLayoutName();
}

// Whether CapsLock is latched on the seat keyboard. The server's QWERTY
// synthesis is Shift-only, so a latched CapsLock would turn "Hello" into
// "hELLO"; reporting it lets the backend invert its Shift decisions.
bool capsLockOn() {
    const auto keyboard = seatKeyboard();
    return keyboard && keyboard->m_xkbState && xkb_state_mod_name_is_active(keyboard->m_xkbState, XKB_MOD_NAME_CAPS, XKB_STATE_MODS_LOCKED) == 1;
}

void ensureXkbState() {
    xkb_keymap* keymap = nullptr;
    if (const auto keyboard = seatKeyboard())
        keymap = keyboard->m_xkbKeymap;
    if (g.xkbState && g.xkbStateKeymap == keymap)
        return;
    if (g.xkbState) {
        xkb_state_unref(g.xkbState);
        g.xkbState = nullptr;
    }
    g.xkbStateKeymap = keymap;
    if (keymap)
        g.xkbState = xkb_state_new(keymap);
}

// The seat's locks, latches and layout, under whatever the agent itself holds
// (nothing, when this runs): the agent's typing is interpreted with the
// human's CapsLock, NumLock and layout group, as the human's own would be.
void seedAgentXkbState() {
    const auto keyboard = seatKeyboard();
    if (!g.xkbState || !keyboard)
        return;
    const auto& mods = keyboard->m_modifiersState;
    xkb_state_update_mask(g.xkbState, 0, mods.latched, mods.locked, 0, 0, mods.group);
}

// Sends the agent's modifier state to its keyboard client: brought up to date
// first (the seat's keymap, and while the agent holds nothing, the seat's
// locks), and skipped when that client already has exactly this state from
// the agent, so it can run before every key at no cost. `force` is for an
// enter, which a modifiers event must always follow.
void directKeyboardModifiers(bool force = false) {
    const auto surface = g.directKeyboardSurface.lock();
    if (!surface)
        return;
    ensureXkbState();
    if (!g.xkbState)
        return;
    if (g.pressedKeys.empty())
        seedAgentXkbState();
    const SModifierState mods{
        xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_DEPRESSED),
        xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_LATCHED),
        xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_LOCKED),
        xkb_state_serialize_layout(g.xkbState, XKB_STATE_LAYOUT_EFFECTIVE),
    };
    if (!force && g.agentModifiersInEffect && g.agentModifiers == mods)
        return;
    g.agentModifiersInEffect = true;
    g.agentModifiers         = mods;
    const uint32_t serial    = directSerial(surface);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_modifiers(resource, serial, mods.depressed, mods.latched, mods.locked, mods.group);
}

void sendKeyboardLeave(const SP<CWLSurfaceResource>& surface) {
    const uint32_t serial = directSerial(surface);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_leave(resource, serial, surface->getResource()->resource());
}

// P5 for the keyboard: the seat's surface of the same client, if entered, is
// left before the agent's enter; restoreSeatKeyboardEnter puts it back later.
void leaveSeatSiblingBeforeKeyboardEnter(const SP<CWLSurfaceResource>& surface) {
    if (!g_pSeatManager)
        return;
    const auto seatSurface = g_pSeatManager->m_state.keyboardFocus.lock();
    if (seatSurface && seatSurface != surface && seatSurface->client() == surface->client())
        sendKeyboardLeave(seatSurface);
}

// The enter re-stamp. A wl_keyboard.key event names no surface: the client
// routes it to whatever its keyboard last entered, and that keyboard object is
// shared with the human's seat — the human clicking another window mid-type
// would carry the agent's remaining keystrokes with it. The enter is
// re-stamped on the agent's target whenever the agent's own enter no longer
// stands (P2 for the keyboard: a seat focus change touched the client, or a
// hand-back gave the object to the seat), so the next key lands on the target
// whatever the human just did; while it stands (P1) the key goes out bare.
// No keymap is sent with it: the client bound the real seat and already has
// that seat's keymap, the same layout the agent's xkb state mirrors. The keys
// array carries the held state as it is *before* the event this re-stamp
// precedes, so a chord's modifiers survive it.
void sendKeyboardEnterEvent(const SP<CWLSurfaceResource>& surface) {
    if (!g.directKeyboardNeedsEnter && g.directKeyboardSurface.lock() == surface)
        return;
    leaveSeatSiblingBeforeKeyboardEnter(surface);
    wl_array keys;
    wl_array_init(&keys);
    for (const uint32_t key : g.pressedKeys) {
        if (auto* slot = static_cast<uint32_t*>(wl_array_add(&keys, sizeof(uint32_t))))
            *slot = key;
    }
    const uint32_t serial = directSerial(surface, true);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_enter(resource, serial, surface->getResource()->resource(), &keys);
    wl_array_release(&keys);
    g.directKeyboardSurface    = surface;
    g.directKeyboardNeedsEnter = false;
    directKeyboardModifiers(true);
}

void directKeyboardKeyEvent(const SP<CWLSurfaceResource>& surface, uint32_t keyCode, bool pressed) {
    const uint32_t serial = directSerial(surface);
    const uint32_t time   = directTimestampMs();
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_key(resource, serial, time, keyCode, pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
}

// The seat keyboard's modifier state, as the seat itself sends it, to every
// wl_keyboard of `client`: what the human's own keys are interpreted under.
void sendSeatKeyboardModifiers(wl_client* client, uint32_t serial) {
    const auto keyboard = seatKeyboard();
    if (!keyboard)
        return;
    const auto& mods = keyboard->m_modifiersState;
    for (wl_resource* resource : clientInputResources(client, "wl_keyboard"))
        wl_keyboard_send_modifiers(resource, serial, mods.depressed, mods.latched, mods.locked, mods.group);
    g.agentModifiersInEffect = false;
}

// The same-surface hand-back (N4): the human's keyboard focus is on the very
// surface the agent typed into, so the enter is shared and stays, but the
// modifiers that client last heard are the agent's - its Ctrl, and before the
// seeding, a CapsLock and NumLock forced off. The seat's are put back so the
// human's next key means what they typed.
void restoreSeatKeyboardModifiers(const SP<CWLSurfaceResource>& surface) {
    if (!g.agentModifiersInEffect)
        return;
    sendSeatKeyboardModifiers(surface->client(), directSerial(surface));
}

// The keyboard twin of restoreSeatPointerEnter: the seat's own enter for the
// surface the human's keyboard focus is on, if it belongs to `client`, carrying
// the keys the human is physically holding and the seat keyboard's modifier
// state, so a Shift the human has down survives the agent's turn.
void restoreSeatKeyboardEnter(wl_client* client) {
    if (!g_pSeatManager)
        return;
    const auto seatSurface = g_pSeatManager->m_state.keyboardFocus.lock();
    if (!seatSurface || seatSurface->client() != client)
        return;
    wl_array keys;
    wl_array_init(&keys);
    for (const uint32_t key : g.humanHeldKeys) {
        if (auto* slot = static_cast<uint32_t*>(wl_array_add(&keys, sizeof(uint32_t))))
            *slot = key;
    }
    const uint32_t serial = directSerial(seatSurface, true);
    for (wl_resource* resource : clientInputResources(client, "wl_keyboard"))
        wl_keyboard_send_enter(resource, serial, seatSurface->getResource()->resource(), &keys);
    wl_array_release(&keys);
    sendSeatKeyboardModifiers(client, serial);
}

void directKeyboardLeave() {
    const auto surface = g.directKeyboardSurface.lock();
    const bool entered = !g.directKeyboardNeedsEnter;
    g.directKeyboardNeedsEnter = true;
    g.directKeyboardSurface.reset();
    if (!surface || !entered)
        return;
    // As with the pointer: if the human's keyboard focus is here, the enter the
    // client believes in is the seat's, and it is not ours to revoke.
    if (g_pSeatManager && g_pSeatManager->m_state.keyboardFocus.lock() == surface)
        return;
    sendKeyboardLeave(surface);
    restoreSeatKeyboardEnter(surface->client());
}

// Same shape as the pointer's: releases land on the surface that saw the
// press, and the agent's xkb state unwinds with them so a half-finished chord
// cannot leak a held Ctrl into the next window. Addressed like the pointer's
// releases too: wl_keyboard.key names no surface, so unless the seat's
// keyboard focus is on the pressed surface the enter is re-stamped there first
// (carrying the keys still held, as every re-stamp does), and the leave that
// follows hands the shared wl_keyboard back to the seat's surface.
void releasePressedKeys() {
    const auto surface = g.directKeyboardSurface.lock();
    const bool seatHere = surface && g_pSeatManager && g_pSeatManager->m_state.keyboardFocus.lock() == surface;
    const bool restamp  = surface && !g.pressedKeys.empty() && g.directKeyboardNeedsEnter && !seatHere;
    if (restamp)
        sendKeyboardEnterEvent(surface);
    if (surface) {
        for (const uint32_t key : std::vector<uint32_t>(g.pressedKeys))
            directKeyboardKeyEvent(surface, key, false);
    }
    if (g.xkbState) {
        for (const uint32_t key : g.pressedKeys)
            xkb_state_update_key(g.xkbState, key + 8, XKB_KEY_UP);
    }
    g.pressedKeys.clear();
    // The modifiers that go with the releases, only where they can land on
    // the pressed surface: the seat's own on a surface the human's focus
    // shares, the agent's where its enter stands, and none at all while the
    // client's keyboard is the seat's on a sibling window - a modifiers event
    // names no surface, and the agent's would clear the human's Shift there.
    if (surface && seatHere)
        restoreSeatKeyboardModifiers(surface);
    else if (!g.directKeyboardNeedsEnter)
        directKeyboardModifiers();
    if (restamp)
        directKeyboardLeave();
}

// The keyboard hand-back. The re-stamp before every agent key takes the
// client's shared wl_keyboard for that key; if the human is typing in another
// window of the same client, their next key would follow ours into the agent's
// window. After each agent key the seat's enter is put back, unless the agent
// is mid-chord: a Ctrl it still holds must stay where it was pressed.
void returnKeyboardToSeat() {
    if (!g_pSeatManager || !g.pressedKeys.empty())
        return;
    const auto agentSurface = g.directKeyboardSurface.lock();
    const auto seatSurface  = g_pSeatManager->m_state.keyboardFocus.lock();
    if (!agentSurface || !seatSurface || seatSurface->client() != agentSurface->client())
        return;
    if (seatSurface == agentSurface) {
        restoreSeatKeyboardModifiers(agentSurface);
        return;
    }
    if (g.directKeyboardNeedsEnter)
        return;
    g.directKeyboardNeedsEnter = true;
    sendKeyboardLeave(agentSurface);
    restoreSeatKeyboardEnter(agentSurface->client());
}

// The keyboard's drag-time hand-back, the twin of
// handBackPointerBeforeHumanEvent: while the agent holds a modifier its enter
// stands, and the human's keystrokes into a sibling window of the same client
// would follow it into the agent's window. Run from the key listener, which
// fires before the seat routes the key, it gives the object back to the
// seat's surface; the agent's next key re-stamps its target with the chord
// still held (the keys array carries it).
void handBackKeyboardBeforeHumanKey() {
    if (g.directKeyboardNeedsEnter || !g_pSeatManager)
        return;
    const auto agentSurface = g.directKeyboardSurface.lock();
    const auto seatSurface  = g_pSeatManager->m_state.keyboardFocus.lock();
    if (!agentSurface || !seatSurface || seatSurface->client() != agentSurface->client())
        return;
    if (seatSurface == agentSurface) {
        // Mid-chord on the human's own surface: their key is theirs, under
        // their modifiers, not the agent's held Ctrl.
        restoreSeatKeyboardModifiers(agentSurface);
        return;
    }
    g.directKeyboardNeedsEnter = true;
    sendKeyboardLeave(agentSurface);
    restoreSeatKeyboardEnter(agentSurface->client());
}

// The keyboard's focus invalidation, the twin of onSeatPointerFocusChange:
// once the seat's keyboard focus has moved into or out of a surface of the
// client the agent is entered on, the client's wl_keyboard is where the seat
// put it, and the agent's next key re-stamps (P2). Held keys stay held: the
// re-stamp carries them, so a chord survives the human clicking elsewhere.
void onSeatKeyboardFocusChange() {
    const auto previous = g.seatKeyboardFocus.lock();
    const auto current  = g_pSeatManager ? g_pSeatManager->m_state.keyboardFocus.lock() : nullptr;
    g.seatKeyboardFocus = current;
    if (g.directKeyboardNeedsEnter)
        return;
    const auto agentSurface = g.directKeyboardSurface.lock();
    if (!agentSurface)
        return;
    wl_client* const agentClient = agentSurface->client();
    if ((previous && previous->client() == agentClient) || (current && current->client() == agentClient))
        g.directKeyboardNeedsEnter = true;
    // The seat's enter carried the seat's modifiers to that client.
    if (current && current->client() == agentClient)
        g.agentModifiersInEffect = false;
}

void clearKeyboardDelivery() {
    releasePressedKeys();
    directKeyboardLeave();
    g.keyboardWindow.reset();
}

// Target if one was asked for — a target that has gone away fails loudly,
// because a Ctrl+Q aimed at a closing window must not quit whatever sits under
// the ghost cursor instead — else the window the pointer is in. Decided
// without a wire event, like resolvePointerWindow.
PHLWINDOW resolveKeyboardWindow() {
    if (g.targetRequested) {
        const auto target = g.targetWindow.lock();
        return usableWindow(target) ? target : nullptr;
    }
    if (const auto pointerWindow = g.pointerWindow.lock(); usableWindow(pointerWindow))
        return pointerWindow;
    const auto window = windowAtPoint(g.pos);
    return usableWindow(window) ? window : nullptr;
}

// The keyboard's enter bookkeeping for `window` (from resolveKeyboardWindow).
bool deliverKeyboardFocus(const PHLWINDOW& window) {
    if (!window) {
        clearKeyboardDelivery();
        return false;
    }
    const auto surface = windowMainSurface(window);
    if (!surface) {
        clearKeyboardDelivery();
        return false;
    }
    if (g.directKeyboardSurface.lock() != surface) {
        clearKeyboardDelivery();
        g.keyboardWindow       = window;
        g.directKeyboardSurface = surface;
        sendKeyboardEnterEvent(surface);
    } else {
        g.keyboardWindow = window;
    }
    return true;
}

bool updateKeyboardFocus() {
    return deliverKeyboardFocus(resolveKeyboardWindow());
}

// Refuse, out loud, rather than inject into a client that cannot hear us:
// Wayland delivers input per resource, and an event aimed at a client holding
// no matching resource is dropped silently at every layer while the caller
// believes it acted.
void requireReachableClient(const PHLWINDOW& window, const char* interfaceName) {
    const auto surface = windowMainSurface(window);
    if (!surface)
        return;
    if (!clientInputResources(surface->client(), interfaceName).empty())
        return;
    std::string name = window->m_class.empty() ? window->m_title : window->m_class;
    if (name.empty())
        name = "This window";
    throw sdbus::Error(sdbus::Error::Name{ERR_SEAT_UNSUPPORTED},
                       name + " holds no " + (std::string_view{interfaceName} == "wl_pointer" ? "pointer" : "keyboard") +
                           " on any seat, so input to it is dropped silently and the action would have no "
                           "effect. Nothing aimed at this window will work until it asks its seat for input.");
}

// Give way to the person at the keyboard, on their own window: while their
// devices were active within the guard window, the window holding their focus
// is off the table and every other window stays available. Refused rather than
// delayed, because a click queued until they pause would land in a window
// whose state has moved on. Their input never needs disentangling from the
// agent's here: injected events go straight to client resources and never pass
// the input spy, so everything it saw is the human's by construction.
bool overrideRedirect(const PHLWINDOW& w) {
    return w && w->m_isX11 && w->isX11OverrideRedirect();
}

// The toplevel a window belongs to. A Wayland popup is a surface of the
// window that opened it, so it already is that window here. An XWayland
// override-redirect window - a menu, tooltip or combo popup of an X11
// toplevel - is a CWindow of its own, and is walked up to the toplevel
// through the X surface's transient-for chain.
PHLWINDOW toplevelOf(const PHLWINDOW& window) {
    PHLWINDOW current = window;
    for (int depth = 0; overrideRedirect(current) && depth < 16; ++depth) {
        const auto xsurface = current->m_xwaylandSurface.lock();
        const auto parent   = xsurface ? xsurface->m_parent.lock() : nullptr;
        if (!parent)
            break;
        PHLWINDOW owner;
        for (const auto& candidate : Desktop::windowState()->windows()) {
            if (candidate && candidate->m_xwaylandSurface.lock() == parent) {
                owner = candidate;
                break;
            }
        }
        if (!owner)
            break;
        current = owner;
    }
    return current;
}

void refuseIfHumanActive(const PHLWINDOW& window) {
    if (g.humanActiveGuardMs == 0 || !window)
        return;
    const int64_t age = humanInputAgeMilliseconds();
    if (age < 0 || age > int64_t(g.humanActiveGuardMs))
        return;
    const auto human = Desktop::focusState()->window();
    if (!human)
        return;
    // Toplevel-to-toplevel identity: the menu the human has open belongs to
    // their focused window whether it is a Wayland popup (the same window
    // here) or an XWayland override-redirect window (a separate one). An
    // override-redirect window with no transient-for link is still taken as
    // the focused application's if it comes from the same process: nothing
    // but that application's own menus and tooltips takes that shape.
    const auto target = toplevelOf(window);
    const bool sameApplication = overrideRedirect(window) && window->getPID() > 0 && window->getPID() == human->getPID();
    if (window != human && target != toplevelOf(human) && !sameApplication)
        return;
    std::string title = human->m_title.empty() ? human->m_class : human->m_title;
    if (title.empty())
        title = "the focused window";
    throw sdbus::Error(sdbus::Error::Name{ERR_HUMAN_ACTIVE},
                       std::format("The human is using {} right now - their keyboard focus is on it and their own "
                                   "devices were active {} ms ago - so nothing was sent to it. Every other window "
                                   "is still available, and this action can be retried once they have been idle "
                                   "for {} ms.",
                                   title, age, g.humanActiveGuardMs));
}

void setCursorVisible(bool visible) {
    if (g.cursorVisible == visible)
        return;
    g.cursorVisible = visible;
    damageCursorArea();
}

// ---------------------------------------------------------------------------
// Agent-opened popups: the KWin plugin's popup rule (watchPopups there), on
// Hyprland.
//
// Hyprland honours every xdg_popup.grab it is sent, whatever the seat and the
// serial (CXDGShellProtocol::addOrStartGrab), and its grab is the whole seat,
// keyboard and pointer (CSeatManager::setGrab). So a menu the agent opened
// with a direct click took the human's keyboard the moment it mapped -
// measured on 0.56.2: keys the human typed into their own window went to the
// agent's menu - and their next click, wherever it landed, was delivered to
// the menu to dismiss it. When such a grab ends Hyprland refocuses the menu's
// parent window under follow_mouse 0, 2 and 3, which is the agent's window.
//
// The plugin therefore answers every popup's grab request itself. The handler
// is replaced when the popup is created - Hyprland builds the popup's view
// inside the get_popup request, before the client can ask for a grab - and
// the decision is made when the request arrives, with its serial: a grab
// quoting a serial one of the agent's bursts minted, or asked for by a
// submenu of an agent popup, is the agent's and goes no further; every other
// grab is passed to Hyprland's own handler unchanged. An agent popup then
// behaves as a popup without a grab: the human's keyboard and pointer stay
// theirs and their clicks reach what they land on. What the grab did for the
// agent is done here instead: a human press outside the agent's popups
// dismisses them (and is delivered, not eaten), and so do an agent press
// into another application and the session ending or changing hands. A popup
// that never asks for a grab - a tooltip, an autocomplete list - belongs to
// nobody and is left alone.
// ---------------------------------------------------------------------------

// CXDGPopupResource keeps its protocol object private, and CXdgPopup keeps its
// request handlers in a private struct with no name; both are reached with
// the explicit-instantiation exemption used for renderAllClientsForWorkspace.
using PopupProtocolMember = SP<CXdgPopup> CXDGPopupResource::*;
PopupProtocolMember popupProtocolMember();
template <PopupProtocolMember M> struct SPopupProtocolAccess {
    friend PopupProtocolMember popupProtocolMember() {
        return M;
    }
};
template struct SPopupProtocolAccess<&CXDGPopupResource::m_resource>;

struct SXdgPopupRequestsTag {};
auto xdgPopupRequestsMember(SXdgPopupRequestsTag);
template <auto M> struct SXdgPopupRequestsAccess {
    friend auto xdgPopupRequestsMember(SXdgPopupRequestsTag) {
        return M;
    }
};
template struct SXdgPopupRequestsAccess<&CXdgPopup::requests>;

using PopupGrabHandler = std::function<void(CXdgPopup*, wl_resource*, uint32_t)>;

// The grab handler stored on the popup's protocol object, or null.
PopupGrabHandler* popupGrabHandler(const SP<CXDGPopupResource>& popup) {
    CXdgPopup* protocol = popup ? (popup.get()->*popupProtocolMember()).get() : nullptr;
    return protocol ? &(protocol->*xdgPopupRequestsMember(SXdgPopupRequestsTag{})).grab : nullptr;
}

uint32_t displaySerial() {
    return g_pCompositor && g_pCompositor->m_wlDisplay ? wl_display_get_serial(g_pCompositor->m_wlDisplay) : 0;
}

bool serialInBurst(uint32_t serial, const SSerialBurst& burst) {
    return uint32_t(serial - burst.after - 1) < uint32_t(burst.last - burst.after);
}

// Records the serials one burst minted as the agent's. A burst that follows
// the previous one with nothing minted in between extends it, so a run of
// typing costs one slot; the ring keeps the most recent 512.
void noteAgentBurst(uint32_t after, uint32_t last) {
    if (after == last)
        return;
    if (g.agentBurstCount > 0) {
        auto& previous = g.agentBursts[(g.agentBurstNext + g.agentBursts.size() - 1) % g.agentBursts.size()];
        if (previous.last == after) {
            previous.last = last;
            return;
        }
    }
    g.agentBursts[g.agentBurstNext] = {after, last};
    g.agentBurstNext                = (g.agentBurstNext + 1) % g.agentBursts.size();
    g.agentBurstCount               = std::min(g.agentBurstCount + 1, g.agentBursts.size());
}

bool agentMintedSerial(uint32_t serial) {
    for (size_t i = 0; i < g.agentBurstCount; ++i) {
        if (serialInBurst(serial, g.agentBursts[i]))
            return true;
    }
    return false;
}

bool isAgentPopup(const SP<CXDGPopupResource>& popup) {
    return popup && std::ranges::any_of(g.agentPopups, [&](const WP<CXDGPopupResource>& agent) { return agent.lock() == popup; });
}

// The agent's grab: its serial, or a submenu of one of the agent's popups.
bool agentGrab(const SP<CXDGPopupResource>& popup, uint32_t serial) {
    const auto parent = popup->m_parent.lock();
    return agentMintedSerial(serial) || (parent && isAgentPopup(parent->m_popup.lock()));
}

void handlePopupGrab(const WP<CXDGPopupResource>& weak, CXdgPopup* protocol, wl_resource* seat, uint32_t serial) {
    const auto popup = weak.lock();
    if (!popup)
        return;
    if (agentGrab(popup, serial)) {
        std::erase_if(g.agentPopups, [](const WP<CXDGPopupResource>& p) { return p.expired(); });
        g.agentPopups.push_back(popup);
        return;
    }
    const auto watched = std::ranges::find_if(g.watchedPopups, [&](const SWatchedPopup& w) { return w.popup.lock() == popup; });
    if (watched != g.watchedPopups.end() && watched->hyprlandHandler)
        watched->hyprlandHandler(protocol, seat, serial);
}

// A new popup view: its grab request is answered here from now on.
void watchPopup(const PHLVIEW& view) {
    if (!view || view->type() != Desktop::View::VIEW_TYPE_POPUP)
        return;
    const auto surface = view->resource();
    if (!surface || !surface->m_role || surface->m_role->role() != SURFACE_ROLE_XDG_SHELL)
        return;
    const auto xdg   = static_cast<CXDGSurfaceRole*>(surface->m_role.get())->m_xdgSurface.lock();
    const auto popup = xdg ? xdg->m_popup.lock() : nullptr;
    auto*      handler = popupGrabHandler(popup);
    if (!handler || !*handler)
        return;
    std::erase_if(g.watchedPopups, [](const SWatchedPopup& w) { return w.popup.expired(); });
    g.watchedPopups.push_back({popup, *handler});
    const WP<CXDGPopupResource> weak = popup;
    *handler = [weak](CXdgPopup* protocol, wl_resource* seat, uint32_t serial) { handlePopupGrab(weak, protocol, seat, serial); };
}

// At unload: every popup gets Hyprland's own handler back, because the one
// installed here is code that is about to be unmapped.
void unwatchPopups() {
    for (const auto& watched : g.watchedPopups) {
        if (auto* handler = popupGrabHandler(watched.popup.lock()))
            *handler = watched.hyprlandHandler;
    }
    g.watchedPopups.clear();
}

// Newest first, so a submenu goes before the menu that opened it.
void dismissAgentPopups(const std::function<bool(const SP<CXDGPopupResource>&)>& shouldDismiss) {
    const auto popups = g.agentPopups;
    for (auto it = popups.rbegin(); it != popups.rend(); ++it) {
        const auto popup = it->lock();
        if (!popup || !shouldDismiss(popup))
            continue;
        std::erase_if(g.agentPopups, [&](const WP<CXDGPopupResource>& p) { return p.lock() == popup; });
        ++g.popupsDismissed;
        popup->done();
    }
    std::erase_if(g.agentPopups, [](const WP<CXDGPopupResource>& p) { return p.expired(); });
}

void dismissAllAgentPopups() {
    dismissAgentPopups([](const SP<CXDGPopupResource>&) { return true; });
}

bool popupContains(const SP<CXDGPopupResource>& popup, const Vector2D& point) {
    const auto xdg     = popup ? popup->m_surface.lock() : nullptr;
    const auto surface = xdg ? xdg->m_surface.lock() : nullptr;
    const auto view    = surface ? Desktop::View::CWLSurface::fromResource(surface) : nullptr;
    if (!view)
        return false;
    const auto box = view->getSurfaceBoxGlobal();
    return box && box->containsPoint(point);
}

// The human pressed a button: the agent's popups close unless the press is
// on one of them. The press itself goes on to wherever it was going.
void handleHumanPointerPress() {
    if (g.agentPopups.empty() || !g_pInputManager)
        return;
    const Vector2D at = g_pInputManager->getMouseCoordsInternal();
    if (std::ranges::any_of(g.agentPopups, [&](const WP<CXDGPopupResource>& p) { return popupContains(p.lock(), at); }))
        return;
    dismissAllAgentPopups();
}

// The agent pressed into `client`: its popups in any other application close,
// as its grab would have closed them.
void handleAgentPress(wl_client* client) {
    dismissAgentPopups([client](const SP<CXDGPopupResource>& popup) {
        const auto xdg     = popup->m_surface.lock();
        const auto surface = xdg ? xdg->m_surface.lock() : nullptr;
        return !surface || surface->client() != client;
    });
}

size_t agentPopupCount() {
    return std::ranges::count_if(g.agentPopups, [](const WP<CXDGPopupResource>& p) { return !p.expired(); });
}

void emitSessionStopped(const std::string& reason) {
    if (!g.dbusObject)
        return;
    try {
        g.dbusObject->emitSignal("sessionStopped").onInterface(INTERFACE_NAME).withArguments(reason);
    } catch (...) {
        // A failed diagnostic signal must never take the session logic down.
    }
    // Emitted from the idle timer, the panic dispatcher or the lock listener,
    // this is outside any processing pass: the poll mask has to be refreshed
    // here or a partially written signal waits for the next inbound message.
    // From inside a method handler the guard makes this a no-op.
    driveDbus();
}

void stopSession(StopReason reason) {
    const bool wasRunning = g.running;
    const bool latching   = reason == StopReason::UserRelease;
    const bool changed    = wasRunning || (latching && !g.releasedByUser);

    g.running = false;
    setCursorVisible(false);
    // Nothing stays held past the session: a stop that stranded a pressed
    // button or a half-typed chord would leave some client waiting for a
    // release only the agent could have sent.
    clearKeyboardDelivery();
    clearPointerDelivery();
    g.pointerWindow.reset();
    g.keyboardWindow.reset();
    g.targetWindow.reset();
    g.targetRequested = false;
    // A session that ended leaves nothing of the agent's open on the desktop.
    dismissAllAgentPopups();
    g.stopReason      = stopReasonName(reason);
    // Only the human's panic switch latches. An idle timeout is routine, and an
    // explicit server stop ends the session the server itself owns, so both
    // leave the next start() free to run.
    g.releasedByUser = latching;
    armIdleTimer();
    // The capture stream's offscreen buffers live only as long as a session
    // streams them; an idle desktop holds no monitor-sized GPU allocations.
    if (!g.captureFbs.empty()) {
        if (Render::GL::g_pHyprOpenGL)
            Render::GL::g_pHyprOpenGL->makeEGLCurrent();
        g.captureFbs.clear();
    }
    releaseIdlePixelPackBuffers();
    stopCommitTracking();

    if (changed)
        emitSessionStopped(g.stopReason);
}

// Pressing the chord again hands control back without a trip through Synara,
// so a panic stop can never strand the feature.
void handleReleaseShortcut() {
    if (!g.running && g.releasedByUser) {
        g.releasedByUser = false;
        g.stopReason     = "user-resume";
        return;
    }
    stopSession(StopReason::UserRelease);
}

// The chord a keybind is on, spelled the way the KWin plugin's native-text
// sequences and the availability card spell it.
std::string keybindLabel(const SKeybind& bind) {
    std::string label;
    const auto  add = [&](std::string_view part) {
        if (!label.empty())
            label += "+";
        label += part;
    };
    if (bind.modmask & HL_MODIFIER_CTRL)
        add("Ctrl");
    if (bind.modmask & HL_MODIFIER_ALT)
        add("Alt");
    if (bind.modmask & HL_MODIFIER_META)
        add("Meta");
    if (bind.modmask & HL_MODIFIER_SHIFT)
        add("Shift");
    // `bindm` names a mouse button ("mouse:272"), a `code:N` bind a bare
    // evdev keycode, and a catch-all bind any key at all.
    std::string key = bind.catchAll ? "Any key" : bind.key.empty() ? std::format("code:{}", bind.keycode) : bind.key;
    if (bind.mouse && key.starts_with("mouse:"))
        key = "Mouse " + key.substr(6);
    else if (key == "Escape")
        key = "Esc";
    add(key);
    return label;
}

// The effective shortcut for a message, which has to read even when none.
std::string releaseShortcutText() {
    return g.effectiveReleaseShortcut.value_or("the release shortcut (none could be registered)");
}

// The effective shortcut for JSON: a string, or null for none.
std::string releaseShortcutJson() {
    return g.effectiveReleaseShortcut ? "\"" + jsonEscape(*g.effectiveReleaseShortcut) + "\"" : "null";
}

SDispatchResult onReleaseDispatch(std::string) {
    handleReleaseShortcut();
    return {};
}

// Registers the chord with the keybind manager and records what is in
// effect. A user's own `bind = ..., synara:releasecontrol` wins outright:
// they chose it. Otherwise the default chord is installed, unless the user
// already binds that chord to something else - then it is left to them, and
// no shortcut is reported, which the server surfaces as a setup blocker
// rather than firing a release on a chord that means something else here.
// A config reload clears every keybind, this plugin's default included, so
// this runs again after each one.
void registerReleaseShortcut() {
    g.effectiveReleaseShortcut.reset();
    if (!g_pKeybindManager)
        return;
    auto& binds = g_pKeybindManager->m_keybinds;
    if (g.releaseKeybind && std::ranges::find(binds, g.releaseKeybind) == binds.end())
        g.releaseKeybind.reset();
    for (const auto& bind : binds) {
        if (bind && bind != g.releaseKeybind && bind->enabled && bind->handler == RELEASE_DISPATCHER) {
            g.effectiveReleaseShortcut = keybindLabel(*bind);
            return;
        }
    }
    if (!g.releaseKeybind) {
        if (g_pKeybindManager->findConflictingKeybind(XKB_KEY_Escape, RELEASE_MODMASK))
            return;
        SKeybind bind;
        bind.key            = RELEASE_KEY;
        bind.modmask        = RELEASE_MODMASK;
        bind.handler        = RELEASE_DISPATCHER;
        bind.description    = "Release or resume Synara computer control";
        bind.hasDescription = true;
        // A panic chord has to work wherever the human is: from inside any
        // submap, under a client's keyboard-shortcuts inhibitor (a VM viewer
        // or remote desktop that has taken the keyboard), and on the lock
        // screen, where the session is already stopped but the latch may
        // still need toggling.
        bind.submapUniversal = true;
        bind.dontInhibit     = true;
        bind.locked          = true;
        g.releaseKeybind     = g_pKeybindManager->addKeybind(bind);
        if (!g.releaseKeybind)
            return;
    }
    g.effectiveReleaseShortcut = RELEASE_SHORTCUT_LABEL;
}

void unregisterReleaseShortcut() {
    if (g_pKeybindManager && g.releaseKeybind)
        std::erase(g_pKeybindManager->m_keybinds, g.releaseKeybind);
    g.releaseKeybind.reset();
    g.effectiveReleaseShortcut.reset();
}

// Self-healing for the default bind, run from every health and state poll:
// if a reload cleared the keybinds and its `reloaded` signal came before the
// config's own binds were re-added (the order is Hyprland's to change), the
// default is re-registered here rather than staying lost until the next
// reload, and a user bind added meanwhile is picked up the same way.
void ensureReleaseShortcut() {
    if (!g_pKeybindManager)
        return;
    const auto& binds = g_pKeybindManager->m_keybinds;
    if (g.releaseKeybind && std::ranges::find(binds, g.releaseKeybind) != binds.end())
        return;
    registerReleaseShortcut();
}

// Refuses the current D-Bus call with SessionLocked while sessionLocked().
// Every input and capture entry point, and start, checks this at admission, so
// nothing is injected into or read from a desktop the human has locked away;
// the server turns the error into a retryable refusal, not a broken
// connection.
void requireUnlockedSession() {
    if (!sessionLocked())
        return;
    throw sdbus::Error(sdbus::Error::Name{ERR_SESSION_LOCKED},
                       "The desktop session is locked or inactive, so nothing was captured or injected. Retry once the "
                       "human has unlocked it.");
}


bool requireRunning() {
    if (!g.running)
        return false;
    noteActivity();
    return true;
}

std::string modulePath() {
    if (!g_pPluginSystem || !PHANDLE)
        return "";
    const auto* plugin = g_pPluginSystem->getPluginByHandle(PHANDLE);
    return plugin ? plugin->m_path : "";
}

// ---------------------------------------------------------------------------
// D-Bus methods
// ---------------------------------------------------------------------------

// The interface revision and the optional methods this build implements, in
// lock step with the KWin plugin: the server calls one of these only when it
// is listed here, and falls back to the version-1 methods otherwise, so an
// installed older plugin keeps working with a newer server.
constexpr int         INTERFACE_VERSION    = 2;
constexpr const char* INTERFACE_FEATURES[] = {"captureEx", "keys", "waitForSettle", "windowsStateJson"};

std::string healthJson() {
    ensureReleaseShortcut();
    JsonArr features;
    for (const char* feature : INTERFACE_FEATURES)
        features.str(feature);
    JsonObj health;
    health
        // Direct injection needs nothing prepared beyond the seat manager the
        // serials come from, so readiness is its presence.
        .boolean("ok", g_pSeatManager != nullptr)
        .boolean("running", g.running)
        .str("service", SERVICE_NAME)
        .str("path", OBJECT_PATH)
        .str("interface", INTERFACE_NAME)
        .str("build", SYNARA_CU_BUILD_ID)
        .str("compositor", "hyprland")
        .str("hyprlandVersion", g.hyprlandVersion)
        .num("interfaceVersion", INTERFACE_VERSION)
        .raw("features", features.build());
    // healthJson answers anyone on the session bus. The .so this instance was
    // loaded from (`hyprctl plugin list` reports only names while load/unload
    // address paths, so this is how the server learns which installed build
    // answers the bus) and what it was built from name files and revisions on
    // the host, so they are told to the authenticated server only.
    if (g.authentication && g.authentication->permits())
        health.str("modulePath", modulePath()).str("gitHash", SYNARA_CU_GIT_HASH).str("buildTimestamp", SYNARA_CU_BUILD_TS);
    health
        // Always the human's live compositor, so always the KWin plugin's
        // shared-desktop shape: no seat of the agent's own (hence no `seat`),
        // direct per-client injection, ghost cursor drawn by the plugin.
        .boolean("dedicatedSeat", false)
        .boolean("ownsCompositor", false)
        .boolean("directInjection", true)
        .boolean("overlay", true)
        .boolean("workspace", static_cast<bool>(Desktop::windowState()))
        .str("xDisplay", std::getenv("DISPLAY") ? std::getenv("DISPLAY") : "")
        .boolean("effects", true)
        .boolean("capture", g_pHyprRenderer != nullptr && Render::GL::g_pHyprOpenGL != nullptr)
        .num("idleTimeoutMs", g.idleTimeoutMs)
        .boolean("releasedByUser", g.releasedByUser)
        // The chord in effect, or null when none could be registered - the
        // server shows that as a setup blocker.
        .raw("releaseShortcut", releaseShortcutJson())
        // The bus name is requested when the connection is created and the
        // load fails outright if it cannot be had, so a reachable plugin
        // always owns it; reported for parity with the KWin plugin, whose
        // registration can fail separately.
        .boolean("serviceRegistered", g.dbus != nullptr)
        // Screen locked or logind session inactive: capture and input are
        // refused with SessionLocked until this clears.
        .boolean("locked", sessionLocked())
        .raw("workspaceGeometry", rectJson(workspaceGeometry()));
    return health.build();
}

std::string stateJson() {
    ensureReleaseShortcut();
    JsonObj state;
    state.boolean("running", g.running)
        .boolean("dedicatedSeat", false)
        .boolean("ownsCompositor", false)
        .boolean("directInjection", true)
        .raw("position", pointJson(g.pos))
        // The human's own cursor, reported next to the agent's because the one
        // property this whole design rests on is that these two move
        // independently.
        .raw("humanPosition", pointJson(g_pInputManager ? g_pInputManager->getMouseCoordsInternal() : Vector2D{}))
        .str("agentName", g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName)
        .num("pressedButtonCount", double(g.pressedButtons.size()))
        .num("pressedKeyCount", double(g.pressedKeys.size()))
        .boolean("capsLockOn", capsLockOn())
        .str("keyboardLayout", keyboardLayout())
        .str("keyboardLayoutName", keyboardLayoutName())
        .num("idleTimeoutMs", g.idleTimeoutMs)
        .num("idleMs", double(idleMilliseconds()))
        .boolean("releasedByUser", g.releasedByUser)
        .raw("releaseShortcut", releaseShortcutJson())
        .boolean("locked", sessionLocked());
    if (g.running && g.idleTimeoutMs > 0)
        state.num("idleRemainingMs", double(std::max<int64_t>(0, int64_t(g.idleTimeoutMs) - idleMilliseconds())));
    if (!g.stopReason.empty())
        state.str("stopReason", g.stopReason);
    if (const auto w = g.pointerWindow.lock()) {
        state.str("pointerWindowId", windowId(w));
        state.str("pointerWindowTitle", w->m_title);
    }
    if (const auto w = g.keyboardWindow.lock()) {
        state.str("keyboardWindowId", windowId(w));
        state.str("keyboardWindowTitle", w->m_title);
        state.boolean("keyboardWindowActive", Desktop::focusState()->isWindowActive(w));
    }
    state.boolean("borrowedActivation", false);
    const auto human = Desktop::focusState()->window();
    state.str("humanFocusWindowId", human ? windowId(human) : "");
    state.num("msSinceHumanInput", double(humanInputAgeMilliseconds()));
    state.num("humanActiveGuardMs", g.humanActiveGuardMs);
    // The popup rule, as in the KWin plugin: agent popups open without a
    // grab, and how many have been dismissed for the human or the agent.
    state.num("agentPopupCount", double(agentPopupCount()));
    state.num("agentPopupsDismissed", double(g.popupsDismissed));
    if (g.targetRequested && !usableWindow(g.targetWindow.lock()))
        state.boolean("targetLost", true);
    if (const auto w = g.targetWindow.lock()) {
        state.str("targetWindowId", windowId(w));
        state.str("targetWindowTitle", w->m_title);
    }
    return state.build();
}

// Toplevel windows only. Layer surfaces - bars, docks, wallpapers, launchers,
// notifications - are not CWindows in Hyprland and are left out on purpose:
// they cannot be aimed at with focusWindow, raised, or captured by id, so an
// entry for one would be a target the rest of the interface cannot act on.
// They are still part of every region capture, and a click at a point one
// covers reaches it through the ordinary hit test.
std::string windowsJson() {
    forgetDeadWindowIds();
    // Emitted topmost-first so `stackingIndex` reads as depth, and so each
    // window's occluders are exactly the windows already emitted.
    // windowState()->windows() is bottom-to-top, so walk it backwards.
    struct SStacked {
        std::string id;
        CBox        bounds;
    };
    std::vector<SStacked> covering;
    JsonArr               windows;

    const auto& stacking = Desktop::windowState()->windows();
    int         stackingIndex = 0;
    for (auto it = stacking.rbegin(); it != stacking.rend(); ++it) {
        const PHLWINDOW& w = *it;
        if (!w || !w->m_isMapped)
            continue;

        const std::string id      = windowId(w);
        const CBox        bounds  = windowBounds(w);
        const bool        visible = usableWindow(w);

        // Frame-rect overlap, not true pixel occlusion; overstating the risk
        // is the safe direction.
        JsonArr occludedBy;
        for (const SStacked& above : covering) {
            const bool intersects =
                above.bounds.x < bounds.x + bounds.w && above.bounds.x + above.bounds.w > bounds.x && above.bounds.y < bounds.y + bounds.h && above.bounds.y + above.bounds.h > bounds.y;
            if (intersects)
                occludedBy.str(above.id);
        }

        JsonObj object;
        object.str("id", id)
            .str("title", w->m_title)
            .str("appId", w->m_class)
            .str("resourceClass", w->m_class)
            .num("pid", double(w->getPID()))
            .raw("bounds", rectJson(bounds))
            .boolean("visible", visible)
            .boolean("focusable", !(w->m_ruleApplicator && w->m_ruleApplicator->noFocus().valueOrDefault()) && !w->m_X11ShouldntFocus)
            // An XWayland override-redirect window (a menu, tooltip or
            // combo popup of some X11 toplevel) is a separate CWindow here
            // but not a normal window: it belongs to the toplevel that
            // opened it.
            .boolean("normal", !(w->m_isX11 && w->isX11OverrideRedirect()))
            // Desktop and dock surfaces are layer shells, never CWindows;
            // see the note above the function.
            .boolean("desktop", false)
            .boolean("dock", false)
            // Hyprland has no minimize. The nearest thing is a window hidden
            // inside a group behind another tab: present, restorable, not
            // shown. A window parked on a workspace that is not on screen is
            // `visible: false` instead, like any other backend's off-desktop
            // window.
            .boolean("minimized", w->isHidden())
            .boolean("xwayland", w->m_isX11)
            .num("workspaceId", w->m_workspace ? double(w->m_workspace->m_id) : -1)
            .boolean("specialWorkspace", w->m_workspace && w->m_workspace->m_isSpecialWorkspace)
            .boolean("active", Desktop::focusState()->isWindowActive(w))
            .num("stackingIndex", stackingIndex)
            .raw("occludedBy", occludedBy.build());
        windows.raw(object.build());
        stackingIndex += 1;
        if (visible)
            covering.push_back({id, bounds});
    }
    return windows.build();
}

// windowsJson and the targeting and desktop facts the server otherwise reads
// from stateJson and healthJson next to it, in one round trip and one
// compositor-thread pass, so the four can never disagree with each other.
std::string windowsStateJson() {
    // Locked hides the windows and the target, as the KWin plugin does:
    // titles are the desktop's contents in words, and "locked" is the answer.
    // The geometry is public in healthJson anyway.
    const bool        locked  = sessionLocked();
    const std::string windows = locked ? "[]" : windowsJson();
    const auto        target  = locked ? nullptr : g.targetWindow.lock();
    // Each monitor's logical rect, so the server can photograph the one the
    // agent is working on instead of every screen squeezed into one image.
    std::string outputs = "[";
    for (const auto& mon : State::monitorState()->monitors()) {
        if (!mon)
            continue;
        if (outputs.size() > 1)
            outputs += ",";
        outputs += rectJson(mon->logicalBox());
    }
    outputs += "]";
    return JsonObj{}
        .raw("windows", windows)
        .raw("targetWindowId", target ? "\"" + jsonEscape(windowId(target)) + "\"" : "null")
        .raw("workspace", rectJson(workspaceGeometry()))
        .raw("outputs", outputs)
        .boolean("locked", locked)
        .build();
}

void requireControlAvailable() {
    if (g.releasedByUser)
        throw sdbus::Error(sdbus::Error::Name{ERR_RELEASED}, "computer control was released with " + releaseShortcutText() + "; pressing it again resumes");
}

bool startSession() {
    requireControlAvailable();
    // A session must not begin behind the lock screen: the ghost cursor would
    // be drawn over it, and the first action would be refused anyway.
    requireUnlockedSession();
    g.running = true;
    g.stopReason.clear();
    // Start where the ghost last was, clamped in case outputs changed.
    const CBox geo = workspaceGeometry();
    if (geo.w > 0 && geo.h > 0) {
        g.pos.x = std::clamp(g.pos.x, geo.x, geo.x + geo.w - 1);
        g.pos.y = std::clamp(g.pos.y, geo.y, geo.y + geo.h - 1);
    }
    setCursorVisible(true);
    g.pointerWindow = windowAtPoint(g.pos);
    startCommitTracking();
    noteActivity();
    damageCursorArea();
    return true;
}

bool setIdleTimeout(uint32_t milliseconds) {
    if (milliseconds != 0 && (milliseconds < MIN_IDLE_TIMEOUT_MS || milliseconds > MAX_IDLE_TIMEOUT_MS))
        return false;
    g.idleTimeoutMs = milliseconds;
    armIdleTimer();
    return true;
}

bool setHumanActiveGuardMs(uint32_t milliseconds) {
    if (milliseconds != 0 && (milliseconds < MIN_HUMAN_ACTIVE_GUARD_MS || milliseconds > MAX_HUMAN_ACTIVE_GUARD_MS))
        return false;
    g.humanActiveGuardMs = milliseconds;
    return true;
}

bool setAgentName(const std::string& name) {
    std::string trimmed = name;
    const auto  notSpace = [](unsigned char c) { return !std::isspace(c); };
    trimmed.erase(trimmed.begin(), std::find_if(trimmed.begin(), trimmed.end(), notSpace));
    trimmed.erase(std::find_if(trimmed.rbegin(), trimmed.rend(), notSpace).base(), trimmed.end());
    if (g.agentName == trimmed)
        return true;
    g.agentName      = trimmed;
    g.cursorArtDirty = true;
    if (g.running && g.cursorVisible)
        damageCursorArea();
    return true;
}

bool focusWindow(const std::string& id) {
    requireUnlockedSession();
    if (!requireRunning())
        return false;
    const PHLWINDOW w = findWindowById(id);
    if (!usableWindow(w))
        return false;
    g.targetWindow    = w;
    g.targetRequested = true;
    // Counted as the agent's input, as on KWin: a settle wait after a focus
    // waits for what the window does about it.
    g.lastAgentInputMs = nowMs();
    return true;
}

bool raiseWindow(const std::string& id) {
    requireUnlockedSession();
    if (!requireRunning())
        return false;
    const PHLWINDOW w = findWindowById(id);
    if (!usableWindow(w))
        return false;
    Desktop::windowState()->raise(w);
    g.lastAgentInputMs = nowMs();
    return true;
}

bool clearFocusWindow() {
    g.targetWindow.reset();
    g.targetRequested = false;
    return true;
}

// The lease hand-over reset (D-Bus resetInputDelivery). When the desktop
// lease changes owner the server no longer knows what the previous owner left
// behind, so everything the agent holds is dropped at once: the explicit
// target, the pointer's and keyboard's enter bookkeeping, every held button
// and key (released on the surfaces that saw them, addressed under P2), and
// the shared objects go back to the seat. Not an agent action: it neither
// needs a running session nor extends the idle timer.
bool resetInputDelivery() {
    clearFocusWindow();
    clearKeyboardDelivery();
    clearPointerDelivery();
    // The next holder starts from nothing, and that includes a menu the last
    // one left open.
    dismissAllAgentPopups();
    return true;
}

// Focus preparation is shared by motion, clicks, scrolls, and keys. Hand back
// only after the complete operation, including refusals and exceptions. Held
// buttons and modifiers retain their enter until the matching release. Nested
// scopes hand back once, when the outermost one ends: a batch of keystrokes
// is one agent burst, and nothing of the human's can run between its strokes
// (the whole batch is one handler on the compositor thread), so handing the
// objects back after every stroke would only add wire traffic.
struct InputFocusHandback {
    static inline int depth = 0;
    InputFocusHandback() {
        if (depth++ == 0)
            g.burstStartSerial = displaySerial();
    }
    ~InputFocusHandback() {
        if (--depth > 0)
            return;
        returnKeyboardToSeat();
        returnPointerToSeat();
        // Everything the burst minted, the hand-back included, is the agent's.
        noteAgentBurst(g.burstStartSerial, displaySerial());
    }
    InputFocusHandback(const InputFocusHandback&)            = delete;
    InputFocusHandback& operator=(const InputFocusHandback&) = delete;
};

bool movePointer(double x, double y) {
    requireUnlockedSession();
    if (!requireRunning())
        return false;
    if (!std::isfinite(x) || !std::isfinite(y))
        return false;
    refuseIfHumanHoldsButton();
    settleDeferredReleases();
    const InputFocusHandback handback;
    const CBox geo = workspaceGeometry();
    Vector2D   next{x, y};
    if (geo.w > 0 && geo.h > 0) {
        next.x = std::clamp(next.x, geo.x, geo.x + geo.w - 1);
        next.y = std::clamp(next.y, geo.y, geo.y + geo.h - 1);
    }
    damageCursorArea();
    g.pos = next;
    damageCursorArea();
    // The move is the whole action even over empty desktop; focus maintenance
    // rides along so the surface under the ghost tracks it live.
    updatePointerFocus();
    g.lastAgentInputMs = nowMs();
    return true;
}

bool injectButton(uint32_t button, bool pressed) {
    requireUnlockedSession();
    if (!requireRunning())
        return false;
    const InputFocusHandback handback;
    const bool releasingHeld = !pressed && g.pressedButtons.contains(button);
    if (g_pInputManager && g_pInputManager->hasHeldButtons()) {
        // The release half of a press the agent delivered is never refused,
        // and while the human is mid-press the ghost must not move or re-aim
        // either: the release goes to the pressed surface as it stands,
        // addressed under P2, and nothing else happens. Anything else waits.
        if (!releasingHeld)
            refuseIfHumanHoldsButton();
        releasePressedButtons(button);
        g.lastAgentInputMs = nowMs();
        return true;
    }
    settleDeferredReleases();
    // Every refusal comes before any wire event: an enter, a leave or a motion
    // sent into the human's window and then taken back is still a hover and
    // focus flicker in it. The reachability refusal outranks the plain focus
    // failure: a pointer-less client leaves deliverPointerFocus without a
    // surface too, and the caller deserves the loud error, not a silent false.
    const auto window = resolvePointerWindow();
    if (window)
        requireReachableClient(window, "wl_pointer");
    // The release half of a press the agent already delivered is never
    // refused: the client is holding that button down because of us, and
    // leaving it held is worse than the press was.
    const bool completingPress = !pressed && g.pressedButtons.contains(button);
    if (window && !completingPress)
        refuseIfHumanActive(window);
    if (!deliverPointerFocus(window))
        return false;
    // A click aims the keyboard too, the way a human's click does.
    updateKeyboardFocus();

    if (const auto surface = g.directPointerSurface.lock()) {
        if (pressed) {
            g.pressedButtons.insert(button);
            handleAgentPress(surface->client());
        } else
            g.pressedButtons.erase(button);
        directPointerButtonEvent(surface, button, pressed);
        g.lastAgentInputMs = nowMs();
    }
    return true;
}

// Whole wheel clicks owed to a client too old for wl_pointer.axis_value120:
// that event carries only whole clicks, so any delta under one click truncates
// to zero and a small scroll becomes a no-op there. The sub-click part is
// carried in the remainder so repeated small deltas still add up to a click.
int takeDiscreteSteps(double& remainder, double delta120) {
    if (delta120 == 0)
        return 0;
    remainder += delta120;
    const double steps = std::trunc(remainder / 120.0);
    remainder -= steps * 120.0;
    return static_cast<int>(steps);
}

// Pixels per wheel notch. The whole stack speaks pixels — the tool surface,
// the computer pane, and the `axis` D-Bus method — while a wheel speaks
// notches, so the conversion lives at the one place the two meet. These are
// content pixels, what a page moves per click (about 86 in Firefox on Wayland,
// 80 in Chromium), not the 15 wire units libinput reports per click: those are
// degrees, which every toolkit scales up, and taking them for pixels made each
// scroll several times longer than asked. Keep in sync with the KWin plugin and SCROLL_STEP_PX
// in apps/server/src/computer/scrollUnits.ts, which carries the full rationale.
constexpr double SCROLL_PIXELS_PER_NOTCH = 80.0;
// What one notch is worth in wl_pointer.axis: libinput's wheel unit is degrees
// of rotation, 15 per click, and that is the scale every client expects there.
constexpr double AXIS_UNITS_PER_NOTCH = 15.0;

// The continuous half of a wheel event for a scroll of `pixels`: the value a
// client reads from wl_pointer.axis, in the units a physical wheel uses.
double scrollAxisValue(double pixels) {
    if (!std::isfinite(pixels))
        return 0;
    return pixels * AXIS_UNITS_PER_NOTCH / SCROLL_PIXELS_PER_NOTCH;
}

int scrollValue120(double pixels) {
    if (!std::isfinite(pixels))
        return 0;
    const double units = std::round(pixels * 120.0 / SCROLL_PIXELS_PER_NOTCH);
    return static_cast<int>(std::clamp(units, double(std::numeric_limits<int>::min()), double(std::numeric_limits<int>::max())));
}

// Scrolls by desktop pixels, not wheel notches; positive is right and down,
// matching wl_pointer's axis directions.
bool injectAxis(double horizontal, double vertical) {
    requireUnlockedSession();
    if (!requireRunning())
        return false;
    if (!std::isfinite(horizontal) || !std::isfinite(vertical))
        return false;
    refuseIfHumanHoldsButton();
    settleDeferredReleases();
    const InputFocusHandback handback;
    // Refusals first, wire events after (see injectButton).
    const auto window = resolvePointerWindow();
    if (window) {
        requireReachableClient(window, "wl_pointer");
        refuseIfHumanActive(window);
    }
    if (!deliverPointerFocus(window))
        return false;

    const auto surface = g.directPointerSurface.lock();
    if (!surface)
        return false;
    const uint32_t time          = directTimestampMs();
    const auto     resources     = clientInputResources(surface->client(), "wl_pointer");
    const int      horizontalV120 = scrollValue120(horizontal);
    const int      verticalV120   = scrollValue120(vertical);

    // The remainder is only spent on resources that cannot be told about a
    // fraction of a click, so it is only taken when the client has one.
    const bool needsDiscrete = std::any_of(resources.cbegin(), resources.cend(), [](wl_resource* resource) {
        const int version = wl_resource_get_version(resource);
        return version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && version < WL_POINTER_AXIS_VALUE120_SINCE_VERSION;
    });
    const int horizontalSteps = needsDiscrete ? takeDiscreteSteps(g.axisRemainderH, horizontalV120) : 0;
    const int verticalSteps   = needsDiscrete ? takeDiscreteSteps(g.axisRemainderV, verticalV120) : 0;

    for (wl_resource* resource : resources) {
        const int version = wl_resource_get_version(resource);
        if (version >= WL_POINTER_AXIS_SOURCE_SINCE_VERSION)
            wl_pointer_send_axis_source(resource, WL_POINTER_AXIS_SOURCE_WHEEL);
        if (horizontal != 0) {
            wl_pointer_send_axis(resource, time, WL_POINTER_AXIS_HORIZONTAL_SCROLL, wl_fixed_from_double(scrollAxisValue(horizontal)));
            // value120 supersedes axis_discrete for the clients that have it,
            // and the two must not both be sent for one scroll.
            if (version >= WL_POINTER_AXIS_VALUE120_SINCE_VERSION)
                wl_pointer_send_axis_value120(resource, WL_POINTER_AXIS_HORIZONTAL_SCROLL, horizontalV120);
            else if (version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && horizontalSteps != 0)
                wl_pointer_send_axis_discrete(resource, WL_POINTER_AXIS_HORIZONTAL_SCROLL, horizontalSteps);
        }
        if (vertical != 0) {
            wl_pointer_send_axis(resource, time, WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_double(scrollAxisValue(vertical)));
            if (version >= WL_POINTER_AXIS_VALUE120_SINCE_VERSION)
                wl_pointer_send_axis_value120(resource, WL_POINTER_AXIS_VERTICAL_SCROLL, verticalV120);
            else if (version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && verticalSteps != 0)
                wl_pointer_send_axis_discrete(resource, WL_POINTER_AXIS_VERTICAL_SCROLL, verticalSteps);
        }
        if (version >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
    g.lastAgentInputMs = nowMs();
    return true;
}

bool injectKey(uint32_t keyCode, bool pressed) {
    requireUnlockedSession();
    if (!requireRunning())
        return false;
    const InputFocusHandback handback;
    // Refusals first, wire events after (see injectButton).
    const auto window = resolveKeyboardWindow();
    if (!window) {
        clearKeyboardDelivery();
        return false;
    }
    requireReachableClient(window, "wl_keyboard");
    // Same exemption the pointer makes, and it matters more here: refusing the
    // release of a held Ctrl leaves the client believing a modifier is down.
    const bool completingPress = !pressed && std::ranges::find(g.pressedKeys, keyCode) != g.pressedKeys.end();
    if (!completingPress)
        refuseIfHumanActive(window);
    if (!deliverKeyboardFocus(window))
        return false;

    const auto surface = g.directKeyboardSurface.lock();
    if (!surface)
        return false;
    // The re-stamp, with the held-key state as it is before this event, and
    // the agent's own modifiers under the key: re-sent when the seat's were
    // put back since, or when the human's locks moved while the agent held
    // nothing.
    sendKeyboardEnterEvent(surface);
    directKeyboardModifiers();
    if (pressed) {
        if (std::ranges::find(g.pressedKeys, keyCode) == g.pressedKeys.end())
            g.pressedKeys.push_back(keyCode);
    } else {
        std::erase(g.pressedKeys, keyCode);
    }
    directKeyboardKeyEvent(surface, keyCode, pressed);
    g.lastAgentInputMs = nowMs();
    ensureXkbState();
    if (g.xkbState) {
        // evdev keycode -> xkb keycode offset is 8.
        xkb_state_update_key(g.xkbState, keyCode + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
        directKeyboardModifiers();
    }
    return true;
}

// Strokes per `keys` call: a word or a short line per round trip, and a bound
// on how long one handler can hold the compositor thread.
constexpr size_t MAX_KEY_STROKES = 256;

// `keys`: each (keyCode, pressed) stroke goes through injectKey with every
// per-stroke check a single `key` makes. The first stroke's refusal is the
// call's error, exactly as `key` would answer it; after that the batch stops
// at the first stroke that is not delivered and reports how many were, so the
// caller knows precisely what the target received. One hand-back covers the
// whole batch (see InputFocusHandback).
uint32_t injectKeys(const std::vector<sdbus::Struct<uint32_t, bool>>& strokes) {
    if (strokes.size() > MAX_KEY_STROKES)
        throw sdbus::Error(sdbus::Error::Name{"org.freedesktop.DBus.Error.InvalidArgs"},
                           std::format("keys takes at most {} strokes per call, got {}", MAX_KEY_STROKES, strokes.size()));
    requireUnlockedSession();
    const InputFocusHandback handback;
    uint32_t                 delivered = 0;
    for (const auto& stroke : strokes) {
        bool sent = false;
        if (delivered == 0) {
            sent = injectKey(std::get<0>(stroke), std::get<1>(stroke));
        } else {
            try {
                sent = injectKey(std::get<0>(stroke), std::get<1>(stroke));
            } catch (const sdbus::Error&) {
                sent = false;
            }
        }
        if (!sent)
            break;
        ++delivered;
    }
    return delivered;
}

// ---------------------------------------------------------------------------
// Capture pipeline. The GL side is minimal — render offscreen at the
// monitor's own resolution, read the pixels back — and everything else
// (stitching monitors into a region, cropping a window, the ghost cursor
// overlay, downscaling, PNG) happens in cairo. Drawing the ghost in cairo
// instead of queueing its pass elements into the fake render keeps the
// capture path independent of the live render-stage hooks.
//
// The human's cursor never appears in a capture: Hyprland renders cursors
// outside renderAllClientsForWorkspace (hardware plane or a separate software
// pass), so an offscreen render simply doesn't contain it — the same
// exclusion the KWin plugin needs an explicit exclusive view for.
// ---------------------------------------------------------------------------

// Same limits as the KWin plugin, against absurd offscreen allocations.
constexpr int     CAPTURE_MAX_NATIVE_SIDE   = 16384;
constexpr int64_t CAPTURE_MAX_NATIVE_PIXELS = 64LL * 1024 * 1024;

using Render::GL::g_pHyprOpenGL;

// renderAllClientsForWorkspace is protected, reachable in core only by friend
// classes (screencopy, screenshare). A plugin is not on that list, but an
// explicit template instantiation is exempt from access control ([temp.spec]
// p12), which makes this the one standard-blessed way to take the member
// pointer — no #define private, no layout assumptions.
using RenderAllClientsFn = void (Render::IHyprRenderer::*)(PHLMONITOR, PHLWORKSPACE, const Time::steady_tp&, const Vector2D&, const float&);
RenderAllClientsFn renderAllClientsForWorkspacePtr();
template <RenderAllClientsFn P> struct SRenderAllClientsGrab {
    friend RenderAllClientsFn renderAllClientsForWorkspacePtr() {
        return P;
    }
};
template struct SRenderAllClientsGrab<&Render::IHyprRenderer::renderAllClientsForWorkspace>;

[[noreturn]] void captureFailed(const std::string& message) {
    throw sdbus::Error(sdbus::Error::Name{ERR_CAPTURE}, message);
}

struct SCapturePixels {
    std::vector<uint8_t> rgba; // tightly packed RGBA8, premultiplied
    int                  w = 0;
    int                  h = 0;
};

// Premultiplied RGBA8 rows into a cairo ARGB32 (native-endian) surface. The
// caller owns the returned surface.
cairo_surface_t* pixelsToCairo(const SCapturePixels& img) {
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, img.w, img.h);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(surface);
        captureFailed("capture image allocation failed");
    }
    unsigned char* data   = cairo_image_surface_get_data(surface);
    const int      stride = cairo_image_surface_get_stride(surface);
    for (int y = 0; y < img.h; ++y) {
        const uint8_t* src = img.rgba.data() + size_t(y) * img.w * 4;
        auto*          dst = reinterpret_cast<uint32_t*>(data + size_t(y) * stride);
        for (int x = 0; x < img.w; ++x, src += 4)
            dst[x] = (uint32_t(src[3]) << 24) | (uint32_t(src[0]) << 16) | (uint32_t(src[1]) << 8) | uint32_t(src[2]);
    }
    cairo_surface_mark_dirty(surface);
    return surface;
}

// Everything a monitor is showing — background, layers, windows, popups —
// rendered offscreen at the monitor's own resolution. Mirrors what
// makeSnapshotFB does for one window, with an opaque clear because a screen
// is opaque by definition (the KWin plugin's region captures do the same).
SP<Render::IFramebuffer> captureFramebuffer(const PHLMONITOR& monitor) {
    auto& fb = g.captureFbs[monitor->m_id];
    if (!fb)
        fb = g_pHyprRenderer->createFB("synara capture");
    if (!fb->isAllocated() || fb->m_size != monitor->m_pixelSize) {
        fb->release();
        if (!fb->alloc(monitor->m_pixelSize.x, monitor->m_pixelSize.y, DRM_FORMAT_ABGR8888))
            captureFailed("offscreen framebuffer allocation failed");
    }
    fb->setImageDescription(monitor->workBufferImageDescription());
    return fb;
}

SP<Render::IFramebuffer> renderMonitorFramebuffer(const PHLMONITOR& monitor) {
    CRegion    fakeDamage{0, 0, monitor->m_transformedSize.x, monitor->m_transformedSize.y};
    const auto fb = captureFramebuffer(monitor);
    if (!g_pHyprRenderer->beginFullFakeRender(monitor, fakeDamage, fb))
        captureFailed("offscreen render begin failed");
    g_pHyprRenderer->m_bRenderingSnapshot = true;
    g_pHyprRenderer->draw(CClearPassElement::SClearData{CHyprColor(0, 0, 0, 1)});
    g_pHyprRenderer->startRenderPass();
    (g_pHyprRenderer.get()->*renderAllClientsForWorkspacePtr())(monitor, monitor->m_activeWorkspace, Time::steadyNow(), Vector2D{0, 0}, 1.f);
    g_pHyprRenderer->endRender();
    g_pHyprRenderer->m_bRenderingSnapshot = false;
    return fb;
}

// The ghost cursor and badge, composited over a capture the same way the
// render pass composites them over the screen, so a capture shows the agent's
// pointer exactly where the human sees it. Drawn from a snapshot taken on the
// compositor thread when the capture was admitted, because the drawing runs
// on the encode worker. `region` is the captured rect in global logical
// coordinates, `scaleX`/`scaleY` the image pixels per logical unit. No-op
// when no session was running - a capture of a released desktop has no ghost
// on screen either.
struct SGhostSnapshot {
    bool        visible    = false;
    Vector2D    pos;
    double      size       = 0;
    double      badgeAlpha = 0;
    std::string name;
};

SGhostSnapshot ghostSnapshot() {
    SGhostSnapshot ghost;
    ghost.visible    = g.running && g.cursorVisible;
    ghost.pos        = g.pos;
    ghost.size       = agentCursorSize();
    ghost.badgeAlpha = badgeAlpha();
    ghost.name       = g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName;
    return ghost;
}

void drawGhostCursorOverlay(cairo_t* cr, const SGhostSnapshot& ghost, const CBox& region, double scaleX, double scaleY) {
    if (!ghost.visible)
        return;
    // The art is drawn at one scale; the two differ only by the rounding of
    // the image's size.
    const double scale  = std::max(scaleX, scaleY);
    const double size   = ghost.size;
    const double margin = strokeMargin(size);

    cairo_save(cr);
    cairo_identity_matrix(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    if (ghost.badgeAlpha > 0) {
        SRenderedImage badge = renderBadgeImage(ghost.name, size, scale);
        const double   bx    = (ghost.pos.x + std::round(size * 0.55) - margin - region.x) * scaleX;
        const double   by    = (ghost.pos.y + std::round(size * 0.90) - margin - region.y) * scaleY;
        cairo_set_source_surface(cr, badge.surface, bx, by);
        cairo_paint_with_alpha(cr, ghost.badgeAlpha);
        cairo_surface_destroy(badge.surface);
    }

    SRenderedImage arrow = renderCursorImage(size, scale);
    const double   ax    = (ghost.pos.x - margin - region.x) * scaleX;
    const double   ay    = (ghost.pos.y - margin - region.y) * scaleY;
    cairo_set_source_surface(cr, arrow.surface, ax, ay);
    cairo_paint(cr);
    cairo_surface_destroy(arrow.surface);

    cairo_restore(cr);
}

// PNG at zlib level 1 with the Sub filter only. Every preview tick and every
// observation is one of these, and cairo's own writer has no level setting:
// its default compression spent more time in zlib than the rest of a capture
// together, for files a few percent smaller. Sub is the cheapest filter that
// still flattens the gradients and anti-aliasing of desktop content.
constexpr int PNG_COMPRESSION_LEVEL = 1;

// libpng reports failure by longjmp, so the rows are written here, in a frame
// that owns nothing with a destructor: everything the jump could skip lives
// in the caller. `row` holds one output row.
bool writePngRows(png_structp png, png_infop info, cairo_surface_t* surface, bool opaque, uint8_t* row) {
    if (setjmp(png_jmpbuf(png)))
        return false;
    const int            w      = cairo_image_surface_get_width(surface);
    const int            h      = cairo_image_surface_get_height(surface);
    const int            stride = cairo_image_surface_get_stride(surface);
    const unsigned char* data   = cairo_image_surface_get_data(surface);
    png_set_IHDR(png, info, w, h, 8, opaque ? PNG_COLOR_TYPE_RGB : PNG_COLOR_TYPE_RGBA, PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
    png_set_compression_level(png, PNG_COMPRESSION_LEVEL);
    png_set_filter(png, PNG_FILTER_TYPE_BASE, PNG_FILTER_SUB);
    png_write_info(png, info);
    for (int y = 0; y < h; ++y) {
        const auto* src = reinterpret_cast<const uint32_t*>(data + size_t(y) * stride);
        uint8_t*    dst = row;
        for (int x = 0; x < w; ++x) {
            const uint32_t p = src[x];
            const uint32_t a = p >> 24;
            uint32_t       r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
            if (opaque) {
                *dst++ = uint8_t(r);
                *dst++ = uint8_t(g);
                *dst++ = uint8_t(b);
                continue;
            }
            // Cairo's pixels are premultiplied; PNG's are not.
            if (a != 0 && a != 255) {
                r = (r * 255 + a / 2) / a;
                g = (g * 255 + a / 2) / a;
                b = (b * 255 + a / 2) / a;
            }
            *dst++ = uint8_t(r);
            *dst++ = uint8_t(g);
            *dst++ = uint8_t(b);
            *dst++ = uint8_t(a);
        }
        png_write_row(png, row);
    }
    png_write_end(png, nullptr);
    return true;
}

// `opaque` drops the alpha channel: a region capture is painted onto black,
// so every alpha is 255 and the channel would only cost a quarter more data.
std::vector<uint8_t> encodePng(cairo_surface_t* surface, bool opaque) {
    std::vector<uint8_t> out;
    std::vector<uint8_t> row(size_t(cairo_image_surface_get_width(surface)) * (opaque ? 3 : 4));
    png_structp          png  = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
    png_infop            info = png ? png_create_info_struct(png) : nullptr;
    if (!png || !info) {
        png_destroy_write_struct(&png, &info);
        captureFailed("PNG encoder could not be created");
    }
    out.reserve(row.size() * size_t(cairo_image_surface_get_height(surface)) / 4);
    png_set_write_fn(
        png, &out,
        [](png_structp writer, png_bytep data, size_t length) {
            auto* sink = static_cast<std::vector<uint8_t>*>(png_get_io_ptr(writer));
            bool  ok   = true;
            try {
                sink->insert(sink->end(), data, data + length);
            } catch (...) {
                ok = false;
            }
            if (!ok)
                png_error(writer, "out of memory");
        },
        [](png_structp) {});
    const bool written = writePngRows(png, info, surface, opaque, row.data());
    png_destroy_write_struct(&png, &info);
    if (!written || out.empty())
        captureFailed("PNG encoding failed");
    return out;
}

// The capture flags of captureWindowEx and captureRegionEx, the same bits in
// the KWin plugin. Without a format bit the image is PNG. Luma outranks JPEG
// when a caller sets both: it is the cheaper answer to the narrower question.
constexpr uint32_t CAPTURE_FLAG_PASSIVE = 1;
constexpr uint32_t CAPTURE_FLAG_JPEG    = 2;
constexpr uint32_t CAPTURE_FLAG_LUMA    = 4;
constexpr int      JPEG_QUALITY         = 85;

enum class CaptureFormat : uint8_t {
    Png,
    Jpeg,
    Luma,
};

CaptureFormat captureFormat(uint32_t flags) {
    if (flags & CAPTURE_FLAG_LUMA)
        return CaptureFormat::Luma;
    if (flags & CAPTURE_FLAG_JPEG)
        return CaptureFormat::Jpeg;
    return CaptureFormat::Png;
}

// A cairo ARGB32 surface is premultiplied, so its colour channels already
// are the image composited over black: exactly what a format without alpha
// should show for a window capture's transparent surround.
std::vector<uint8_t> encodeJpeg(cairo_surface_t* surface) {
    const int  w      = cairo_image_surface_get_width(surface);
    const int  h      = cairo_image_surface_get_height(surface);
    const int  stride = cairo_image_surface_get_stride(surface);
    tjhandle   tj     = tj3Init(TJINIT_COMPRESS);
    if (!tj)
        captureFailed("JPEG encoder could not be created");
    tj3Set(tj, TJPARAM_QUALITY, JPEG_QUALITY);
    tj3Set(tj, TJPARAM_SUBSAMP, TJSAMP_420);
    tj3Set(tj, TJPARAM_FASTDCT, 1);
    // ARGB32 is a native-endian word per pixel: B, G, R, X in memory on a
    // little-endian machine.
    constexpr int pixelFormat = std::endian::native == std::endian::little ? TJPF_BGRX : TJPF_XRGB;
    unsigned char* jpeg = nullptr;
    size_t         size = 0;
    const int      rc   = tj3Compress8(tj, cairo_image_surface_get_data(surface), w, stride, h, pixelFormat, &jpeg, &size);
    std::vector<uint8_t> out;
    if (rc == 0 && jpeg && size > 0)
        out.assign(jpeg, jpeg + size);
    const std::string reason = rc == 0 ? "" : tj3GetErrorStr(tj);
    tj3Free(jpeg);
    tj3Destroy(tj);
    if (out.empty())
        captureFailed("JPEG encoding failed: " + reason);
    return out;
}

// One byte of BT.601 luma per pixel, rows top to bottom with no padding: the
// cheapest answer to "did anything on screen change", for a caller that
// compares frames rather than looks at them. The server correlates it against
// the PNG of the same capture (scroll measurement), decoding that PNG's RGB as
// floor((299 R + 587 G + 114 B) / 1000), so each byte comes from exactly the
// RGB writePngRows would write — unpremultiplied the same way when the
// capture keeps alpha — through that same integer formula.
std::vector<uint8_t> encodeLuma(cairo_surface_t* surface, bool opaque) {
    const int            w      = cairo_image_surface_get_width(surface);
    const int            h      = cairo_image_surface_get_height(surface);
    const int            stride = cairo_image_surface_get_stride(surface);
    const unsigned char* data   = cairo_image_surface_get_data(surface);
    std::vector<uint8_t> out(size_t(w) * size_t(h));
    for (int y = 0; y < h; ++y) {
        const auto* row = reinterpret_cast<const uint32_t*>(data + size_t(y) * stride);
        uint8_t*    dst = out.data() + size_t(y) * w;
        for (int x = 0; x < w; ++x) {
            const uint32_t p = row[x];
            const uint32_t a = p >> 24;
            uint32_t       r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
            if (!opaque && a != 0 && a != 255) {
                r = (r * 255 + a / 2) / a;
                g = (g * 255 + a / 2) / a;
                b = (b * 255 + a / 2) / a;
            }
            dst[x] = static_cast<uint8_t>((299 * r + 587 * g + 114 * b) / 1000);
        }
    }
    return out;
}

// The encoded image and its MIME type, as the Ex methods return them.
struct SEncodedImage {
    std::vector<uint8_t> bytes;
    std::string          mime;
};

SEncodedImage encodeCaptureImage(cairo_surface_t* surface, CaptureFormat format, bool opaque) {
    cairo_surface_flush(surface);
    switch (format) {
        case CaptureFormat::Jpeg: return {encodeJpeg(surface), "image/jpeg"};
        case CaptureFormat::Luma:
            return {encodeLuma(surface, opaque),
                    std::format("image/x-luma8; width={}; height={}", cairo_image_surface_get_width(surface), cairo_image_surface_get_height(surface))};
        case CaptureFormat::Png: break;
    }
    return {encodePng(surface, opaque), "image/png"};
}

// Encodes the finished image. Consumes the surface.
SEncodedImage finishCapture(cairo_surface_t* surface, CaptureFormat format, bool opaque) {
    SEncodedImage image;
    try {
        image = encodeCaptureImage(surface, format, opaque);
    } catch (...) {
        cairo_surface_destroy(surface);
        throw;
    }
    cairo_surface_destroy(surface);
    return image;
}

// The capture's native size: `region` in global logical coordinates at
// `scale` device pixels per logical unit, within the same limits the KWin
// plugin enforces. Checked at admission, before any GPU work.
void captureNativeSize(const CBox& region, double scale, int& nativeW, int& nativeH) {
    nativeW = static_cast<int>(std::ceil(region.w * scale));
    nativeH = static_cast<int>(std::ceil(region.h * scale));
    if (nativeW < 1 || nativeH < 1)
        captureFailed("capture dimensions are invalid");
    if (nativeW > CAPTURE_MAX_NATIVE_SIDE || nativeH > CAPTURE_MAX_NATIVE_SIDE || int64_t(nativeW) * nativeH > CAPTURE_MAX_NATIVE_PIXELS)
        captureFailed("capture dimensions are too large");
}

// The size of the image a capture answers with: native, or scaled down so
// its longest side fits maxDimension (0 = uncapped). The layers are stitched
// straight into an image of this size, never at native size first.
void captureTargetSize(int nativeW, int nativeH, uint32_t maxDimension, int& targetW, int& targetH) {
    targetW             = nativeW;
    targetH             = nativeH;
    const int largest   = std::max(nativeW, nativeH);
    if (maxDimension == 0 || largest <= static_cast<int>(maxDimension))
        return;
    const double factor = double(maxDimension) / largest;
    targetW             = std::max(1, static_cast<int>(std::lround(nativeW * factor)));
    targetH             = std::max(1, static_cast<int>(std::lround(nativeH * factor)));
}

cairo_surface_t* captureTarget(int width, int height) {
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(surface);
        captureFailed("capture image allocation failed");
    }
    return surface;
}

std::optional<CBox> intersectBoxes(const CBox& a, const CBox& b) {
    const double x1 = std::max(a.x, b.x);
    const double y1 = std::max(a.y, b.y);
    const double x2 = std::min(a.x + a.w, b.x + b.w);
    const double y2 = std::min(a.y + a.h, b.y + b.h);
    if (x2 <= x1 || y2 <= y1)
        return std::nullopt;
    return CBox{x1, y1, x2 - x1, y2 - y1};
}

// ---------------------------------------------------------------------------
// Capture jobs. The compositor thread does only what needs the GL context:
// the offscreen render, and queueing the readback of just the pixels the
// capture covers into a pixel-pack buffer behind a fence - never a
// synchronous glReadPixels, which would stall the compositor until the GPU
// had finished the render and the copy. A timer on the Wayland loop polls the
// fences without waiting and maps each buffer once its copy has landed.
// Everything after - copying the pixels out of the mapping, the output
// transform, stitching monitors at the image's final size, the ghost overlay
// and the encode - runs on one worker thread, and the D-Bus reply goes out
// from the compositor thread once the worker hands the job back through an
// eventfd on the Wayland loop, which also unmaps the buffers. The bus method
// is asynchronous, so a capture stream never stalls the compositor on the GPU
// or on zlib, and the worker touches no compositor state: a job carries
// copies of everything it needs, and the bus connection and every GL call are
// only ever used from the compositor thread.
// ---------------------------------------------------------------------------

struct SCaptureLayer {
    SCapturePixels pixels;        // the output's native orientation; filled by the worker for a buffered readback
    unsigned       transform = 0; // the output's wl_output_transform, applied by the worker
    CBox           box;           // the logical box on the desktop the pixels cover
    // A buffered readback: the pixel-pack buffer the GPU copies into, the
    // fence that says it has, and once it has, the buffer's mapping, which
    // the worker reads. The GL names are touched on the compositor thread
    // only; the mapping stays valid until that thread unmaps it.
    GLuint         pbo         = 0;
    size_t         pboCapacity = 0;
    GLsync         fence       = nullptr;
    const uint8_t* mapped      = nullptr;
};

struct SCaptureJob {
    // The call to answer: captureWindow/captureRegion reply with the bytes
    // alone, the Ex methods (`extended`) with the bytes and their MIME type.
    sdbus::Result<std::vector<uint8_t>>              reply;
    sdbus::Result<std::vector<uint8_t>, std::string> replyEx;
    bool                                             extended = false;
    uint64_t                                         epoch    = 0;
    CBox                                             region;
    int                                              targetW = 1;
    int                                              targetH = 1;
    bool                                             opaque  = true;
    CaptureFormat                                    format  = CaptureFormat::Png;
    SGhostSnapshot                                   ghost;
    std::vector<SCaptureLayer>                       layers;
    int64_t                                          readbackStartMs = 0;
    SEncodedImage                                    image;
    std::string                                      error;

    SCaptureJob() = default;
    // Gives back the layers' GL resources. Every job ends on the compositor
    // thread - replied to, refused at admission, or dropped at unload - and
    // never while the worker still holds it.
    ~SCaptureJob();
    SCaptureJob(const SCaptureJob&)            = delete;
    SCaptureJob& operator=(const SCaptureJob&) = delete;
};

struct SCaptureWorker {
    std::thread                 thread;
    std::mutex                  mutex;
    std::condition_variable     wake;
    std::deque<UP<SCaptureJob>> pending;
    std::deque<UP<SCaptureJob>> done;
    bool                        stop       = false;
    int                         doneFd     = -1;
    wl_event_source*            doneSource = nullptr;
};
SCaptureWorker captureWorker;

// Compositor-thread state of the buffered readbacks: jobs whose fences have
// not all signalled yet, the timer that polls them, and idle pixel-pack
// buffers kept for the next capture of a stream.
struct SPixelPackBuffer {
    GLuint name     = 0;
    size_t capacity = 0;
};
struct SCaptureReadback {
    std::deque<UP<SCaptureJob>>   waiting;
    wl_event_source*              timer = nullptr;
    std::vector<SPixelPackBuffer> idle;
};
SCaptureReadback captureReadback;

// How often the fences are polled, and how long a readback may take before
// the capture fails instead of waiting on a GPU that has stopped answering.
constexpr int     READBACK_POLL_MS    = 1;
constexpr int64_t READBACK_TIMEOUT_MS = 2000;
// Idle buffers kept: two monitors' worth for a stream, no more.
constexpr size_t  READBACK_IDLE_BUFFERS = 2;

void driveDbus();

// One encoding and one waiting is all a capture stream ever needs; a caller
// that keeps asking faster than the worker encodes would otherwise pile up
// monitor-sized pixel copies in the queue.
constexpr size_t CAPTURE_QUEUE_LIMIT = 2;

// Admission for both capture shapes: the size limits are checked before any
// GPU work, and the ghost and lock epoch are snapshotted while still on the
// compositor thread.
UP<SCaptureJob> newCaptureJob(const CBox& region, double scale, uint32_t maxDimension, bool opaque, uint32_t flags) {
    int nativeW = 0, nativeH = 0;
    captureNativeSize(region, scale, nativeW, nativeH);
    {
        std::lock_guard lock(captureWorker.mutex);
        if (captureReadback.waiting.size() + captureWorker.pending.size() + captureWorker.done.size() >= CAPTURE_QUEUE_LIMIT)
            captureFailed("captures are queued faster than they are encoded; retry after the pending ones complete");
    }
    auto job    = makeUnique<SCaptureJob>();
    job->epoch  = g.lockEpoch;
    job->region = region;
    captureTargetSize(nativeW, nativeH, maxDimension, job->targetW, job->targetH);
    job->opaque = opaque;
    job->format = captureFormat(flags);
    job->ghost  = ghostSnapshot();
    return job;
}

// Restores on scope exit the pack buffer, read framebuffer and pack alignment
// a readback changed: the compositor's own readbacks (screencopy) must find
// the GL state as they left it.
struct SReadbackGlState {
    GLint previousPackBuffer = 0;
    GLint previousAlignment  = 4;
    GLint previousReadFb     = 0;
    SReadbackGlState() {
        glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &previousPackBuffer);
        glGetIntegerv(GL_PACK_ALIGNMENT, &previousAlignment);
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &previousReadFb);
    }
    ~SReadbackGlState() {
        glBindBuffer(GL_PIXEL_PACK_BUFFER, GLuint(previousPackBuffer));
        glPixelStorei(GL_PACK_ALIGNMENT, previousAlignment);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(previousReadFb));
    }
    SReadbackGlState(const SReadbackGlState&)            = delete;
    SReadbackGlState& operator=(const SReadbackGlState&) = delete;
};

// A pixel-pack buffer of at least `size` bytes: an idle one when there is
// one (grown if it is too small), else a new one. 0 when GL refused.
SPixelPackBuffer acquirePixelPackBuffer(size_t size) {
    SPixelPackBuffer buffer;
    if (!captureReadback.idle.empty()) {
        buffer = captureReadback.idle.back();
        captureReadback.idle.pop_back();
    } else {
        glGenBuffers(1, &buffer.name);
    }
    if (!buffer.name)
        return {};
    glBindBuffer(GL_PIXEL_PACK_BUFFER, buffer.name);
    if (buffer.capacity < size) {
        while (glGetError() != GL_NO_ERROR)
            ;
        glBufferData(GL_PIXEL_PACK_BUFFER, GLsizeiptr(size), nullptr, GL_STREAM_READ);
        if (glGetError() != GL_NO_ERROR) {
            glDeleteBuffers(1, &buffer.name);
            return {};
        }
        buffer.capacity = size;
    }
    return buffer;
}

// Hands a layer's GL resources back: the fence deleted, the buffer unmapped
// and kept for the next capture, or deleted when enough are kept already.
// Compositor thread only, and never while the worker may still read the
// mapping.
void releaseLayerReadback(SCaptureLayer& layer) {
    if (!layer.fence && !layer.pbo)
        return;
    if (!g_pHyprOpenGL) {
        // The GL context is gone with the renderer; so are its objects.
        layer.fence  = nullptr;
        layer.pbo    = 0;
        layer.mapped = nullptr;
        return;
    }
    g_pHyprOpenGL->makeEGLCurrent();
    if (layer.fence) {
        glDeleteSync(layer.fence);
        layer.fence = nullptr;
    }
    if (layer.pbo) {
        const SReadbackGlState state;
        if (layer.mapped) {
            glBindBuffer(GL_PIXEL_PACK_BUFFER, layer.pbo);
            glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
            layer.mapped = nullptr;
        }
        if (captureReadback.idle.size() < READBACK_IDLE_BUFFERS)
            captureReadback.idle.push_back({layer.pbo, layer.pboCapacity});
        else
            glDeleteBuffers(1, &layer.pbo);
        layer.pbo = 0;
    }
}

void releaseJobReadbacks(SCaptureJob& job) {
    for (SCaptureLayer& layer : job.layers)
        releaseLayerReadback(layer);
}

SCaptureJob::~SCaptureJob() {
    releaseJobReadbacks(*this);
}

// The idle buffers go with the session, like the offscreen framebuffers.
void releaseIdlePixelPackBuffers() {
    if (captureReadback.idle.empty())
        return;
    if (g_pHyprOpenGL) {
        g_pHyprOpenGL->makeEGLCurrent();
        for (const SPixelPackBuffer& buffer : captureReadback.idle)
            glDeleteBuffers(1, &buffer.name);
    }
    captureReadback.idle.clear();
}

// The pixels a capture needs from one output: the native (as-read)
// rectangle of its framebuffer, `fbW` x `fbH`, whose image under the output
// `transform` shows the part of `need` (global logical coordinates) that
// falls on `monitorBox`, and the logical box those whole pixels cover.
struct SCaptureLayerRect {
    SPixelRect native;
    CBox       box;
};

std::optional<SCaptureLayerRect> captureLayerRect(const CBox& monitorBox, int fbW, int fbH, unsigned transform, const CBox& need) {
    const auto part = intersectBoxes(need, monitorBox);
    if (!part || monitorBox.w <= 0 || monitorBox.h <= 0 || fbW <= 0 || fbH <= 0)
        return std::nullopt;
    // Pixels in the output's logical orientation, per logical unit.
    const int    transformedW = (transform & 1) ? fbH : fbW;
    const int    transformedH = (transform & 1) ? fbW : fbH;
    const double sx           = transformedW / monitorBox.w;
    const double sy           = transformedH / monitorBox.h;
    const int    x0           = std::clamp(static_cast<int>(std::floor((part->x - monitorBox.x) * sx)), 0, transformedW);
    const int    y0           = std::clamp(static_cast<int>(std::floor((part->y - monitorBox.y) * sy)), 0, transformedH);
    const int    x1           = std::clamp(static_cast<int>(std::ceil((part->x + part->w - monitorBox.x) * sx)), 0, transformedW);
    const int    y1           = std::clamp(static_cast<int>(std::ceil((part->y + part->h - monitorBox.y) * sy)), 0, transformedH);
    if (x1 <= x0 || y1 <= y0)
        return std::nullopt;
    return SCaptureLayerRect{
        nativeRectForTransformed({x0, y0, x1 - x0, y1 - y0}, fbW, fbH, transform),
        CBox{monitorBox.x + x0 / sx, monitorBox.y + y0 / sy, (x1 - x0) / sx, (y1 - y0) / sy},
    };
}

// Queues the readback of the part of `need` (global logical coordinates)
// that `monitor`'s framebuffer `fb` shows, as one more layer of `job`: only
// those pixels are copied (captureLayerRect). Asynchronous into a pixel-pack
// buffer when GL gives one, synchronous otherwise. Nothing is added when the
// part is empty.
void addCaptureLayer(SCaptureJob& job, const SP<Render::IFramebuffer>& fb, const PHLMONITOR& monitor, const CBox& need) {
    const int fbW = static_cast<int>(fb->m_size.x);
    const int fbH = static_cast<int>(fb->m_size.y);
    if (fbW <= 0 || fbH <= 0)
        captureFailed("offscreen framebuffer has no pixels");
    const unsigned transform = unsigned(monitor->m_transform);
    const auto     rect      = captureLayerRect(monitor->logicalBox(), fbW, fbH, transform, need);
    if (!rect)
        return;
    const SPixelRect& native = rect->native;

    SCaptureLayer layer;
    layer.transform = transform;
    layer.box       = rect->box;
    layer.pixels.w  = native.w;
    layer.pixels.h  = native.h;
    const size_t bytes = size_t(native.w) * size_t(native.h) * 4;

    // glReadPixels reads GL_READ_FRAMEBUFFER; IFramebuffer::bind() only binds
    // the draw side, so bind the read side explicitly like core readPixels does.
    const auto glFb = dynamic_cast<Render::GL::CGLFramebuffer*>(fb.get());
    if (!glFb)
        captureFailed("capture requires the GL renderer");
    g_pHyprOpenGL->makeEGLCurrent();
    const SReadbackGlState state;
    glBindFramebuffer(GL_READ_FRAMEBUFFER, glFb->getFBID());
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    if (const SPixelPackBuffer buffer = acquirePixelPackBuffer(bytes); buffer.name) {
        glBindBuffer(GL_PIXEL_PACK_BUFFER, buffer.name);
        glReadPixels(native.x, native.y, native.w, native.h, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        layer.pbo         = buffer.name;
        layer.pboCapacity = buffer.capacity;
        layer.fence       = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        // Submitted now, so the fence signals without anything else having to
        // flush the queue first.
        glFlush();
        if (!layer.fence) {
            job.layers.push_back(std::move(layer));
            captureFailed("GPU readback could not be fenced");
        }
    } else {
        glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        layer.pixels.rgba.resize(bytes);
        glReadPixels(native.x, native.y, native.w, native.h, GL_RGBA, GL_UNSIGNED_BYTE, layer.pixels.rgba.data());
    }
    job.layers.push_back(std::move(layer));
}

// Worker-thread side: pixels in, encoded image out. Nothing here reads `g`.
void encodeCapture(SCaptureJob& job) {
    cairo_surface_t* target = captureTarget(job.targetW, job.targetH);
    cairo_t*         cr     = cairo_create(target);
    if (job.opaque) {
        // A screen is opaque: black under any monitor gap or transparent
        // pixels, like the KWin plugin's region captures. A window capture
        // keeps its surround transparent - there the "background" genuinely
        // is "not this window".
        cairo_set_source_rgba(cr, 0, 0, 0, 1);
        cairo_paint(cr);
    }
    // Image pixels per logical unit.
    const double scaleX = job.targetW / job.region.w;
    const double scaleY = job.targetH / job.region.h;
    for (SCaptureLayer& layer : job.layers) {
        if (layer.mapped)
            layer.pixels.rgba.assign(layer.mapped, layer.mapped + size_t(layer.pixels.w) * size_t(layer.pixels.h) * 4);
        transformCapturePixels(layer.pixels.rgba, layer.pixels.w, layer.pixels.h, layer.transform);
        cairo_surface_t* layerSurf = pixelsToCairo(layer.pixels);
        cairo_save(cr);
        cairo_translate(cr, (layer.box.x - job.region.x) * scaleX, (layer.box.y - job.region.y) * scaleY);
        // Pixels now have the output's logical orientation, including
        // reflections, and are resampled once, straight to the image's final
        // size: no native-size intermediate for a downscaled capture.
        cairo_scale(cr, layer.box.w * scaleX / layer.pixels.w, layer.box.h * scaleY / layer.pixels.h);
        cairo_set_source_surface(cr, layerSurf, 0, 0);
        cairo_pattern_set_filter(cairo_get_source(cr), CAIRO_FILTER_GOOD);
        cairo_set_operator(cr, job.opaque ? CAIRO_OPERATOR_OVER : CAIRO_OPERATOR_SOURCE);
        cairo_paint(cr);
        cairo_restore(cr);
        cairo_surface_destroy(layerSurf);
        std::vector<uint8_t>().swap(layer.pixels.rgba);
    }
    drawGhostCursorOverlay(cr, job.ghost, job.region, scaleX, scaleY);
    cairo_destroy(cr);
    cairo_surface_flush(target);
    job.image = finishCapture(target, job.format, job.opaque);
}

void captureWorkerMain() {
    for (;;) {
        UP<SCaptureJob> job;
        {
            std::unique_lock lock(captureWorker.mutex);
            captureWorker.wake.wait(lock, [] { return captureWorker.stop || !captureWorker.pending.empty(); });
            if (captureWorker.stop)
                return;
            job = std::move(captureWorker.pending.front());
            captureWorker.pending.pop_front();
        }
        try {
            encodeCapture(*job);
        } catch (const sdbus::Error& e) {
            job->error = e.getMessage();
        } catch (const std::exception& e) {
            job->error = e.what();
        }
        {
            std::lock_guard lock(captureWorker.mutex);
            captureWorker.done.push_back(std::move(job));
        }
        const uint64_t one = 1;
        // An eventfd write only fails on counter overflow, which a queue this
        // short cannot reach; nothing compositor-owned (the logger included)
        // is touched from this thread, so the result is deliberately unused.
        [[maybe_unused]] const ssize_t written = write(captureWorker.doneFd, &one, sizeof(one));
    }
}

// The reply, on the compositor thread. A job whose lock epoch has moved on
// answers SessionLocked: its pixels came from a desktop that has since been
// locked away, and the server retries after the unlock. Its GL resources go
// back first: nothing reads the mapping any more.
void replyCapture(SCaptureJob& job) {
    releaseJobReadbacks(job);
    // Sending can fail if the connection has gone; this runs inside Wayland
    // loop callbacks, where an escaping exception would end the compositor.
    try {
        std::optional<sdbus::Error> error;
        if (job.epoch != g.lockEpoch)
            error = sdbus::Error(sdbus::Error::Name{ERR_SESSION_LOCKED}, "The desktop session was locked while the capture was in progress.");
        else if (!job.error.empty())
            error = sdbus::Error(sdbus::Error::Name{ERR_CAPTURE}, job.error);
        if (error && job.extended)
            job.replyEx.returnError(*error);
        else if (error)
            job.reply.returnError(*error);
        else if (job.extended)
            job.replyEx.returnResults(job.image.bytes, job.image.mime);
        else
            job.reply.returnResults(job.image.bytes);
    } catch (const sdbus::Error& e) {
        Log::logger->log(Log::ERR, "[synara] capture reply failed: {}", e.what());
    }
}

int onCaptureDone(int /*fd*/, uint32_t /*mask*/, void* /*data*/) {
    uint64_t count = 0;
    while (read(captureWorker.doneFd, &count, sizeof(count)) > 0)
        ;
    std::deque<UP<SCaptureJob>> done;
    {
        std::lock_guard lock(captureWorker.mutex);
        done.swap(captureWorker.done);
    }
    for (auto& job : done)
        replyCapture(*job);
    // A reply larger than the socket buffer leaves sd-bus wanting POLLOUT.
    driveDbus();
    return 0;
}

void ensureCaptureWorker() {
    if (captureWorker.thread.joinable())
        return;
    captureWorker.doneFd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (captureWorker.doneFd < 0)
        captureFailed("capture worker could not be started");
    captureWorker.doneSource = wl_event_loop_add_fd(g_pCompositor->m_wlEventLoop, captureWorker.doneFd, WL_EVENT_READABLE, onCaptureDone, nullptr);
    captureWorker.stop       = false;
    captureWorker.thread     = std::thread(captureWorkerMain);
}

void enqueueForEncoding(UP<SCaptureJob> job) {
    {
        std::lock_guard lock(captureWorker.mutex);
        captureWorker.pending.push_back(std::move(job));
    }
    captureWorker.wake.notify_one();
}

// Whether every buffered readback of `job` has landed; each that has is
// mapped for the worker. Never waits: a fence that has not signalled is
// asked again on the next poll.
bool readbacksLanded(SCaptureJob& job) {
    bool landed = true;
    for (SCaptureLayer& layer : job.layers) {
        if (!layer.fence)
            continue;
        const GLenum status = glClientWaitSync(layer.fence, 0, 0);
        if (status == GL_WAIT_FAILED)
            captureFailed("GPU readback failed");
        if (status != GL_ALREADY_SIGNALED && status != GL_CONDITION_SATISFIED) {
            landed = false;
            continue;
        }
        glDeleteSync(layer.fence);
        layer.fence = nullptr;
        const SReadbackGlState state;
        glBindBuffer(GL_PIXEL_PACK_BUFFER, layer.pbo);
        layer.mapped = static_cast<const uint8_t*>(glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0, GLsizeiptr(size_t(layer.pixels.w) * size_t(layer.pixels.h) * 4), GL_MAP_READ_BIT));
        if (!layer.mapped)
            captureFailed("GPU readback could not be mapped");
    }
    return landed;
}

int onReadbackTimer(void* /*data*/) {
    if (captureReadback.waiting.empty())
        return 0;
    if (!g_pHyprOpenGL) {
        for (auto& job : captureReadback.waiting) {
            job->error = "render unavailable";
            replyCapture(*job);
        }
        captureReadback.waiting.clear();
        driveDbus();
        return 0;
    }
    g_pHyprOpenGL->makeEGLCurrent();
    std::deque<UP<SCaptureJob>> still;
    bool                        replied = false;
    for (auto& job : captureReadback.waiting) {
        try {
            if (readbacksLanded(*job)) {
                enqueueForEncoding(std::move(job));
                continue;
            }
            if (nowMs() - job->readbackStartMs > READBACK_TIMEOUT_MS)
                captureFailed("GPU readback timed out");
            still.push_back(std::move(job));
        } catch (const sdbus::Error& e) {
            job->error = e.getMessage();
            replyCapture(*job);
            replied = true;
        }
    }
    captureReadback.waiting.swap(still);
    if (!captureReadback.waiting.empty() && captureReadback.timer)
        wl_event_source_timer_update(captureReadback.timer, READBACK_POLL_MS);
    if (replied)
        driveDbus();
    return 0;
}

// The job carries the call it answers (`reply` or `replyEx`), set by the
// handler that admitted it. A job still waiting on buffered readbacks waits
// on the poll timer; one read synchronously goes straight to the worker.
void submitCapture(UP<SCaptureJob> job) {
    ensureCaptureWorker();
    const bool buffered = std::ranges::any_of(job->layers, [](const SCaptureLayer& layer) { return layer.fence != nullptr; });
    if (!buffered) {
        enqueueForEncoding(std::move(job));
        return;
    }
    if (!captureReadback.timer)
        captureReadback.timer = wl_event_loop_add_timer(g_pCompositor->m_wlEventLoop, onReadbackTimer, nullptr);
    if (!captureReadback.timer)
        captureFailed("capture readback could not be scheduled");
    job->readbackStartMs = nowMs();
    captureReadback.waiting.push_back(std::move(job));
    wl_event_source_timer_update(captureReadback.timer, READBACK_POLL_MS);
}

// Joins the worker and answers whatever it had queued or finished, and every
// job still waiting on its readback, with an error, rather than leaving those
// callers to time out; run before the bus connection goes away.
void stopCaptureWorker() {
    if (captureWorker.thread.joinable()) {
        {
            std::lock_guard lock(captureWorker.mutex);
            captureWorker.stop = true;
        }
        captureWorker.wake.notify_one();
        captureWorker.thread.join();
    }
    for (auto* queue : {&captureReadback.waiting, &captureWorker.pending, &captureWorker.done}) {
        for (auto& job : *queue) {
            job->error = "the plugin is unloading";
            job->image = {};
            replyCapture(*job);
        }
        queue->clear();
    }
    if (captureReadback.timer) {
        wl_event_source_remove(captureReadback.timer);
        captureReadback.timer = nullptr;
    }
    releaseIdlePixelPackBuffers();
    if (captureWorker.doneSource) {
        wl_event_source_remove(captureWorker.doneSource);
        captureWorker.doneSource = nullptr;
    }
    if (captureWorker.doneFd >= 0) {
        close(captureWorker.doneFd);
        captureWorker.doneFd = -1;
    }
}

// A capture is agent activity - it extends the idle timer and holds the
// badge - unless the caller marks it passive: an observer's frame (the
// preview pane's stream) must neither keep an otherwise idle session alive
// forever nor repaint the badge on every tick.
void noteCaptureActivity(uint32_t flags) {
    if (g.running && !(flags & CAPTURE_FLAG_PASSIVE))
        noteActivity();
}

// Compositor-thread side of a window capture: admission, the one offscreen
// render, and the readback of the window's own rectangle. Hyprland's own
// single-window snapshot renders the window with its decorations and popups
// at its real position on a transparent monitor-sized canvas.
UP<SCaptureJob> captureWindow(const std::string& windowId, uint32_t maxDimension, uint32_t flags) {
    requireControlAvailable();
    requireUnlockedSession();
    noteCaptureActivity(flags);
    if (!g_pHyprRenderer || !g_pHyprOpenGL)
        captureFailed("render unavailable");
    const auto window = findWindowById(windowId);
    if (!window)
        captureFailed("unknown window");
    const auto monitor = window->m_monitor.lock();
    if (!monitor)
        captureFailed("window has no monitor");
    const auto region = intersectBoxes(windowBounds(window), workspaceGeometry());
    if (!region)
        captureFailed("window has nothing on screen to capture");
    auto job = newCaptureJob(*region, monitor->m_scale, maxDimension, false, flags);

    const auto fb = g_pHyprRenderer->makeSnapshotFB(window);
    if (!fb)
        captureFailed("window is not visible for capture");
    addCaptureLayer(*job, fb, monitor, *region);
    return job;
}

// Compositor-thread side of a region capture: every intersecting monitor is
// rendered at its own scale and read back only where the region covers it;
// the worker stitches them at the image's final size.
UP<SCaptureJob> captureRegion(int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension, uint32_t flags) {
    requireControlAvailable();
    requireUnlockedSession();
    noteCaptureActivity(flags);
    if (!g_pHyprRenderer || !g_pHyprOpenGL)
        captureFailed("render unavailable");
    const auto region = intersectBoxes(CBox{double(x), double(y), double(width), double(height)}, workspaceGeometry());
    if (!region)
        captureFailed("region is outside the workspace");

    std::vector<PHLMONITOR> monitors;
    double                  scale = 1;
    for (const auto& mon : State::monitorState()->monitors()) {
        if (!mon || !mon->m_output)
            continue;
        if (!intersectBoxes(mon->logicalBox(), *region))
            continue;
        monitors.push_back(mon);
        scale = std::max(scale, double(mon->m_scale));
    }
    if (monitors.empty())
        captureFailed("no monitor covers the region");

    auto job = newCaptureJob(*region, scale, maxDimension, true, flags);
    for (const auto& mon : monitors)
        addCaptureLayer(*job, renderMonitorFramebuffer(mon), mon, *region);
    return job;
}

// ---------------------------------------------------------------------------
// waitForSettle. "Did the application react, and has it finished?" answered
// from the compositor's own evidence - surface commits - instead of a fixed
// sleep on the server: the target's first commit after the agent's input,
// then a quiet period with none. While a session runs, every surface's commit
// is observed and stamped on the window it belongs to (its popups and
// subsurfaces included), so a commit that lands between the agent's input and
// the server's call still counts. A wait is a delayed D-Bus reply and a timer
// on the Wayland loop; nothing ever blocks the compositor thread.
// ---------------------------------------------------------------------------

struct SSettleWait {
    sdbus::Result<bool, uint32_t> reply;
    // Empty for "any window".
    PHLWINDOWREF     window;
    bool             anyWindow   = false;
    int64_t          startMs     = 0;
    int64_t          referenceMs = 0; // a commit must come after this
    int64_t          deadlineMs  = 0;
    int64_t          quietMs     = 0;
    int64_t          lastCommitMs = -1; // the latest qualifying commit
    wl_event_source* timer       = nullptr;
};

struct SCommitRecord {
    PHLWINDOWREF window;
    int64_t      lastMs = -1;
};

struct SCommitTracking {
    bool                                                          active = false;
    CHyprSignalListener                                           newSurface;
    std::vector<std::pair<WP<CWLSurfaceResource>, CHyprSignalListener>> surfaces;
    // Keyed by window object; the ref tells a reused address apart.
    std::unordered_map<const void*, SCommitRecord>                windows;
    int64_t                                                       anyLastMs = -1;
    std::vector<UP<SSettleWait>>                                  waits;
    // The agent input the last settled wait covered: a later input is
    // "pending" and becomes the next wait's reference.
    int64_t                                                       settledInputMs = -1;
};
SCommitTracking commitTracking;

constexpr uint32_t MAX_SETTLE_TIMEOUT_MS = 30 * 1000;
constexpr size_t   MAX_SETTLE_WAITS      = 16;

// The window a surface belongs to: its own toplevel surface, a subsurface of
// it at any depth, or a popup it opened (through the popup's first-tier
// owner). Null for anything that is not a window's: cursors, layer shells,
// drag icons, the lock screen.
PHLWINDOW windowOfSurface(SP<CWLSurfaceResource> surface) {
    for (int depth = 0; surface && depth < 16; ++depth) {
        if (surface->m_role && surface->m_role->role() == SURFACE_ROLE_SUBSURFACE) {
            const auto sub = static_cast<CSubsurfaceRole*>(surface->m_role.get())->m_subsurface.lock();
            surface        = sub ? sub->t1Parent() : nullptr;
            continue;
        }
        const auto hlSurface = Desktop::View::CWLSurface::fromResource(surface);
        const auto view      = hlSurface ? hlSurface->view() : nullptr;
        if (!view)
            return nullptr;
        if (view->type() == Desktop::View::VIEW_TYPE_WINDOW)
            return Desktop::View::CWindow::fromView(view);
        if (view->type() == Desktop::View::VIEW_TYPE_POPUP) {
            const auto popup = Desktop::View::CPopup::fromView(view);
            const auto owner = popup ? popup->getT1Owner() : nullptr;
            const auto ownerView = owner ? owner->view() : nullptr;
            if (ownerView && ownerView->type() == Desktop::View::VIEW_TYPE_WINDOW)
                return Desktop::View::CWindow::fromView(ownerView);
        }
        return nullptr;
    }
    return nullptr;
}

void replySettleWait(SSettleWait& wait, bool settled) {
    if (wait.timer) {
        wl_event_source_remove(wait.timer);
        wait.timer = nullptr;
    }
    try {
        wait.reply.returnResults(settled, static_cast<uint32_t>(std::clamp<int64_t>(nowMs() - wait.startMs, 0, std::numeric_limits<uint32_t>::max())));
    } catch (const sdbus::Error& e) {
        Log::logger->log(Log::ERR, "[synara] waitForSettle reply failed: {}", e.what());
    }
}

// Settled, timed out, still waiting (re-armed), or gone: decides and, unless
// still waiting, replies. True when the wait is finished.
bool evaluateSettleWait(SSettleWait& wait) {
    const int64_t now = nowMs();
    if (!wait.anyWindow && wait.window.expired()) {
        replySettleWait(wait, false);
        return true;
    }
    if (wait.lastCommitMs >= 0 && now - wait.lastCommitMs >= wait.quietMs) {
        if (wait.referenceMs == g.lastAgentInputMs)
            commitTracking.settledInputMs = std::max(commitTracking.settledInputMs, wait.referenceMs);
        replySettleWait(wait, true);
        return true;
    }
    if (now >= wait.deadlineMs) {
        replySettleWait(wait, false);
        return true;
    }
    const int64_t next = wait.lastCommitMs >= 0 ? std::min(wait.lastCommitMs + wait.quietMs, wait.deadlineMs) : wait.deadlineMs;
    if (wait.timer)
        wl_event_source_timer_update(wait.timer, static_cast<int>(std::max<int64_t>(1, next - now)));
    return false;
}

void evaluateSettleWaits() {
    const size_t before = commitTracking.waits.size();
    std::erase_if(commitTracking.waits, [](const UP<SSettleWait>& wait) { return evaluateSettleWait(*wait); });
    if (commitTracking.waits.size() != before)
        driveDbus();
}

int onSettleTimer(void* /*data*/) {
    evaluateSettleWaits();
    return 0;
}

// Damaged commits only, as KWin's Window::damaged: a client that commits every
// frame only to ask for the next frame callback still reads as quiet.
void onSurfaceCommit(const SP<CWLSurfaceResource>& surface) {
    if (surface->m_current.damage.empty() && surface->m_current.bufferDamage.empty())
        return;
    const auto window = windowOfSurface(surface);
    if (!window)
        return;
    const int64_t now    = nowMs();
    auto&         record = commitTracking.windows[window.get()];
    if (record.window.lock() != window)
        record.window = window;
    record.lastMs            = now;
    commitTracking.anyLastMs = now;
    for (const auto& wait : commitTracking.waits) {
        if (!wait->anyWindow && wait->window.lock() != window)
            continue;
        if (now <= wait->referenceMs)
            continue;
        wait->lastCommitMs = now;
        // Quiet from here on: the settle point moves out.
        if (wait->timer)
            wl_event_source_timer_update(wait->timer, static_cast<int>(std::max<int64_t>(1, std::min(now + wait->quietMs, wait->deadlineMs) - now)));
    }
}

void trackSurfaceCommits(const SP<CWLSurfaceResource>& surface) {
    if (!surface)
        return;
    const WP<CWLSurfaceResource> weak = surface;
    commitTracking.surfaces.emplace_back(weak, surface->m_events.commit.listen([weak] {
        if (const auto alive = weak.lock())
            onSurfaceCommit(alive);
    }));
}

// Commits are observed only while a session runs: an idle desktop pays
// nothing per frame for a feature nobody is using.
void startCommitTracking() {
    if (commitTracking.active || !PROTO::compositor)
        return;
    commitTracking.active     = true;
    commitTracking.newSurface = PROTO::compositor->m_events.newSurface.listen([](SP<CWLSurfaceResource> surface) {
        // Listeners of destroyed surfaces are dropped as new ones arrive, so
        // the list stays the size of the live surface set.
        std::erase_if(commitTracking.surfaces, [](const auto& entry) { return entry.first.expired(); });
        trackSurfaceCommits(surface);
    });
    PROTO::compositor->forEachSurface([](SP<CWLSurfaceResource> surface) { trackSurfaceCommits(surface); });
}

// Answers every pending wait with an error instead: SessionLocked when the
// desktop locks, as the KWin plugin answers them.
void failSettleWaits(const char* errorName, const std::string& message) {
    std::vector<UP<SSettleWait>> waits;
    waits.swap(commitTracking.waits);
    for (const auto& wait : waits) {
        if (wait->timer) {
            wl_event_source_remove(wait->timer);
            wait->timer = nullptr;
        }
        try {
            wait->reply.returnError(sdbus::Error(sdbus::Error::Name{errorName}, message));
        } catch (const sdbus::Error& e) {
            Log::logger->log(Log::ERR, "[synara] waitForSettle reply failed: {}", e.what());
        }
    }
    if (!waits.empty())
        driveDbus();
}

// Answers every wait (not settled) and stops observing; on session stop and
// at unload, before the bus goes.
void stopCommitTracking() {
    std::vector<UP<SSettleWait>> waits;
    waits.swap(commitTracking.waits);
    for (const auto& wait : waits)
        replySettleWait(*wait, false);
    commitTracking.newSurface.reset();
    commitTracking.surfaces.clear();
    commitTracking.windows.clear();
    commitTracking.anyLastMs = -1;
    commitTracking.active    = false;
    if (!waits.empty())
        driveDbus();
}

void waitForSettle(sdbus::Result<bool, uint32_t>&& result, const std::string& windowId, uint32_t quietMs, uint32_t timeoutMs) {
    requireUnlockedSession();
    auto wait     = makeUnique<SSettleWait>();
    wait->reply   = std::move(result);
    wait->startMs = nowMs();
    PHLWINDOW window;
    if (!windowId.empty()) {
        window = findWindowById(windowId);
        if (!usableWindow(window))
            window = nullptr;
    }
    // Nothing to observe: no session, or a window that is not there.
    if (!g.running || !commitTracking.active || (!windowId.empty() && !window)) {
        replySettleWait(*wait, false);
        return;
    }
    if (commitTracking.waits.size() >= MAX_SETTLE_WAITS)
        throw sdbus::Error(sdbus::Error::Name{"org.freedesktop.DBus.Error.LimitsExceeded"},
                           std::format("at most {} waitForSettle calls may be pending at once", MAX_SETTLE_WAITS));
    wait->anyWindow  = windowId.empty();
    wait->window     = window;
    wait->quietMs    = quietMs;
    wait->deadlineMs = wait->startMs + std::min(timeoutMs, MAX_SETTLE_TIMEOUT_MS);
    // An agent input the last settled wait has not covered is what this one
    // waits out; with none pending, whatever happens after the call.
    const bool inputPending = g.lastAgentInputMs >= 0 && g.lastAgentInputMs > commitTracking.settledInputMs;
    wait->referenceMs       = inputPending ? g.lastAgentInputMs : wait->startMs;
    int64_t lastCommit      = commitTracking.anyLastMs;
    if (!wait->anyWindow) {
        const auto record = commitTracking.windows.find(window.get());
        lastCommit        = record != commitTracking.windows.end() && record->second.window.lock() == window ? record->second.lastMs : -1;
    }
    if (lastCommit > wait->referenceMs)
        wait->lastCommitMs = lastCommit;
    wait->timer = wl_event_loop_add_timer(g_pCompositor->m_wlEventLoop, onSettleTimer, nullptr);
    if (!wait->timer)
        throw sdbus::Error(sdbus::Error::Name{"org.freedesktop.DBus.Error.Failed"}, "waitForSettle could not be scheduled");
    if (evaluateSettleWait(*wait))
        return;
    commitTracking.waits.push_back(std::move(wait));
}

// ---------------------------------------------------------------------------
// D-Bus plumbing: the connection's fds run on Hyprland's Wayland event loop,
// so handlers execute on the compositor thread with no locking.
//
// sd-bus is driven the way its own event loop drives it: after every
// processing pass the connection reports which poll events it needs next and
// when its next internal deadline falls, and both are fed back into the
// Wayland sources. POLLOUT is the one that matters: a reply larger than the
// socket buffer - every capture PNG - is written only as far as the socket
// accepts and the rest waits in sd-bus's queue for a writable event. With the
// fd registered readable-only that event never came, and the remainder went
// out only when the next inbound message happened to trigger a pass. The
// deadline covers sd-bus's own timers (method-call timeouts on the proxies the
// authentication uses, the Hello handshake).
// ---------------------------------------------------------------------------

void removeDbusEventSources() {
    for (wl_event_source** source : {&g.dbusFdSource, &g.dbusEvtFdSource, &g.dbusTimerSource}) {
        if (*source)
            wl_event_source_remove(*source);
        *source = nullptr;
    }
}

void driveDbus() {
    // sd-bus is not re-entrant: a method handler that stops the session emits
    // a signal from inside a pass, and the pass already running will refresh
    // the poll mask once it completes.
    if (!g.dbus || g.drivingDbus)
        return;
    g.drivingDbus = true;
    try {
        while (g.dbus->processPendingEvent())
            ;
    } catch (const sdbus::Error& e) {
        // The connection itself failed (the session bus went away or reset).
        // Nothing here can rebuild it; stop polling a dead fd rather than spin
        // the compositor on it, end the session so nothing stays held, answer
        // the capture worker's jobs, and let the dead connection go so no
        // later path sends on it.
        Log::logger->log(Log::ERR, "[synara] D-Bus connection failed: {}; the plugin needs a reload", e.what());
        removeDbusEventSources();
        stopCaptureWorker();
        stopSession(StopReason::Request);
        g.authentication.reset();
        g.dbusObject.reset();
        g.dbus.reset();
        g.drivingDbus = false;
        return;
    }
    g.drivingDbus = false;
    if (!g.dbus || !g.dbusFdSource)
        return;
    const auto poll = g.dbus->getEventLoopPollData();
    uint32_t   mask = 0;
    if (poll.events & POLLIN)
        mask |= WL_EVENT_READABLE;
    if (poll.events & POLLOUT)
        mask |= WL_EVENT_WRITABLE;
    wl_event_source_fd_update(g.dbusFdSource, mask);
    if (g.dbusTimerSource) {
        // getPollTimeout: -1 for no deadline, 0 for "do not block", else the
        // relative wait in ms. A Wayland timer set to 0 is disarmed, so an
        // immediate deadline becomes the shortest arm instead.
        const int timeoutMs = poll.getPollTimeout();
        wl_event_source_timer_update(g.dbusTimerSource, timeoutMs < 0 ? 0 : std::max(timeoutMs, 1));
    }
}

int onDbusFdEvent(int fd, uint32_t mask, void* /*data*/) {
    // sdbus-c++ pokes its event fd to wake an event loop when a message was
    // queued outside a pass. Whether a pass clears it is the library's
    // business; draining it here (only when reported readable, so the read
    // cannot block) means a loop that did not would still never spin.
    if (fd == g.dbusEventFd && fd >= 0 && (mask & WL_EVENT_READABLE)) {
        uint64_t                     count = 0;
        [[maybe_unused]] const ssize_t got = read(fd, &count, sizeof(count));
    }
    driveDbus();
    return 0;
}

int onDbusTimer(void* /*data*/) {
    driveDbus();
    return 0;
}

int onIdleTimer(void* /*data*/) {
    if (!g.running || g.idleTimeoutMs == 0)
        return 0;
    if (idleMilliseconds() >= int64_t(g.idleTimeoutMs))
        stopSession(StopReason::IdleTimeout);
    else
        armIdleTimer();
    return 0;
}

// The hold has ended: one damage schedules the frame that starts the fade.
int onBadgeTimer(void* /*data*/) {
    if (g.running && g.cursorVisible && g_pHyprRenderer)
        g_pHyprRenderer->damageBox(badgeBox());
    return 0;
}

// The human's button came up (armed from the button listener, which runs
// before the input manager's held list is updated): pay the owed releases if
// they hold nothing now; another held button re-arms this at its own release.
int onDeferredReleaseTimer(void* /*data*/) {
    settleDeferredReleases();
    return 0;
}

void setupDbus() {
    g.dbus       = sdbus::createSessionBusConnection(sdbus::ServiceName{SERVICE_NAME});
    g.dbusObject = sdbus::createObject(*g.dbus, sdbus::ObjectPath{OBJECT_PATH});
    g.authentication = std::make_unique<SynaraSessionAuth>(*g.dbus, *g.dbusObject, [] { stopSession(StopReason::Request); });

    g.dbusObject
        ->addVTable(sdbus::registerMethod("authenticate").implementedAs([](const std::string& token) {
                        const auto instance = g.authentication->authenticate(token);
                        if (!instance.empty()) stopSession(StopReason::Request);
                        return instance;
                    }),
                    sdbus::registerMethod("healthJson").implementedAs([]() { return healthJson(); }),
                    sdbus::registerMethod("stateJson").implementedAs([]() { g.authentication->require(); return stateJson(); }),
                    sdbus::registerMethod("windowsJson").implementedAs([]() { g.authentication->require(); return windowsJson(); }),
                    sdbus::registerMethod("start").implementedAs([]() { g.authentication->require(); return startSession(); }),
                    sdbus::registerMethod("stop").implementedAs([]() { g.authentication->require();
                        stopSession(StopReason::Request);
                        return true;
                    }),
                    sdbus::registerMethod("setIdleTimeout").implementedAs([](uint32_t ms) { g.authentication->require(); return setIdleTimeout(ms); }),
                    sdbus::registerMethod("setHumanActiveGuardMs").implementedAs([](uint32_t ms) { g.authentication->require(); return setHumanActiveGuardMs(ms); }),
                    sdbus::registerMethod("setAgentName").implementedAs([](const std::string& name) { g.authentication->require(); return setAgentName(name); }),
                    sdbus::registerMethod("focusWindow").implementedAs([](const std::string& id) { g.authentication->require(); return focusWindow(id); }),
                    sdbus::registerMethod("raiseWindow").implementedAs([](const std::string& id) { g.authentication->require(); return raiseWindow(id); }),
                    sdbus::registerMethod("clearFocusWindow").implementedAs([]() { g.authentication->require(); return clearFocusWindow(); }),
                    sdbus::registerMethod("resetInputDelivery").implementedAs([]() { g.authentication->require(); return resetInputDelivery(); }),
                    sdbus::registerMethod("movePointer").implementedAs([](double x, double y) { g.authentication->require(); return movePointer(x, y); }),
                    sdbus::registerMethod("button").implementedAs([](uint32_t button, bool pressed) { g.authentication->require(); return injectButton(button, pressed); }),
                    sdbus::registerMethod("axis").implementedAs([](double horizontal, double vertical) { g.authentication->require(); return injectAxis(horizontal, vertical); }),
                    sdbus::registerMethod("key").implementedAs([](uint32_t keyCode, bool pressed) { g.authentication->require(); return injectKey(keyCode, pressed); }),
                    sdbus::registerMethod("keys").implementedAs([](const std::vector<sdbus::Struct<uint32_t, bool>>& strokes) { g.authentication->require(); return injectKeys(strokes); }),
                    sdbus::registerMethod("windowsStateJson").implementedAs([]() { g.authentication->require(); return windowsStateJson(); }),
                    // Asynchronous: the reply follows from a timer or a
                    // surface commit, never from a wait on this thread.
                    sdbus::registerMethod("waitForSettle")
                        .implementedAs([](sdbus::Result<bool, uint32_t> result, const std::string& id, uint32_t quietMs, uint32_t timeoutMs) {
                            g.authentication->require();
                            waitForSettle(std::move(result), id, quietMs, timeoutMs);
                        }),
                    // Asynchronous on the bus: the handler returns once the
                    // GPU work is done and the reply follows from
                    // onCaptureDone. An exception thrown here still becomes
                    // the error reply, exactly as for the synchronous methods.
                    sdbus::registerMethod("captureWindow").implementedAs([](sdbus::Result<std::vector<uint8_t>> result, const std::string& id, uint32_t maxDimension) {
                        g.authentication->require();
                        auto job   = captureWindow(id, maxDimension, 0);
                        job->reply = std::move(result);
                        submitCapture(std::move(job));
                    }),
                    sdbus::registerMethod("captureRegion").implementedAs([](sdbus::Result<std::vector<uint8_t>> result, int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension) {
                        g.authentication->require();
                        auto job   = captureRegion(x, y, width, height, maxDimension, 0);
                        job->reply = std::move(result);
                        submitCapture(std::move(job));
                    }),
                    sdbus::registerMethod("captureWindowEx")
                        .implementedAs([](sdbus::Result<std::vector<uint8_t>, std::string> result, const std::string& id, uint32_t maxDimension, uint32_t flags) {
                            g.authentication->require();
                            auto job      = captureWindow(id, maxDimension, flags);
                            job->replyEx  = std::move(result);
                            job->extended = true;
                            submitCapture(std::move(job));
                        }),
                    sdbus::registerMethod("captureRegionEx")
                        .implementedAs([](sdbus::Result<std::vector<uint8_t>, std::string> result, int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension,
                                          uint32_t flags) {
                            g.authentication->require();
                            auto job      = captureRegion(x, y, width, height, maxDimension, flags);
                            job->replyEx  = std::move(result);
                            job->extended = true;
                            submitCapture(std::move(job));
                        }),
                    sdbus::registerSignal("sessionStopped").withParameters<std::string>("reason"))
        .forInterface(sdbus::InterfaceName{INTERFACE_NAME});

    const auto     poll = g.dbus->getEventLoopPollData();
    wl_event_loop* loop = g_pCompositor->m_wlEventLoop;
    g.dbusFdSource      = wl_event_loop_add_fd(loop, poll.fd, WL_EVENT_READABLE, onDbusFdEvent, nullptr);
    g.dbusEventFd       = poll.eventFd;
    if (poll.eventFd >= 0)
        g.dbusEvtFdSource = wl_event_loop_add_fd(loop, poll.eventFd, WL_EVENT_READABLE, onDbusFdEvent, nullptr);
    g.dbusTimerSource = wl_event_loop_add_timer(loop, onDbusTimer, nullptr);
    // Flush the name request and take the connection's first poll mask and
    // deadline, rather than waiting for the first inbound message to do it.
    driveDbus();
}

// ---------------------------------------------------------------------------
// Human input spy. These EventBus signals fire for the human's real devices;
// the agent's injected events (next milestone) go straight to client resources
// and never pass through the input manager, so the spy cannot see its own
// session's activity.
// ---------------------------------------------------------------------------

void noteHumanInput() {
    g.lastHumanInputMs = nowMs();
}

// Locking ends a running session outright rather than leaving it to refuse
// the next call: keys and buttons the agent holds are released before the
// lock screen takes the desktop, the ghost cursor is not drawn over the lock
// screen, and work in flight under the previous epoch (a capture being
// encoded) answers SessionLocked instead of delivering pixels from under the
// greeter. Unlocking restarts nothing; the server starts the next session
// when it next acts, exactly as after an idle timeout, and the release latch
// is untouched either way.
void onSessionStateChanged() {
    g.lockEpoch += 1;
    if (!sessionLocked())
        return;
    // Before the stop, which would answer them unsettled.
    failSettleWaits(ERR_SESSION_LOCKED, "session locked");
    if (g.running)
        stopSession(StopReason::SessionLocked);
    else
        resetInputDelivery();
}

// The lock manager's and the session's signals are handled from an idle
// callback rather than inside the emit: listeners run in registration order
// and the compositor's own (registered at startup) are the ones that update
// the state this plugin reads, so reading it after the dispatch is the only
// order that does not depend on who registered first.
void onSessionStateIdle(void* /*data*/) {
    g.sessionStateIdle = nullptr;
    onSessionStateChanged();
}

void scheduleSessionStateCheck() {
    if (g.sessionStateIdle || !g_pCompositor)
        return;
    g.sessionStateIdle = wl_event_loop_add_idle(g_pCompositor->m_wlEventLoop, onSessionStateIdle, nullptr);
}

void setupListeners() {
    g.listeners.renderStage = Event::bus()->m_events.render.stage.listen([](eRenderStage stage) {
        if (stage == RENDER_PRE)
            onRenderPre();
        else if (stage == RENDER_LAST_MOMENT)
            onRenderLastMoment();
    });
    // These fire before the seat routes the human's pointer event, which is
    // what lets the drag-time hand-back put the shared wl_pointer back on the
    // human's surface first (P4).
    g.listeners.mouseMove = Event::bus()->m_events.input.mouse.move.listen([](const Vector2D&, Event::SCallbackInfo&) {
        handBackPointerBeforeHumanEvent();
        noteHumanInput();
    });
    g.listeners.mouseButton = Event::bus()->m_events.input.mouse.button.listen([](const IPointer::SButtonEvent& event, Event::SCallbackInfo&) {
        handBackPointerBeforeHumanEvent();
        noteHumanInput();
        if (event.state == WL_POINTER_BUTTON_STATE_PRESSED)
            handleHumanPointerPress();
        // This fires before the input manager drops the button from its held
        // list, so owed releases are settled from a timer that runs right
        // after the dispatch rather than here (P3).
        if (event.state == WL_POINTER_BUTTON_STATE_RELEASED && !g.deferredReleases.empty() && g.deferredReleaseTimer)
            wl_event_source_timer_update(g.deferredReleaseTimer, 1);
    });
    g.listeners.mouseAxis = Event::bus()->m_events.input.mouse.axis.listen([](const IPointer::SAxisEvent&, Event::SCallbackInfo&) {
        handBackPointerBeforeHumanEvent();
        noteHumanInput();
    });
    // A pen or a finger is the human at the desk as much as a mouse is. These
    // reach clients through tablet_v2 and wl_touch, objects the agent never
    // writes to, so only the activity guard needs them, not the hand-back.
    auto& tablet = Event::bus()->m_events.input.tablet;
    g.listeners.tabletAxis      = tablet.axis.listen([](const CTablet::SAxisEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.tabletButton    = tablet.button.listen([](const CTablet::SButtonEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.tabletProximity = tablet.proximity.listen([](const CTablet::SProximityEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.tabletTip       = tablet.tip.listen([](const CTablet::STipEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    auto& touch = Event::bus()->m_events.input.touch;
    g.listeners.touchDown   = touch.down.listen([](const ITouch::SDownEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.touchUp     = touch.up.listen([](const ITouch::SUpEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.touchMotion = touch.motion.listen([](const ITouch::SMotionEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.touchCancel = touch.cancel.listen([](const ITouch::SCancelEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    // Keys are only observed here, never cancelled: the release chord is a
    // keybind, dispatched by the keybind manager with the same rules as the
    // user's own binds.
    g.listeners.keyboardKey = Event::bus()->m_events.input.keyboard.key.listen([](const IKeyboard::SKeyEvent& event, Event::SCallbackInfo&) {
        handBackKeyboardBeforeHumanKey();
        noteHumanInput();
        if (event.state == WL_KEYBOARD_KEY_STATE_PRESSED)
            g.humanHeldKeys.insert(event.keycode);
        else
            g.humanHeldKeys.erase(event.keycode);
    });
    g.listeners.configReloaded = Event::bus()->m_events.config.reloaded.listen([] { registerReleaseShortcut(); });
    // Popups are views, created inside the get_popup request.
    g.listeners.viewCreate = Event::bus()->m_events.view.create.listen([](PHLVIEW view) { watchPopup(view); });
    if (g_pSeatManager) {
        g.seatPointerFocus            = g_pSeatManager->m_state.pointerFocus;
        g.listeners.pointerFocusChange = g_pSeatManager->m_events.pointerFocusChange.listen([] { onSeatPointerFocusChange(); });
    }
    if (g_pSessionLockManager) {
        g.listeners.sessionLock   = g_pSessionLockManager->m_events.lock.listen([] { scheduleSessionStateCheck(); });
        g.listeners.sessionUnlock = g_pSessionLockManager->m_events.unlock.listen([] { scheduleSessionStateCheck(); });
    }
    // Only a DRM backend has a logind session to switch away from; nested and
    // headless backends stay active for their whole life.
    if (g_pCompositor && g_pCompositor->m_aqBackend && g_pCompositor->m_aqBackend->session)
        g.listeners.sessionActive = g_pCompositor->m_aqBackend->session->events.changeActive.listen([] { scheduleSessionStateCheck(); });
    if (g_pSeatManager) {
        g.seatKeyboardFocus            = g_pSeatManager->m_state.keyboardFocus;
        g.listeners.keyboardFocusChange = g_pSeatManager->m_events.keyboardFocusChange.listen([] { onSeatKeyboardFocusChange(); });
    }
}

void teardown() {
    stopSession(StopReason::Request);
    // Nothing owed survives the plugin: a release still waiting for the
    // human's button-up goes out now, disturbed grab or not, because after
    // unload nobody could ever send it.
    deliverDeferredReleases();
    // Before the bus goes: the worker's finished and queued captures answer
    // through the connection.
    stopCaptureWorker();
    unregisterReleaseShortcut();
    if (PHANDLE)
        HyprlandAPI::removeDispatcher(PHANDLE, RELEASE_DISPATCHER);
    if (g.sessionStateIdle) {
        wl_event_source_remove(g.sessionStateIdle);
        g.sessionStateIdle = nullptr;
    }
    g.listeners.configReloaded.reset();
    g.listeners.keyboardFocusChange.reset();
    g.listeners.viewCreate.reset();
    unwatchPopups();
    g.listeners.renderStage.reset();
    g.listeners.mouseMove.reset();
    g.listeners.mouseButton.reset();
    g.listeners.mouseAxis.reset();
    g.listeners.keyboardKey.reset();
    g.listeners.pointerFocusChange.reset();
    g.listeners.sessionLock.reset();
    g.listeners.sessionUnlock.reset();
    g.listeners.sessionActive.reset();
    for (CHyprSignalListener* listener : {&g.listeners.tabletAxis, &g.listeners.tabletButton, &g.listeners.tabletProximity, &g.listeners.tabletTip, &g.listeners.touchDown,
                                          &g.listeners.touchUp, &g.listeners.touchMotion, &g.listeners.touchCancel})
        listener->reset();
    for (wl_event_source** timer : {&g.idleTimerSource, &g.badgeTimerSource, &g.deferredReleaseTimer}) {
        if (*timer)
            wl_event_source_remove(*timer);
        *timer = nullptr;
    }
    removeDbusEventSources();
    g.authentication.reset();
    g.dbusObject.reset();
    g.dbus.reset();
    g.cursorTex.reset();
    g.badgeTex.reset();
    if (g.xkbState) {
        xkb_state_unref(g.xkbState);
        g.xkbState       = nullptr;
        g.xkbStateKeymap = nullptr;
    }
}

} // namespace

// ---------------------------------------------------------------------------
// Plugin entry points
// ---------------------------------------------------------------------------

APICALL EXPORT std::string PLUGIN_API_VERSION() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {
    PHANDLE = handle;

    const auto version = HyprlandAPI::getHyprlandVersion(handle);
    g.hyprlandVersion  = version.tag.empty() ? version.hash : version.tag;

    g.lastActivityMs = nowMs();
    // Start the ghost where the human's cursor is, like the KWin plugin does.
    if (g_pInputManager)
        g.pos = g_pInputManager->getMouseCoordsInternal();

    setupListeners();
    try {
        setupDbus();
    } catch (const std::exception& e) {
        // Most likely another Synara computer session owns the bus name. Fail
        // the load loudly rather than run a plugin the server cannot reach.
        teardown();
        throw std::runtime_error(std::string("[synara] D-Bus setup failed: ") + e.what());
    }
    // The panic chord, as a dispatcher (`bind = ..., synara:releasecontrol`)
    // with a default bind while the chord is free. A failed registration is
    // not fatal: health reports releaseShortcut as null and the server shows
    // the setup blocker.
    HyprlandAPI::addDispatcherV2(handle, RELEASE_DISPATCHER, onReleaseDispatch);
    registerReleaseShortcut();
    g.idleTimerSource      = wl_event_loop_add_timer(g_pCompositor->m_wlEventLoop, onIdleTimer, nullptr);
    g.badgeTimerSource     = wl_event_loop_add_timer(g_pCompositor->m_wlEventLoop, onBadgeTimer, nullptr);
    g.deferredReleaseTimer = wl_event_loop_add_timer(g_pCompositor->m_wlEventLoop, onDeferredReleaseTimer, nullptr);

    return {"synara-computer-use", "Synara computer use (agent seat policy: ghost cursor + direct injection)", "Synara", "0.1"};
}

APICALL EXPORT void PLUGIN_EXIT() {
    teardown();
}
