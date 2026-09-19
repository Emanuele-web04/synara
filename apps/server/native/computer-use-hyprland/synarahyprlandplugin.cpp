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
#include <hyprland/src/xwayland/XSurface.hpp>
#include <hyprland/src/managers/KeybindManager.hpp>
#include <hyprland/src/debug/log/Logger.hpp>

#include <cairo/cairo.h>
#include "capturetransform.h"
#include "sessionauth.h"
#include <poll.h>
#include <sdbus-c++/sdbus-c++.h>
#include <sys/eventfd.h>
#include <unistd.h>
#include <wayland-server-core.h>
#include <wayland-server-protocol.h>
#include <xkbcommon/xkbcommon.h>

#include <algorithm>
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
    xkb_state*  xkbState       = nullptr;
    xkb_keymap* xkbStateKeymap = nullptr;

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

// Where the human's pointer is, in the coordinates of the surface the seat
// has entered: the position the seat itself would quote in an enter.
Vector2D seatPointerLocal(const SP<CWLSurfaceResource>& surface) {
    if (!g_pInputManager)
        return {};
    const auto global = g_pInputManager->getMouseCoordsInternal();
    if (const auto hlSurface = surface->m_hlSurface.lock()) {
        if (const auto box = hlSurface->getSurfaceBoxGlobal())
            return global - box->pos();
    }
    return {};
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
    // surface, the enter the client believes in is the seat's, not ours.
    if (g_pSeatManager && g_pSeatManager->m_state.pointerFocus.lock() == surface)
        return;
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
    if (!agentSurface || !seatSurface || seatSurface == agentSurface || seatSurface->client() != agentSurface->client())
        return;
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
    if (!agentSurface || !seatSurface || seatSurface == agentSurface || seatSurface->client() != agentSurface->client())
        return;
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

// Maintains the pointer's enter/leave state to match the ghost cursor, and
// says whether there is a surface to deliver to. An explicit target owns the
// pointer: a point it does not claim is refused rather than delivered to
// whatever covers it, because the caller can recover from a refusal and cannot
// recover from a click it never made.
bool updatePointerFocus() {
    PHLWINDOW window;
    if (g.targetRequested) {
        const auto target = g.targetWindow.lock();
        if (!usableWindow(target)) {
            clearPointerDelivery();
            return false;
        }
        window = target;
    } else {
        window = windowAtPoint(g.pos);
    }
    if (!usableWindow(window)) {
        clearPointerDelivery();
        return false;
    }
    g.pointerWindow = window;
    directPointerMotion(window);
    return !g.directPointerSurface.expired();
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
// short names; the descriptive name stands in so the refusal can still say
// which layout it saw, and the server treats it as not US-compatible.
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

void directKeyboardModifiers() {
    const auto surface = g.directKeyboardSurface.lock();
    if (!surface || !g.xkbState)
        return;
    const uint32_t serial    = directSerial(surface);
    const uint32_t depressed = xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_DEPRESSED);
    const uint32_t latched   = xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_LATCHED);
    const uint32_t locked    = xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_LOCKED);
    const uint32_t group     = xkb_state_serialize_layout(g.xkbState, XKB_STATE_LAYOUT_EFFECTIVE);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_modifiers(resource, serial, depressed, latched, locked, group);
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
    directKeyboardModifiers();
}

