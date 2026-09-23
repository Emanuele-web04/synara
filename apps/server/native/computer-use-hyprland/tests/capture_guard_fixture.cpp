#include <algorithm>
#include <cstdint>
#include <iostream>
#include <memory>
#include <optional>
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

constexpr const char* ERR_RELEASED = "org.synara.ComputerUse.Error.ControlReleased";
constexpr const char* ERR_SESSION_LOCKED = "org.synara.ComputerUse.Error.SessionLocked";
constexpr const char* RELEASE_SHORTCUT_LABEL = "Meta+Shift+Esc";
std::string releaseShortcutText() { return RELEASE_SHORTCUT_LABEL; }
struct { bool releasedByUser = false, running = false; } g;
int activityCalls = 0, rendererAccesses = 0;
void noteActivity() { ++activityCalls; }
[[noreturn]] void captureFailed(const std::string& message) { throw std::runtime_error(message); }
[[noreturn]] void unexpectedRender() { throw std::runtime_error("unexpected renderer work"); }

// The compositor's two answers about the desktop being off limits.
struct LockManager { bool locked = false; bool isSessionLocked() { return locked; } } lockManager;
LockManager* g_pSessionLockManager = &lockManager;
struct Compositor { bool m_sessionActive = true; } compositor;
Compositor* g_pCompositor = &compositor;

// Only renderer availability may be checked in this fixture. All capture work
// fails loudly if the released path gets past its admission guard.
struct CBox { double x = 0, y = 0, w = 1, h = 1; };
struct Monitor {
    bool m_output = true;
    double m_scale = 1;
    unsigned m_transform = 0;
    CBox logicalBox() { unexpectedRender(); }
};
using PHLMONITOR = std::shared_ptr<Monitor>;
struct Window { std::weak_ptr<Monitor> m_monitor; };
using PHLWINDOW = std::shared_ptr<Window>;
struct Framebuffer {};
struct Renderer { std::shared_ptr<Framebuffer> makeSnapshotFB(PHLWINDOW) { unexpectedRender(); } };
struct RendererHandle {
    explicit operator bool() const { ++rendererAccesses; return false; }
    Renderer* operator->() const { unexpectedRender(); }
} g_pHyprRenderer, g_pHyprOpenGL;
PHLWINDOW findWindowById(const std::string&) { unexpectedRender(); }
CBox windowBounds(PHLWINDOW) { unexpectedRender(); }
CBox workspaceGeometry() { unexpectedRender(); }
std::optional<CBox> intersectBoxes(const CBox&, const CBox&) { unexpectedRender(); }
struct MonitorState { std::vector<PHLMONITOR> monitors() { unexpectedRender(); } };
namespace State { MonitorState* monitorState() { unexpectedRender(); } }
std::shared_ptr<Framebuffer> renderMonitorFramebuffer(PHLMONITOR) { unexpectedRender(); }

// The job a capture hands to the encode worker. Only its shape is needed:
// admission must fail before one is ever made.
struct SCaptureJob {};
void addCaptureLayer(SCaptureJob&, const std::shared_ptr<Framebuffer>&, const PHLMONITOR&, const CBox&) { unexpectedRender(); }
constexpr uint32_t CAPTURE_FLAG_PASSIVE = 1;
template <typename T> using UP = std::unique_ptr<T>;
UP<SCaptureJob> newCaptureJob(const CBox&, double, uint32_t, bool, uint32_t) { unexpectedRender(); }

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

void expectRefused(auto action, const char* errorName, const char* what) {
    bool rejected = false;
    const int previousActivity = activityCalls, previousAccesses = rendererAccesses;
    try {
        action();
    } catch (const sdbus::Error& error) {
        check(error.name == errorName, "wrong error name");
        if (errorName == ERR_RELEASED)
            check(std::string(error.what()).find(RELEASE_SHORTCUT_LABEL) != std::string::npos,
                  "release error omitted the resume shortcut");
        rejected = true;
    }
    check(rejected, what);
    check(activityCalls == previousActivity, "refused capture extended session activity");
    check(rendererAccesses == previousAccesses, "refused capture accessed the renderer");
}

void expectRendererCheck(auto action) {
    bool checked = false;
    const int previousAccesses = rendererAccesses;
    try {
        action();
    } catch (const sdbus::Error&) {
        throw std::runtime_error("capture stayed blocked");
    } catch (const std::runtime_error& error) {
        check(std::string(error.what()) == "render unavailable", "unexpected capture error");
        checked = true;
    }
    check(checked && rendererAccesses == previousAccesses + 1, "capture did not reach renderer check");
}

int main() {
    const auto windowCapture = [] { captureWindow("window", 1024, 0); };
    const auto regionCapture = [] { captureRegion(0, 0, 100, 100, 1024, 0); };
    g.releasedByUser = true;
    for (const bool running : {false, true}) {
        g.running = running;
        expectRefused([] { requireControlAvailable(); }, ERR_RELEASED, "released control was allowed");
        expectRefused(windowCapture, ERR_RELEASED, "released window capture was allowed");
        expectRefused(regionCapture, ERR_RELEASED, "released region capture was allowed");
    }
    g.releasedByUser = false;
    requireControlAvailable();

    // Locked screen, then inactive logind session: both refuse capture with
    // SessionLocked before any activity or renderer work, running or not.
    for (const bool running : {false, true}) {
        g.running = running;
        lockManager.locked = true;
        check(sessionLocked(), "lock not reported");
        expectRefused([] { requireUnlockedSession(); }, ERR_SESSION_LOCKED, "locked session was allowed");
        expectRefused(windowCapture, ERR_SESSION_LOCKED, "locked window capture was allowed");
        expectRefused(regionCapture, ERR_SESSION_LOCKED, "locked region capture was allowed");
        lockManager.locked = false;
        compositor.m_sessionActive = false;
        check(sessionLocked(), "inactive session not reported");
        expectRefused(windowCapture, ERR_SESSION_LOCKED, "inactive-session window capture was allowed");
        expectRefused(regionCapture, ERR_SESSION_LOCKED, "inactive-session region capture was allowed");
        compositor.m_sessionActive = true;
    }
    check(!sessionLocked(), "unlocked session reported locked");
    // The released latch outranks the lock in the answer: it needs the human.
    g.releasedByUser = true;
    lockManager.locked = true;
    expectRefused(windowCapture, ERR_RELEASED, "released capture behind a lock was allowed");
    g.releasedByUser = false;
    lockManager.locked = false;

    g.running = true;
    expectRendererCheck(windowCapture);
    expectRendererCheck(regionCapture);
    check(activityCalls == 2, "resumed capture did not restore activity updates");
    // A passive capture is an observer's frame: admitted like any other, but
    // it neither extends the session nor repaints the badge.
    expectRendererCheck([] { captureWindow("window", 1024, CAPTURE_FLAG_PASSIVE); });
    expectRendererCheck([] { captureRegion(0, 0, 100, 100, 1024, CAPTURE_FLAG_PASSIVE | 2); });
    check(activityCalls == 2, "passive capture counted as agent activity");
    std::cout << "Emergency release and session lock block both capture paths before activity and renderer access.\n";
}
