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
constexpr const char* RELEASE_SHORTCUT_LABEL = "Meta+Shift+Esc";
struct { bool releasedByUser = false, running = false; } g;
int activityCalls = 0, rendererAccesses = 0;
void noteActivity() { ++activityCalls; }
[[noreturn]] void captureFailed(const std::string& message) { throw std::runtime_error(message); }
[[noreturn]] void unexpectedRender() { throw std::runtime_error("unexpected renderer work"); }

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
struct Renderer { void* makeSnapshotFB(PHLWINDOW) { unexpectedRender(); } };
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
struct SCapturePixels { std::vector<uint8_t> rgba; int w = 0, h = 0; };
SCapturePixels readFramebufferPixels(void*) { unexpectedRender(); }
SCapturePixels renderMonitorPixels(PHLMONITOR) { unexpectedRender(); }
void transformCapturePixels(std::vector<uint8_t>&, int&, int&, unsigned) { unexpectedRender(); }

struct cairo_surface_t {};
struct cairo_t {};
constexpr int CAIRO_OPERATOR_SOURCE = 0, CAIRO_FILTER_GOOD = 0;
cairo_surface_t* pixelsToCairo(const SCapturePixels&) { unexpectedRender(); }
cairo_surface_t* captureTarget(const CBox&, double, int&, int&) { unexpectedRender(); }
cairo_t* cairo_create(cairo_surface_t*) { unexpectedRender(); }
void cairo_set_operator(cairo_t*, int) { unexpectedRender(); }
void cairo_set_source_surface(cairo_t*, cairo_surface_t*, double, double) { unexpectedRender(); }
void cairo_set_source_rgba(cairo_t*, double, double, double, double) { unexpectedRender(); }
void cairo_paint(cairo_t*) { unexpectedRender(); }
void cairo_destroy(cairo_t*) { unexpectedRender(); }
void cairo_surface_flush(cairo_surface_t*) { unexpectedRender(); }
void cairo_surface_destroy(cairo_surface_t*) { unexpectedRender(); }
void cairo_save(cairo_t*) { unexpectedRender(); }
void cairo_translate(cairo_t*, double, double) { unexpectedRender(); }
void cairo_scale(cairo_t*, double, double) { unexpectedRender(); }
void* cairo_get_source(cairo_t*) { unexpectedRender(); }
void cairo_pattern_set_filter(void*, int) { unexpectedRender(); }
void cairo_restore(cairo_t*) { unexpectedRender(); }
void drawGhostCursorOverlay(cairo_t*, const CBox&, double) { unexpectedRender(); }
std::vector<uint8_t> finishCapture(cairo_surface_t*, uint32_t) { unexpectedRender(); }

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

void expectReleased(auto action) {
    bool rejected = false;
    try {
        action();
    } catch (const sdbus::Error& error) {
        check(error.name == ERR_RELEASED, "wrong release error name");
        check(std::string(error.what()).find(RELEASE_SHORTCUT_LABEL) != std::string::npos,
              "release error omitted the resume shortcut");
        rejected = true;
    }
    check(rejected, "released capture was allowed");
    check(activityCalls == 0, "released capture extended session activity");
    check(rendererAccesses == 0, "released capture accessed the renderer");
}

void expectRendererCheck(auto action) {
    bool checked = false;
    const int previousAccesses = rendererAccesses;
    try {
        action();
    } catch (const sdbus::Error&) {
        throw std::runtime_error("capture stayed blocked after user resume");
    } catch (const std::runtime_error& error) {
        check(std::string(error.what()) == "render unavailable", "unexpected capture error");
        checked = true;
    }
    check(checked && rendererAccesses == previousAccesses + 1, "resumed capture did not reach renderer check");
}

int main() {
    const auto windowCapture = [] { captureWindow("window", 1024); };
    const auto regionCapture = [] { captureRegion(0, 0, 100, 100, 1024); };
    g.releasedByUser = true;
    for (const bool running : {false, true}) {
        g.running = running;
        expectReleased([] { requireControlAvailable(); });
        expectReleased(windowCapture);
        expectReleased(regionCapture);
    }
    g.releasedByUser = false;
    requireControlAvailable();
    expectRendererCheck(windowCapture);
    expectRendererCheck(regionCapture);
    check(activityCalls == 2, "resumed capture did not restore activity updates");
    std::cout << "Emergency release blocks both capture paths before activity and renderer access.\n";
}
