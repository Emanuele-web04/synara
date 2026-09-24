// Capture sizing (S5), driven through the production planner and the canvas
// tiler: what is rendered and delivered for a maxDimension, and that the parts
// of a capture spanning outputs - at different scales, left of or above the
// origin - tile the canvas exactly, with no gap and no overlap.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <optional>
#include <stdexcept>
#include <vector>

using qreal = double;
using qint64 = int64_t;
using uint = unsigned int;
int qRound(double v) { return int(std::lround(v)); }
template <class T> T qMax(T a, T b) { return std::max(a, b); }
template <class T> T qBound(T lo, T v, T hi) { return std::clamp(v, lo, hi); }
struct QSize {
    int w = -1, h = -1;
    QSize() = default;
    QSize(int w, int h) : w(w), h(h) {}
    int width() const { return w; }
    int height() const { return h; }
    bool operator==(const QSize& o) const { return w == o.w && h == o.h; }
};
struct QRect {
    int x = 0, y = 0, w = 0, h = 0;
    QRect() = default;
    QRect(int x, int y, int w, int h) : x(x), y(y), w(w), h(h) {}
    bool isEmpty() const { return w <= 0 || h <= 0; }
    QRect intersected(const QRect& o) const {
        const int l = std::max(x, o.x), t = std::max(y, o.y);
        const int r = std::min(x + w, o.x + o.w), b = std::min(y + h, o.y + o.h);
        return r > l && b > t ? QRect(l, t, r - l, b - t) : QRect();
    }
};
struct RectF {
    double x0 = 0, y0 = 0, w = 0, h = 0;
    RectF() = default;
    RectF(double x, double y, double w, double h) : x0(x), y0(y), w(w), h(h) {}
    bool isEmpty() const { return w <= 0 || h <= 0; }
    double width() const { return w; }
    double height() const { return h; }
    double left() const { return x0; }
    double top() const { return y0; }
    double right() const { return x0 + w; }
    double bottom() const { return y0 + h; }
    RectF intersected(const RectF& o) const {
        const double l = std::max(left(), o.left()), t = std::max(top(), o.top());
        const double r = std::min(right(), o.right()), b = std::min(bottom(), o.bottom());
        return r > l && b > t ? RectF(l, t, r - l, b - t) : RectF();
    }
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

struct Output {
    RectF geometry;
    qreal scale;
};

// Tiles a capture of @p region the way captureAtRenderOpportunity does and
// checks no canvas pixel is painted twice; with @p covered (the outputs cover
// the whole region), also that none is left out.
void checkTiling(const RectF& region, const std::vector<Output>& outputs, uint maxDimension, bool covered, const char* what) {
    qreal nativeScale = 1;
    for (const Output& output : outputs) {
        if (!region.intersected(output.geometry).isEmpty()) nativeScale = std::max(nativeScale, output.scale);
    }
    const std::optional<CapturePlan> plan = planCapture(region, nativeScale, maxDimension);
    check(plan.has_value(), what);
    std::vector<int> coverage(size_t(plan->renderSize.width()) * plan->renderSize.height(), 0);
    for (const Output& output : outputs) {
        const RectF viewport = region.intersected(output.geometry);
        if (viewport.isEmpty()) continue;
        const QRect destination = deviceDestination(viewport, region, plan->renderScale, plan->renderSize);
        for (int y = destination.y; y < destination.y + destination.h; ++y)
            for (int x = destination.x; x < destination.x + destination.w; ++x)
                ++coverage[size_t(y) * plan->renderSize.width() + x];
    }
    const bool exact = std::all_of(coverage.begin(), coverage.end(), [covered](int c) { return c == 1 || (!covered && c == 0); });
    if (!exact) {
        std::cout << what << ": canvas " << plan->renderSize.width() << "x" << plan->renderSize.height() << "\n";
        throw std::runtime_error("the parts must tile the canvas exactly once");
    }
}

int main() {
    try {
        // 4K at scale 2, captured at 2048: the GPU renders the 2048 wide
        // image itself.
        std::optional<CapturePlan> plan = planCapture(RectF(0, 0, 1920, 1080), 2, 2048);
        check(plan && plan->finalSize == QSize(2048, 1152), "delivered at maxDimension");
        check(plan->renderSize == plan->finalSize && std::abs(plan->renderScale - 2048.0 / 1920) < 1e-9, "rendered at the delivered size");
        check(std::abs(plan->finalScale - 2048.0 / 1920) < 1e-9 && plan->nativeScale == 2, "the scales are reported");

        // At 1536 the step is 0.4: the GPU goes to half (1920 wide), the
        // encoder takes it the rest of the way.
        plan = planCapture(RectF(0, 0, 1920, 1080), 2, 1536);
        check(plan && plan->renderSize == QSize(1920, 1080) && plan->renderScale == 1 && plan->finalSize == QSize(1536, 864), "a 0.4 downscale renders at half");

        // A mild downscale is left to the encoder: rendered native.
        plan = planCapture(RectF(0, 0, 1920, 1080), 1, 1536);
        check(plan && plan->renderSize == QSize(1920, 1080) && plan->renderScale == 1 && plan->finalSize == QSize(1536, 864), "a 0.8 downscale renders native");

        // Below half: the GPU goes to half, the encoder the rest.
        plan = planCapture(RectF(0, 0, 1920, 1080), 2, 800);
        check(plan && plan->renderSize == QSize(1920, 1080) && plan->renderScale == 1 && plan->finalSize == QSize(800, 450), "a 0.21 downscale renders at half");

        // No maxDimension, or one the capture already fits: native.
        plan = planCapture(RectF(0, 0, 1920, 1080), 1.5, 0);
        check(plan && plan->renderSize == QSize(2880, 1620) && plan->finalSize == plan->renderSize && plan->renderScale == 1.5, "0 keeps native pixels");
        plan = planCapture(RectF(0, 0, 640, 480), 1, 2048);
        check(plan && plan->renderSize == QSize(640, 480) && plan->finalSize == QSize(640, 480), "a small capture is not upscaled");

        // The delivered size never exceeds maxDimension, whatever the rounding.
        for (int width = 1000; width < 1100; ++width) {
            plan = planCapture(RectF(0.25, 0, width + 0.5, 777.3), 1.25, 1024);
            check(plan && std::max(plan->finalSize.width(), plan->finalSize.height()) <= 1024, "maxDimension is a hard bound");
            check(plan->renderSize.width() >= plan->finalSize.width(), "the encoder only ever scales down");
        }
        check(!planCapture(RectF(0, 0, 0, 10), 1, 0), "an empty region has no plan");

        // Mixed scales left of and above the origin, a rotated (portrait)
        // output, and fractional scales: the parts tile the canvas exactly.
        const std::vector<Output> layout{
            {RectF(-2160, -400, 2160, 3840), 1},   // rotated, left of and above the origin
            {RectF(0, 0, 1920, 1080), 2},          // the primary, at scale 2
            {RectF(1920, 0, 1706.6667, 960), 1.5}, // fractional
        };
        checkTiling(RectF(-2160, -400, 5786.6667, 3840), layout, 0, false, "the whole desktop, native");
        checkTiling(RectF(-2160, -400, 5786.6667, 3840), layout, 2048, false, "the whole desktop at 2048");
        checkTiling(RectF(-300, 100, 2800, 800), layout, 0, true, "a region across all three, native");
        checkTiling(RectF(-300, 100, 2800, 800), layout, 1536, true, "a region across all three at 1536");
        checkTiling(RectF(-300, 100, 2800, 800), layout, 700, true, "a region across all three at 700");
        checkTiling(RectF(1500.3, 50.7, 999.9, 850), layout, 1024, true, "scale 2 beside scale 1.5");
        checkTiling(RectF(-37.5, 12.25, 1000.5, 333.3), layout, 700, true, "a fractional region across the origin");
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "capture plan: rendered at the delivered size where the GPU filters well, parts tile the canvas exactly.\n";
}