void directKeyboardKeyEvent(const SP<CWLSurfaceResource>& surface, uint32_t keyCode, bool pressed) {
    const uint32_t serial = directSerial(surface);
    const uint32_t time   = directTimestampMs();
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_key(resource, serial, time, keyCode, pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
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
    const uint32_t serial   = directSerial(seatSurface, true);
    const auto     keyboard = g_pSeatManager->m_keyboard.lock();
    for (wl_resource* resource : clientInputResources(client, "wl_keyboard")) {
        wl_keyboard_send_enter(resource, serial, seatSurface->getResource()->resource(), &keys);
        if (keyboard) {
            const auto& mods = keyboard->m_modifiersState;
            wl_keyboard_send_modifiers(resource, serial, mods.depressed, mods.latched, mods.locked, mods.group);
        }
    }
    wl_array_release(&keys);
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
    if (!g_pSeatManager || !g.pressedKeys.empty() || g.directKeyboardNeedsEnter)
        return;
    const auto agentSurface = g.directKeyboardSurface.lock();
    const auto seatSurface  = g_pSeatManager->m_state.keyboardFocus.lock();
    if (!agentSurface || !seatSurface || seatSurface == agentSurface || seatSurface->client() != agentSurface->client())
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
    if (!agentSurface || !seatSurface || seatSurface == agentSurface || seatSurface->client() != agentSurface->client())
        return;
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
}

void clearKeyboardDelivery() {
    releasePressedKeys();
    directKeyboardLeave();
    g.keyboardWindow.reset();
}

// Target if one was asked for — a target that has gone away fails loudly,
// because a Ctrl+Q aimed at a closing window must not quit whatever sits under
// the ghost cursor instead — else the window the pointer is in.
bool updateKeyboardFocus() {
    PHLWINDOW window;
    if (g.targetRequested) {
        const auto target = g.targetWindow.lock();
        if (!usableWindow(target)) {
            clearKeyboardDelivery();
            return false;
        }
        window = target;
    } else if (const auto pointerWindow = g.pointerWindow.lock(); usableWindow(pointerWindow)) {
        window = pointerWindow;
    } else {
        window = windowAtPoint(g.pos);
    }
    if (!usableWindow(window)) {
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

std::string healthJson() {
    ensureReleaseShortcut();
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
        .str("hyprlandVersion", g.hyprlandVersion);
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
    return true;
}

// Focus preparation is shared by motion, clicks, scrolls, and keys. Hand back
// only after the complete operation, including refusals and exceptions. Held
// buttons and modifiers retain their enter until the matching release.
struct InputFocusHandback {
    ~InputFocusHandback() {
        returnKeyboardToSeat();
        returnPointerToSeat();
    }
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
        return true;
    }
    settleDeferredReleases();
    // The reachability refusal outranks the plain focus failure: a pointer-less
    // client leaves updatePointerFocus without a surface too, and the caller
    // deserves the loud error, not a silent false.
    const bool focused = updatePointerFocus();
    const auto window  = g.pointerWindow.lock();
    if (window)
        requireReachableClient(window, "wl_pointer");
    if (!focused)
        return false;
    // The release half of a press the agent already delivered is never
    // refused: the client is holding that button down because of us, and
    // leaving it held is worse than the press was.
    const bool completingPress = !pressed && g.pressedButtons.contains(button);
    if (!completingPress)
        refuseIfHumanActive(window);
    // A click aims the keyboard too, the way a human's click does.
    updateKeyboardFocus();

    if (const auto surface = g.directPointerSurface.lock()) {
        if (pressed)
            g.pressedButtons.insert(button);
        else
            g.pressedButtons.erase(button);
        directPointerButtonEvent(surface, button, pressed);
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
    const bool focused = updatePointerFocus();
    const auto window  = g.pointerWindow.lock();
    if (window)
        requireReachableClient(window, "wl_pointer");
    if (!focused)
        return false;
    refuseIfHumanActive(window);

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
    return true;
}

bool injectKey(uint32_t keyCode, bool pressed) {
    requireUnlockedSession();
    if (!requireRunning())
        return false;
    const InputFocusHandback handback;
    if (!updateKeyboardFocus())
        return false;
    const auto window = g.keyboardWindow.lock();
    requireReachableClient(window, "wl_keyboard");
    // Same exemption the pointer makes, and it matters more here: refusing the
    // release of a held Ctrl leaves the client believing a modifier is down.
    const bool completingPress = !pressed && std::ranges::find(g.pressedKeys, keyCode) != g.pressedKeys.end();
    if (!completingPress)
        refuseIfHumanActive(window);

    const auto surface = g.directKeyboardSurface.lock();
    if (!surface)
        return false;
    // The re-stamp, with the held-key state as it is before this event.
    sendKeyboardEnterEvent(surface);
    if (pressed) {
        if (std::ranges::find(g.pressedKeys, keyCode) == g.pressedKeys.end())
            g.pressedKeys.push_back(keyCode);
    } else {
        std::erase(g.pressedKeys, keyCode);
    }
    directKeyboardKeyEvent(surface, keyCode, pressed);
    ensureXkbState();
    if (g.xkbState) {
        // evdev keycode -> xkb keycode offset is 8.
        xkb_state_update_key(g.xkbState, keyCode + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
        directKeyboardModifiers();
    }
    return true;
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

SCapturePixels readFramebufferPixels(const SP<Render::IFramebuffer>& fb) {
    SCapturePixels img;
    img.w = static_cast<int>(fb->m_size.x);
    img.h = static_cast<int>(fb->m_size.y);
    if (img.w <= 0 || img.h <= 0)
        captureFailed("offscreen framebuffer has no pixels");
    img.rgba.resize(size_t(img.w) * size_t(img.h) * 4);
    // glReadPixels reads GL_READ_FRAMEBUFFER; IFramebuffer::bind() only binds
    // the draw side, so bind the read side explicitly like core readPixels does.
    const auto glFb = dynamic_cast<Render::GL::CGLFramebuffer*>(fb.get());
    if (!glFb)
        captureFailed("capture requires the GL renderer");
    g_pHyprOpenGL->makeEGLCurrent();
    glBindFramebuffer(GL_READ_FRAMEBUFFER, glFb->getFBID());
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, img.w, img.h, GL_RGBA, GL_UNSIGNED_BYTE, img.rgba.data());
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    return img;
}

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

SCapturePixels renderMonitorPixels(const PHLMONITOR& monitor) {
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
    return readFramebufferPixels(fb);
}

// The ghost cursor and badge, composited over a capture the same way the
// render pass composites them over the screen, so a capture shows the agent's
// pointer exactly where the human sees it. Drawn from a snapshot taken on the
// compositor thread when the capture was admitted, because the drawing runs
// on the encode worker. `region` is the captured rect in global logical
// coordinates, `scale` the capture's device pixels per logical unit. No-op
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

void drawGhostCursorOverlay(cairo_t* cr, const SGhostSnapshot& ghost, const CBox& region, double scale) {
    if (!ghost.visible)
        return;
    const double size   = ghost.size;
    const double margin = strokeMargin(size);

    cairo_save(cr);
    cairo_identity_matrix(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    if (ghost.badgeAlpha > 0) {
        SRenderedImage badge = renderBadgeImage(ghost.name, size, scale);
        const double   bx    = (ghost.pos.x + std::round(size * 0.55) - margin - region.x) * scale;
        const double   by    = (ghost.pos.y + std::round(size * 0.90) - margin - region.y) * scale;
        cairo_set_source_surface(cr, badge.surface, bx, by);
        cairo_paint_with_alpha(cr, ghost.badgeAlpha);
        cairo_surface_destroy(badge.surface);
    }

    SRenderedImage arrow = renderCursorImage(size, scale);
    const double   ax    = (ghost.pos.x - margin - region.x) * scale;
    const double   ay    = (ghost.pos.y - margin - region.y) * scale;
    cairo_set_source_surface(cr, arrow.surface, ax, ay);
    cairo_paint(cr);
    cairo_surface_destroy(arrow.surface);

    cairo_restore(cr);
}

std::vector<uint8_t> encodePng(cairo_surface_t* surface) {
    std::vector<uint8_t>       png;
    const cairo_status_t status = cairo_surface_write_to_png_stream(
        surface,
        [](void* closure, const unsigned char* data, unsigned int length) {
            auto* out = static_cast<std::vector<uint8_t>*>(closure);
            out->insert(out->end(), data, data + length);
            return CAIRO_STATUS_SUCCESS;
        },
        &png);
    if (status != CAIRO_STATUS_SUCCESS || png.empty())
        captureFailed("PNG encoding failed");
    return png;
}

// Downscales so the longest side fits maxDimension (0 = uncapped), then
// encodes. Consumes the surface.
std::vector<uint8_t> finishCapture(cairo_surface_t* surface, uint32_t maxDimension) {
    const int w       = cairo_image_surface_get_width(surface);
    const int h       = cairo_image_surface_get_height(surface);
    const int largest = std::max(w, h);
    if (maxDimension > 0 && largest > static_cast<int>(maxDimension)) {
        const double     factor = double(maxDimension) / largest;
        const int        sw     = std::max(1, static_cast<int>(std::lround(w * factor)));
        const int        sh     = std::max(1, static_cast<int>(std::lround(h * factor)));
        cairo_surface_t* scaled = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, sw, sh);
        cairo_t*         cr     = cairo_create(scaled);
        cairo_scale(cr, double(sw) / w, double(sh) / h);
        cairo_set_source_surface(cr, surface, 0, 0);
        cairo_pattern_set_filter(cairo_get_source(cr), CAIRO_FILTER_GOOD);
        cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
        cairo_paint(cr);
        cairo_destroy(cr);
        cairo_surface_flush(scaled);
        cairo_surface_destroy(surface);
        surface = scaled;
    }
    std::vector<uint8_t> png;
    try {
        png = encodePng(surface);
    } catch (...) {
        cairo_surface_destroy(surface);
        throw;
    }
    cairo_surface_destroy(surface);
    return png;
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

cairo_surface_t* captureTarget(const CBox& region, double scale) {
    int nativeW = 0, nativeH = 0;
    captureNativeSize(region, scale, nativeW, nativeH);
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, nativeW, nativeH);
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
// the offscreen render and the pixel readback. Everything after - the output
// transform, stitching monitors, the ghost overlay, downscaling and the PNG
// encode - runs on one worker thread, and the D-Bus reply goes out from the
// compositor thread once the worker hands the job back through an eventfd on
// the Wayland loop. The bus method is asynchronous, so a capture stream never
// stalls the compositor on zlib, and the worker touches no compositor state:
// a job carries copies of everything it needs, and the bus connection is
// only ever used from the compositor thread.
// ---------------------------------------------------------------------------

struct SCaptureLayer {
    SCapturePixels pixels;    // as read back: the output's native orientation
    unsigned       transform; // the output's wl_output_transform, applied by the worker
    CBox           box;       // the layer's logical box on the desktop
    double         scale;     // the layer's own device pixels per logical unit
};

struct SCaptureJob {
    sdbus::Result<std::vector<uint8_t>> result;
    uint64_t                            epoch = 0;
    CBox                                region;
    double                              scale        = 1;
    uint32_t                            maxDimension = 0;
    bool                                opaque       = true;
    SGhostSnapshot                      ghost;
    std::vector<SCaptureLayer>          layers;
    std::vector<uint8_t>                png;
    std::string                         error;
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

void driveDbus();

// Admission for both capture shapes: the size limits are checked before any
// GPU work, and the ghost and lock epoch are snapshotted while still on the
// compositor thread.
// One encoding and one waiting is all a capture stream ever needs; a caller
// that keeps asking faster than the worker encodes would otherwise pile up
// monitor-sized pixel copies in the queue.
constexpr size_t CAPTURE_QUEUE_LIMIT = 2;

UP<SCaptureJob> newCaptureJob(const CBox& region, double scale, uint32_t maxDimension, bool opaque) {
    int nativeW = 0, nativeH = 0;
    captureNativeSize(region, scale, nativeW, nativeH);
    {
        std::lock_guard lock(captureWorker.mutex);
        if (captureWorker.pending.size() + captureWorker.done.size() >= CAPTURE_QUEUE_LIMIT)
            captureFailed("captures are queued faster than they are encoded; retry after the pending ones complete");
    }
    auto job          = makeUnique<SCaptureJob>();
    job->epoch        = g.lockEpoch;
    job->region       = region;
    job->scale        = scale;
    job->maxDimension = maxDimension;
    job->opaque       = opaque;
    job->ghost        = ghostSnapshot();
    return job;
}

// Worker-thread side: pixels in, PNG out. Nothing here reads `g`.
void encodeCapture(SCaptureJob& job) {
    cairo_surface_t* target = captureTarget(job.region, job.scale);
    cairo_t*         cr     = cairo_create(target);
    if (job.opaque) {
        // A screen is opaque: black under any monitor gap or transparent
        // pixels, like the KWin plugin's region captures. A window capture
        // keeps its surround transparent - there the "background" genuinely
        // is "not this window".
        cairo_set_source_rgba(cr, 0, 0, 0, 1);
        cairo_paint(cr);
    }
    for (SCaptureLayer& layer : job.layers) {
        transformCapturePixels(layer.pixels.rgba, layer.pixels.w, layer.pixels.h, layer.transform);
        cairo_surface_t* layerSurf = pixelsToCairo(layer.pixels);
        cairo_save(cr);
        cairo_translate(cr, (layer.box.x - job.region.x) * job.scale, (layer.box.y - job.region.y) * job.scale);
        // Pixels now have the output's logical orientation, including
        // reflections; stitching happens at the sharpest scale so no
        // layer's pixels get thrown away.
        cairo_scale(cr, job.scale / layer.scale, job.scale / layer.scale);
        cairo_set_source_surface(cr, layerSurf, 0, 0);
        cairo_pattern_set_filter(cairo_get_source(cr), CAIRO_FILTER_GOOD);
        cairo_set_operator(cr, job.opaque ? CAIRO_OPERATOR_OVER : CAIRO_OPERATOR_SOURCE);
        cairo_paint(cr);
        cairo_restore(cr);
        cairo_surface_destroy(layerSurf);
        std::vector<uint8_t>().swap(layer.pixels.rgba);
    }
    drawGhostCursorOverlay(cr, job.ghost, job.region, job.scale);
    cairo_destroy(cr);
    cairo_surface_flush(target);
    job.png = finishCapture(target, job.maxDimension);
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
// locked away, and the server retries after the unlock.
void replyCapture(SCaptureJob& job) {
    // Sending can fail if the connection has gone; this runs inside Wayland
    // loop callbacks, where an escaping exception would end the compositor.
    try {
        if (job.epoch != g.lockEpoch)
            job.result.returnError(sdbus::Error(sdbus::Error::Name{ERR_SESSION_LOCKED}, "The desktop session was locked while the capture was in progress."));
        else if (!job.error.empty())
            job.result.returnError(sdbus::Error(sdbus::Error::Name{ERR_CAPTURE}, job.error));
        else
            job.result.returnResults(job.png);
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

void submitCapture(sdbus::Result<std::vector<uint8_t>>&& result, UP<SCaptureJob> job) {
    ensureCaptureWorker();
    job->result = std::move(result);
    {
        std::lock_guard lock(captureWorker.mutex);
        captureWorker.pending.push_back(std::move(job));
    }
    captureWorker.wake.notify_one();
}

// Joins the worker and answers whatever it had queued or finished with an
// error, rather than leaving those callers to time out; run before the bus
// connection goes away.
void stopCaptureWorker() {
    if (captureWorker.thread.joinable()) {
        {
            std::lock_guard lock(captureWorker.mutex);
            captureWorker.stop = true;
        }
        captureWorker.wake.notify_one();
        captureWorker.thread.join();
    }
    for (auto* queue : {&captureWorker.pending, &captureWorker.done}) {
        for (auto& job : *queue) {
            job->error = "the plugin is unloading";
            job->png.clear();
            replyCapture(*job);
        }
        queue->clear();
    }
    if (captureWorker.doneSource) {
        wl_event_source_remove(captureWorker.doneSource);
        captureWorker.doneSource = nullptr;
    }
    if (captureWorker.doneFd >= 0) {
        close(captureWorker.doneFd);
        captureWorker.doneFd = -1;
    }
}

// Compositor-thread side of a window capture: admission and the one
// offscreen render. Hyprland's own single-window snapshot renders the window
// with its decorations and popups at its real position on a transparent
// monitor-sized canvas.
UP<SCaptureJob> captureWindow(const std::string& windowId, uint32_t maxDimension) {
    requireControlAvailable();
    requireUnlockedSession();
    if (g.running)
        noteActivity();
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
    auto job = newCaptureJob(*region, monitor->m_scale, maxDimension, false);

    const auto fb = g_pHyprRenderer->makeSnapshotFB(window);
    if (!fb)
        captureFailed("window is not visible for capture");
    job->layers.push_back({readFramebufferPixels(fb), unsigned(monitor->m_transform), monitor->logicalBox(), double(monitor->m_scale)});
    return job;
}

// Compositor-thread side of a region capture: every intersecting monitor is
// rendered at its own scale; the worker stitches them at the sharpest one.
UP<SCaptureJob> captureRegion(int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension) {
    requireControlAvailable();
    requireUnlockedSession();
    if (g.running)
        noteActivity();
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

    auto job = newCaptureJob(*region, scale, maxDimension, true);
    for (const auto& mon : monitors)
        job->layers.push_back({renderMonitorPixels(mon), unsigned(mon->m_transform), mon->logicalBox(), double(mon->m_scale)});
    return job;
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
                    // Asynchronous on the bus: the handler returns once the
                    // GPU work is done and the reply follows from
                    // onCaptureDone. An exception thrown here still becomes
                    // the error reply, exactly as for the synchronous methods.
                    sdbus::registerMethod("captureWindow").implementedAs([](sdbus::Result<std::vector<uint8_t>> result, const std::string& id, uint32_t maxDimension) {
                        g.authentication->require();
                        submitCapture(std::move(result), captureWindow(id, maxDimension));
                    }),
                    sdbus::registerMethod("captureRegion").implementedAs([](sdbus::Result<std::vector<uint8_t>> result, int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension) {
                        g.authentication->require();
                        submitCapture(std::move(result), captureRegion(x, y, width, height, maxDimension));
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
