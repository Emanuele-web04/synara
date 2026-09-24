/*
    SPDX-FileCopyrightText: 2026 Synara

    SPDX-License-Identifier: GPL-2.0-or-later
*/

#include "synaracomputeruseplugin.h"
#include "synaracomputerusebuildinfo.h"

#include "core/backendoutput.h"
#include "core/inputdevice.h"
#include "core/output.h"
#include "core/outputlayer.h"
#include "core/renderloop.h"
#include "core/rendertarget.h"
#include "core/session.h"
#include "compositor.h"
#include "cursor.h"
#include "effect/effecthandler.h"
#include "input.h"
#include "input_event_spy.h"
#include "keyboard_input.h"
#include "keyboard_layout.h"
#include "main.h"
#include "opengl/eglcontext.h"
#include "opengl/glframebuffer.h"
#include "opengl/gltexture.h"
#include "scene/scene.h"
#include "pointer_input.h"
#include "scene/imageitem.h"
#include "scene/workspacescene.h"
#include "utils/serial.h"
#include "wayland/clientconnection.h"
#include "wayland/display.h"
#include "wayland/keyboard.h"
#include "wayland/pointer.h"
#include "wayland/seat.h"
#include "wayland/surface.h"
#include "wayland/xdgactivation_v1.h"
#include "wayland/xdgshell.h"
#include "wayland_server.h"
#include "window.h"
#include "workspace.h"
#include "xdgactivationv1.h"
#include "xkb.h"

#include <KGlobalAccel>

#include <QAction>
#include <QBuffer>
#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusError>
#include <QDBusMessage>
#include <QDBusMetaType>
#include <QEasingCurve>
#include <QFont>
#include <QFontMetricsF>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QKeySequence>
#include <QPainter>
#include <QPainterPath>
#include <QPen>
#include <QStringList>
#include <QThreadPool>

#include <wayland-server-core.h>
#include <wayland-server-protocol.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iterator>
#include <limits>
#include <optional>
#include <utility>

namespace KWin
{

static const QString s_service = QStringLiteral("org.synara.ComputerUse");
static const QString s_path = QStringLiteral("/org/synara/ComputerUse");
static const QString s_interface = QStringLiteral("org.synara.ComputerUse1");
static const QString s_build = QStringLiteral(SYNARA_COMPUTER_USE_BUILD_ID);
static const QString s_gitHash = QStringLiteral(SYNARA_COMPUTER_USE_GIT_HASH);
static const QString s_buildTimestamp = QStringLiteral(SYNARA_COMPUTER_USE_BUILD_TIMESTAMP);
static const QString s_kwinVersion = QStringLiteral(SYNARA_COMPUTER_USE_KWIN_VERSION);
static const QString s_agentCursorName = QStringLiteral("synara-agent");
// healthJson's interface generation and the optional methods on top of the
// version 1 set; see the XML for what each feature names.
static constexpr int s_interfaceVersion = 2;
static const QStringList s_interfaceFeatures = {
    QStringLiteral("captureEx"),
    QStringLiteral("keys"),
    QStringLiteral("waitForSettle"),
    QStringLiteral("windowsStateJson"),
};
static const QString s_captureErrorName = QStringLiteral("org.synara.ComputerUse.Error.CaptureFailed");
static const QString s_releasedErrorName = QStringLiteral("org.synara.ComputerUse.Error.ControlReleased");
// A window whose application never bound the agent seat. Distinct from every
// other refusal here because nothing is wrong with the request, the target, or
// the plugin: the application simply cannot be reached on a second seat.
static const QString s_seatUnsupportedErrorName = QStringLiteral("org.synara.ComputerUse.Error.SeatUnsupported");
// The human is working in the window this action was aimed at. Retryable, and
// nothing was injected: two cursors do not make the window someone is typing in
// a valid target.
static const QString s_humanActiveErrorName = QStringLiteral("org.synara.ComputerUse.Error.HumanActive");
// The screen is locked or the logind session is inactive (another VT, a
// greeter). Retryable: the desktop behind the lock is exactly what the agent
// must not see or touch, and nothing about the request was wrong.
static const QString s_sessionLockedErrorName = QStringLiteral("org.synara.ComputerUse.Error.SessionLocked");
// A dead server must never leave the agent seat alive, so the session's
// deadline lives here rather than in the server that may have crashed.
static constexpr uint s_defaultIdleTimeoutMs = 5 * 60 * 1000;
static constexpr uint s_minIdleTimeoutMs = 1000;
static constexpr uint s_maxIdleTimeoutMs = 60 * 60 * 1000;
// Matches DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS in humanActivity.ts, so the plugin
// and the server hand back the same refusal after the same quiet period. The server
// pushes its own value after every start(); this is what an unconfigured plugin
// uses on its own.
static constexpr uint s_defaultHumanActiveGuardMs = 2000;
static constexpr uint s_minHumanActiveGuardMs = 100;
static constexpr uint s_maxHumanActiveGuardMs = 60 * 1000;
static const QString s_releaseActionName = QStringLiteral("SynaraReleaseComputerControl");
// keys() per call: a sentence of typing, and a bound on how long one call
// can hold the compositor thread.
static constexpr qsizetype s_maxKeyStrokes = 256;
// waitForSettle: concurrent waits, and the longest a single one may take. A
// longer timeout is clamped rather than refused; the caller learns it from
// `settled` being false.
static constexpr size_t s_maxSettleWaits = 16;
static constexpr uint s_maxSettleTimeoutMs = 30 * 1000;
static constexpr int s_captureRenderDeadlineMilliseconds = 2000;
static constexpr int s_captureTargetIdleMs = 10 * 1000;
static constexpr int s_captureEncodeDeadlineMilliseconds = 5000;
static constexpr int s_captureMaxNativeSide = 16384;
static constexpr qint64 s_captureMaxNativePixels = 64LL * 1024 * 1024;
static const QString s_captureSizeLimitReason = QStringLiteral("capture exceeds 16384 pixels per side or 64 megapixels");
// Qt's PNG writer maps quality q to zlib level (100 - q) * 9 / 91, so 80 is
// level 1 (checked with a deflateInit2 shim; the default, -1, is zlib's 6).
// Measured on a 2048x1152 desktop-like frame: 97 ms -> 55 ms for RGBA and
// 45 ms for the RGBX an opaque capture uses, for files about 4% larger. Every
// preview still and every observation pays the encode, so speed wins.
static constexpr int s_pngFastQuality = 80;
// The ghost cursor is drawn by the plugin instead of taken from the human's
// cursor theme: a second arrow in their own theme is indistinguishable from
// theirs, and being able to tell the two apart is the whole point of it.
// The glyph itself is an ordinary pointer — white body, dark ink — and the
// telling-apart is done by a saturated violet halo behind it, which reads
// against any wallpaper without making the arrow itself look foreign.
static const QColor s_agentAccentColor = QColor(0x7c, 0x3a, 0xed);
static const QColor s_agentRimColor = QColor(0xff, 0xff, 0xff);
static const QColor s_agentInkColor = QColor(0x14, 0x0a, 0x2e, 0x99);
// Halo reach in multiples of the cursor size, with a floor so the smallest
// cursor sizes still show a visible glow; per-pass alpha of the innermost
// stroke, from which the outer passes fade.
static constexpr qreal s_agentGlowRadiusRatio = 0.30;
static constexpr qreal s_agentMinGlowRadius = 4.0;
static constexpr int s_agentGlowPasses = 6;
static constexpr qreal s_agentGlowPassAlpha = 0.15;
// Stroke widths in multiples of the cursor size. Fixed widths would swallow the
// accent colour at small cursor sizes and disappear at large ones, so the whole
// glyph has to scale together.
static constexpr qreal s_agentInkStrokeRatio = 0.085;
static constexpr qreal s_agentRimStrokeRatio = 0.045;
static constexpr qreal s_agentMinInkStrokeWidth = 1.8;
static constexpr qreal s_agentMinRimStrokeWidth = 1.0;
static constexpr int s_agentBadgeMinTextPixels = 11;
// Elide width in multiples of the cursor size, so a long name is cut at the same
// point relative to the badge whatever cursor size the human runs.
static constexpr qreal s_agentBadgeMaxTextWidthRatio = 8;
static constexpr int s_agentBadgeHoldMilliseconds = 2000;
static constexpr int s_agentBadgeFadeMilliseconds = 320;
// Shown when the server has not named the driving thread, so the badge still
// says who is moving the cursor rather than disappearing.
static const QString s_agentFallbackName = QStringLiteral("Agent");
// The agent gets its own wl_seat so its pointer and keyboard focus are fully
// independent of the user's real seat. Without this the plugin would have to
// time-share the real seat's focus, and concurrent user input would cross
// over (agent keys landing in the user's window and vice versa).
static const QString s_agentSeatName = QStringLiteral("synara-agent");

/**
 * Set only by the server when it spawns a nested compositor for the agent.
 *
 * Deliberately an environment variable and not a D-Bus method. The choice is a
 * property of the compositor instance, fixed before the first client connects,
 * and reading it from the environment makes the dangerous direction structurally
 * impossible: the human's compositor is started by their own session, so nothing
 * reachable over the bus can talk this plugin into driving their seat.
 */
static const char *s_ownsCompositorEnv = "SYNARA_COMPUTER_USE_OWNS_COMPOSITOR";

static bool readOwnsCompositor()
{
    return qgetenv(s_ownsCompositorEnv) == QByteArrayLiteral("1");
}

// The direct-injection helpers, defined with the direct path below and used
// by the state report above it.
namespace
{
SurfaceInterface *humanPointerSurfaceInClientOf(const SurfaceInterface *surface);
SurfaceInterface *humanKeyboardSurfaceInClientOf(const SurfaceInterface *surface);
const Xkb *humanXkb();
}

/**
 * When the human last touched their own keyboard, mouse, touchpad or tablet.
 *
 * An `InputEventSpy` and not `waylandServer()->seat()->timestamp()`, and the
 * difference is the whole reason this guard can be trusted. A spy is called from
 * `InputRedirection` before any filter runs, so it sees exactly the events that
 * entered the compositor from a real device - which is precisely the set neither
 * agent path can produce. Agent input on the dedicated seat is delivered on a
 * second `SeatInterface` that KWin's input pipeline knows nothing about, and
 * direct per-client injection writes to `wl_pointer`/`wl_keyboard` resources
 * without going through a seat at all. Neither ever reaches a spy, so there is
 * nothing here to misattribute. (KWin tracks its own user activity the same way:
 * `InputRedirection` keeps a `m_userActivitySpy`.)
 *
 * The seat timestamp would have been the shorter route and it is the wrong one
 * on two counts: it is whatever was last handed to `setTimestamp`, which is a
 * value written by anything that forwards events through seat0 rather than a
 * statement about a device, and it carries the libinput event clock, which we
 * would then have to assume is the same clock we read back. Stamping the arrival
 * here with `QElapsedTimer` removes both questions - one clock, one writer.
 */
class SynaraHumanInputSpy : public InputEventSpy
{
public:
    /**
     * Run synchronously for every real event of that class, from inside
     * InputRedirection and before its forwarding filter delivers the event to
     * seat0's focus: every PointerInputRedirection::process* and
     * KeyboardInputRedirection::processKey call processSpies() ahead of
     * processFilters(). That ordering is what lets the plugin hand a borrowed
     * client object back to the human between their device producing an event
     * and the client hearing it. Touch and tablet count as pointer-class: a
     * tablet without client support is forwarded as pointer motion anyway.
     */
    std::function<void()> onPointerInput;
    std::function<void()> onKeyboardInput;
    /**
     * A press of any pointer-class device, where it landed and whether it is
     * the pointer's (whose focus names the surface it reaches) or a touch
     * point's or a pen's (which reach the window at their own position); and
     * a key press. Run after onPointerInput or onKeyboardInput for the same
     * event: the popup rule (handleHumanPointerPress) attributes and
     * dismisses by them.
     */
    std::function<void(const QPointF &, bool byPointerFocus)> onPointerPress;
    std::function<void()> onKeyPress;

    /** Milliseconds since the last real event of any device, or -1 if none. */
    qint64 ageMilliseconds() const
    {
        const qint64 pointer = pointerAgeMilliseconds();
        const qint64 keyboard = keyboardAgeMilliseconds();
        if (pointer < 0) {
            return keyboard;
        }
        return keyboard < 0 ? pointer : std::min(pointer, keyboard);
    }
    qint64 pointerAgeMilliseconds() const
    {
        return m_lastPointer.isValid() ? m_lastPointer.elapsed() : -1;
    }
    qint64 keyboardAgeMilliseconds() const
    {
        return m_lastKeyboard.isValid() ? m_lastKeyboard.elapsed() : -1;
    }

    void pointerMotion(PointerMotionEvent *) override
    {
        notePointer();
    }
    void pointerButton(PointerButtonEvent *event) override
    {
        notePointer();
        if (event->state == PointerButtonState::Pressed && onPointerPress) {
            onPointerPress(event->position, true);
        }
    }
    void pointerAxis(PointerAxisEvent *) override
    {
        notePointer();
    }
    void keyboardKey(KeyboardKeyEvent *event) override
    {
        noteKeyboard();
        if (event->state == KeyboardKeyState::Pressed && onKeyPress) {
            onKeyPress();
        }
    }
    void touchDown(TouchDownEvent *event) override
    {
        notePointer();
        if (onPointerPress) {
            onPointerPress(event->pos, false);
        }
    }
    void touchMotion(TouchMotionEvent *) override
    {
        notePointer();
    }
    void touchUp(TouchUpEvent *) override
    {
        notePointer();
    }
    void tabletToolAxisEvent(TabletToolAxisEvent *) override
    {
        notePointer();
    }
    void tabletToolTipEvent(TabletToolTipEvent *event) override
    {
        notePointer();
        if (event->type == TabletToolTipEvent::Press && onPointerPress) {
            onPointerPress(event->position, false);
        }
    }
    void tabletToolButtonEvent(TabletToolButtonEvent *) override
    {
        notePointer();
    }
    void tabletPadButtonEvent(TabletPadButtonEvent *) override
    {
        notePointer();
    }

private:
    void notePointer()
    {
        m_lastPointer.restart();
        if (onPointerInput) {
            onPointerInput();
        }
    }
    void noteKeyboard()
    {
        m_lastKeyboard.restart();
        if (onKeyboardInput) {
            onKeyboardInput();
        }
    }

    // One clock per device class: the guard asks "is the human's pointer busy"
    // for a click and "is their keyboard busy" for a key, and a person typing
    // in a terminal with their mouse at rest is not using their mouse.
    QElapsedTimer m_lastPointer;
    QElapsedTimer m_lastKeyboard;
};

// Meta+Shift+Esc is unused by stock Plasma (kill-window is Ctrl+Alt+Esc) and
// mirrors the muscle memory of Ctrl+Shift+Esc elsewhere. The user's real seat
// feeds KWin's shortcut handling, and agent input never enters that pipeline,
// so the agent can neither trigger nor swallow this combination. This is the
// default asked for; what fires is m_effectiveReleaseShortcut.
static QKeySequence defaultReleaseShortcut()
{
    return QKeySequence(QKeyCombination(Qt::MetaModifier | Qt::ShiftModifier, Qt::Key_Escape));
}

static QJsonObject pointToJson(const QPointF &point)
{
    return {
        {QStringLiteral("x"), point.x()},
        {QStringLiteral("y"), point.y()},
    };
}

static QJsonObject rectToJson(const RectF &rect)
{
    return {
        {QStringLiteral("x"), rect.x()},
        {QStringLiteral("y"), rect.y()},
        {QStringLiteral("width"), rect.width()},
        {QStringLiteral("height"), rect.height()},
    };
}

struct CapturePart
{
    QImage image;
    QRect destination;
};

class CaptureLayer final : public OutputLayer
{
public:
    CaptureLayer(BackendOutput *output, GLFramebuffer *framebuffer)
        : OutputLayer(output, OutputLayerType::Primary)
        , m_framebuffer(framebuffer)
    {
    }

    DrmDevice *scanoutDevice() const override
    {
        return nullptr;
    }

    FormatModifierMap supportedDrmFormats() const override
    {
        return {};
    }

    void releaseBuffers() override
    {
    }

protected:
    std::optional<OutputLayerBeginFrameInfo> doBeginFrame() override
    {
        if (!m_framebuffer || !m_framebuffer->valid()) {
            return std::nullopt;
        }
        return OutputLayerBeginFrameInfo{
            RenderTarget(m_framebuffer),
            Region(0, 0, m_framebuffer->size().width(), m_framebuffer->size().height()),
        };
    }

    bool doEndFrame(const Region &, const Region &, OutputFrame *) override
    {
        return true;
    }

private:
    GLFramebuffer *const m_framebuffer;
};

class CaptureEncodeTask final : public QRunnable
{
public:
    explicit CaptureEncodeTask(std::function<void()> work)
        : m_work(std::move(work))
    {
        setAutoDelete(true);
    }

    void run() override
    {
        m_work();
    }

private:
    std::function<void()> m_work;
};

static std::optional<QSize> deviceSize(const RectF &rect, qreal scale)
{
    if (!std::isfinite(scale) || scale <= 0 || rect.isEmpty()) {
        return std::nullopt;
    }

    const qreal width = std::ceil(rect.width() * scale);
    const qreal height = std::ceil(rect.height() * scale);
    if (!std::isfinite(width) || !std::isfinite(height)
        || width < 1 || height < 1
        || width > std::numeric_limits<int>::max()
        || height > std::numeric_limits<int>::max()) {
        return std::nullopt;
    }
    return QSize(int(width), int(height));
}

static QRect deviceDestination(const RectF &part, const RectF &target, qreal scale, const QSize &targetSize)
{
    const auto roundedEdge = [&](qreal coordinate, qreal targetCoordinate, int limit) {
        return qBound(0, qRound((coordinate - targetCoordinate) * scale), limit);
    };

    // Round shared logical edges once, then derive each size from its edges.
    // Adjacent output parts therefore meet at the same device coordinate.
    const int left = part.left() <= target.left() ? 0 : roundedEdge(part.left(), target.left(), targetSize.width());
    const int top = part.top() <= target.top() ? 0 : roundedEdge(part.top(), target.top(), targetSize.height());
    const int right = part.right() >= target.right() ? targetSize.width() : roundedEdge(part.right(), target.left(), targetSize.width());
    const int bottom = part.bottom() >= target.bottom() ? targetSize.height() : roundedEdge(part.bottom(), target.top(), targetSize.height());
    if (right <= left || bottom <= top) {
        return {};
    }
    return QRect(left, top, right - left, bottom - top).intersected(QRect(0, 0, targetSize.width(), targetSize.height()));
}

/**
 * The PNG encoder's thread, shared by every plugin instance and never waited
 * on by one. A QThreadPool member is destroyed with the plugin, and
 * ~QThreadPool waits for its tasks, so an unload during a 64-megapixel encode
 * stalled the compositor for the whole of it. Function-static instead: the
 * plugin's destructor fails the request and moves on, the encode finishes on
 * its own and its result is dropped on the main thread when the receiver it
 * was for is gone. One thread, because one capture is in flight at a time.
 */
static QThreadPool *encodePool()
{
    static QThreadPool pool;
    static const bool configured = [] {
        pool.setMaxThreadCount(1);
        return true;
    }();
    Q_UNUSED(configured)
    return &pool;
}

static bool captureSizeWithinLimits(const QSize &size)
{
    return size.width() > 0
        && size.height() > 0
        && size.width() <= s_captureMaxNativeSide
        && size.height() <= s_captureMaxNativeSide
        && qint64(size.width()) * qint64(size.height()) <= s_captureMaxNativePixels;
}

/**
 * The sizes a capture is rendered and delivered at.
 *
 * `nativeScale` is the largest scale of the outputs the region touches, the
 * scale a maxDimension of 0 delivers. With a maxDimension at least a quarter
 * smaller than that, the GPU renders at the delivered size directly, so the
 * readback, the compose and the encode see only the pixels that are sent. A
 * 4K output at scale 2 captured at 2048 or 1536 reads back 9 or 8 MB instead
 * of 33; measured on a headless KWin 6.7.4, a 1536 PNG went from 53 to 43 ms
 * and a JPEG from 33 to 17 ms. Surface textures are
 * sampled bilinearly, which is a clean filter from about three quarters down
 * to half size and aliases outside that band, so a smaller target is rendered
 * at half the native scale and the encoder takes the rest of the way with an
 * area-averaging downscale; a mild one (1920 to 1536 on a scale 1 desktop) is
 * left to the encoder entirely, because the GPU's version of it came out 40%
 * larger as a PNG and slower overall.
 */
struct CapturePlan
{
    qreal nativeScale = 1;
    // What the parts are rendered at, and the canvas they are composed on.
    qreal renderScale = 1;
    QSize renderSize;
    // What is delivered, and at what scale; equal to the render size and
    // scale unless the CPU downscales.
    QSize finalSize;
    qreal finalScale = 1;
};

// The band of downscales the GPU takes on its own; see CapturePlan.
static constexpr qreal s_captureMinRenderFactor = 0.5;
static constexpr qreal s_captureMaxRenderFactor = 0.75;

static std::optional<CapturePlan> planCapture(const RectF &region, qreal nativeScale, uint maxDimension)
{
    const std::optional<QSize> native = deviceSize(region, nativeScale);
    if (!native) {
        return std::nullopt;
    }
    const auto scaled = [&native](qreal factor) {
        return QSize(qMax(1, qRound(native->width() * factor)), qMax(1, qRound(native->height() * factor)));
    };
    const qint64 largest = std::max(native->width(), native->height());
    const qreal factor = maxDimension > 0 && largest > maxDimension ? qreal(maxDimension) / qreal(largest) : 1.0;
    const qreal renderFactor = factor <= s_captureMaxRenderFactor ? std::max(factor, s_captureMinRenderFactor) : 1.0;
    CapturePlan plan;
    plan.nativeScale = nativeScale;
    plan.finalSize = factor < 1 ? scaled(factor) : *native;
    plan.renderSize = renderFactor == factor ? plan.finalSize : scaled(renderFactor);
    plan.renderScale = nativeScale * renderFactor;
    plan.finalScale = nativeScale * factor;
    return plan;
}

/**
 * Offscreen render targets kept between captures, keyed by size: a preview
 * polling one region, or observations of one window, reuse the same texture
 * and framebuffer instead of allocating a fresh pair per frame. Parts are read
 * back as soon as each is rendered, so one target per size is enough even
 * when a capture spans several outputs of the same size. Bounded, and emptied
 * after a quiet spell (s_captureTargetIdleMs), so an idle desktop does not
 * hold capture-sized textures on the GPU.
 */
class CaptureTargetPool
{
public:
    GLFramebuffer *acquire(EglContext *context, const QSize &size, QString *error)
    {
        if (context != m_context) {
            // The compositor's context was replaced, and these objects died
            // with the old one: nothing may be deleted in the new context.
            abandon();
            m_context = context;
        }
        ++m_clock;
        for (Target &target : m_targets) {
            if (target.size == size) {
                target.lastUse = m_clock;
                return target.framebuffer.get();
            }
        }
        if (m_targets.size() >= s_maxTargets) {
            m_targets.erase(std::min_element(m_targets.begin(), m_targets.end(), [](const Target &a, const Target &b) {
                return a.lastUse < b.lastUse;
            }));
        }
        Target target;
        target.size = size;
        target.lastUse = m_clock;
        target.texture = GLTexture::allocate(GL_RGBA8, size);
        if (!target.texture || target.texture->isNull()) {
            *error = QStringLiteral("offscreen texture allocation failed");
            return nullptr;
        }
        target.framebuffer = std::make_unique<GLFramebuffer>(target.texture.get());
        if (!target.framebuffer->valid()) {
            *error = QStringLiteral("offscreen framebuffer allocation failed");
            return nullptr;
        }
        m_targets.push_back(std::move(target));
        return m_targets.back().framebuffer.get();
    }

    /** Frees every target; @p context must be current if it is still alive. */
    void clear(EglContext *current)
    {
        if (current && current == m_context) {
            m_targets.clear();
        } else {
            abandon();
        }
    }

    bool isEmpty() const
    {
        return m_targets.empty();
    }

    EglContext *context() const
    {
        return m_context;
    }

private:
    struct Target
    {
        QSize size;
        quint64 lastUse = 0;
        // The framebuffer is declared after the texture it wraps, so it is
        // destroyed first.
        std::unique_ptr<GLTexture> texture;
        std::unique_ptr<GLFramebuffer> framebuffer;
    };

    void abandon()
    {
        for (Target &target : m_targets) {
            // Their GL names belonged to a context that is gone; deleting them
            // now would free whatever reuses those names in the current one.
            Q_UNUSED(target.framebuffer.release())
            Q_UNUSED(target.texture.release())
        }
        m_targets.clear();
    }

    static constexpr size_t s_maxTargets = 4;
    std::vector<Target> m_targets;
    EglContext *m_context = nullptr;
    quint64 m_clock = 0;
};

static bool isWindowVisibleForCapture(const Window *window)
{
    return window
        && !window->isDeleted()
        && window->isOnCurrentActivity()
        && window->isOnCurrentDesktop()
        && !window->isMinimized()
        && !window->isHidden()
        && !window->isHiddenByShowDesktop();
}

/**
 * What captureWindowEx and captureRegionEx take in `flags`. Without JPEG or
 * LUMA the bytes are a PNG, as from captureWindow and captureRegion; with
 * both, luma wins. Unknown bits are ignored, as the Hyprland plugin does.
 */
enum CaptureFlag : uint {
    // An observer's frame (the preview): not agent activity, so it neither
    // resets the idle deadline nor brings the badge back.
    CapturePassive = 1,
    CaptureJpeg = 2,
    // Raw 8-bit luma, row-major and unpadded, for measuring rather than looking.
    CaptureLuma = 4,
};
static constexpr int s_jpegQuality = 85;

enum class CaptureFormat {
    Png,
    Jpeg,
    Luma,
};

static CaptureFormat captureFormat(uint flags)
{
    if (flags & CaptureLuma) {
        return CaptureFormat::Luma;
    }
    return flags & CaptureJpeg ? CaptureFormat::Jpeg : CaptureFormat::Png;
}

struct EncodedCapture
{
    QByteArray bytes;
    QString mime;
};

static EncodedCapture encodeImage(QImage image, CaptureFormat format, bool opaque, qreal effectiveScale, QString *error)
{
    switch (format) {
    case CaptureFormat::Jpeg: {
        // Flattened onto the black the capture was composed over; JPEG has no
        // alpha to keep a window's surround in.
        image = image.convertToFormat(QImage::Format_RGB888);
        QByteArray jpeg;
        QBuffer buffer(&jpeg);
        if (image.isNull() || !buffer.open(QIODevice::WriteOnly) || !image.save(&buffer, "JPG", s_jpegQuality)) {
            *error = QStringLiteral("JPEG encoding failed");
            return {};
        }
        return {jpeg, QStringLiteral("image/jpeg")};
    }
    case CaptureFormat::Luma: {
        // The server correlates this against the PNG of the same capture
        // (scroll measurement), decoding that PNG's RGB as
        // floor((299 R + 587 G + 114 B) / 1000). So the bytes come from the
        // very pixels the PNG path would write — the same conversion, alpha
        // unpremultiplied the same way — through that same integer formula.
        // Qt's Grayscale8 conversion is colour-managed and differs by a few
        // levels on most pixels.
        image = image.convertToFormat(opaque ? QImage::Format_RGBX8888 : QImage::Format_RGBA8888);
        if (image.isNull()) {
            *error = QStringLiteral("luma conversion failed");
            return {};
        }
        const int width = image.width();
        QByteArray luma(qsizetype(width) * image.height(), Qt::Uninitialized);
        for (int y = 0; y < image.height(); ++y) {
            const uchar *row = image.constScanLine(y);
            uchar *out = reinterpret_cast<uchar *>(luma.data()) + qsizetype(y) * width;
            for (int x = 0; x < width; ++x) {
                const uchar *pixel = row + 4 * x;
                out[x] = uchar((299u * pixel[0] + 587u * pixel[1] + 114u * pixel[2]) / 1000u);
            }
        }
        return {luma, QStringLiteral("image/x-luma8; width=%1; height=%2").arg(image.width()).arg(image.height())};
    }
    case CaptureFormat::Png:
        break;
    }

    image.setText(QStringLiteral("SynaraCaptureScale"), QString::number(effectiveScale, 'f', 3));
    // An opaque capture has nothing to say in its alpha channel, and RGBX is
    // written as a three-channel PNG: a quarter less for zlib to chew through.
    image = image.convertToFormat(opaque ? QImage::Format_RGBX8888 : QImage::Format_RGBA8888);
    if (image.isNull()) {
        *error = QStringLiteral("PNG image conversion failed");
        return {};
    }

    QByteArray png;
    QBuffer buffer(&png);
    if (!buffer.open(QIODevice::WriteOnly) || !image.save(&buffer, "PNG", s_pngFastQuality)) {
        *error = QStringLiteral("PNG encoding failed");
        return {};
    }
    return {png, QStringLiteral("image/png")};
}

static EncodedCapture encodeCapture(const QList<CapturePart> &parts, const CapturePlan &plan, bool windowCapture, CaptureFormat format, QString *error)
{
    if (parts.isEmpty() || !plan.renderSize.isValid()) {
        *error = QStringLiteral("capture produced no pixels");
        return {};
    }

    QImage image(plan.renderSize, QImage::Format_RGBA8888_Premultiplied);
    if (image.isNull()) {
        *error = QStringLiteral("capture image allocation failed");
        return {};
    }
    // A screen is opaque by definition, but the scene's background clear is
    // transparent black, which the pixels keep on the offscreen readback path.
    // On a desktop with no maximized window that encodes as a mostly (or, on an
    // empty nested desktop, entirely) transparent PNG that viewers and models
    // flatten to white — nothing like the black the visible output shows. Only
    // a single-window PNG keeps alpha: there the surround genuinely is "not
    // this window" rather than screen the compositor painted black. JPEG has
    // no alpha to keep it in. Luma is composed exactly as the PNG is, because
    // it is measured against one.
    const bool opaqueBackground = !windowCapture || format == CaptureFormat::Jpeg;
    image.fill(opaqueBackground ? QColor(Qt::black) : QColor(Qt::transparent));

    QPainter painter(&image);
    painter.setCompositionMode(opaqueBackground ? QPainter::CompositionMode_SourceOver
                                                : QPainter::CompositionMode_Source);
    for (const CapturePart &part : parts) {
        if (part.image.isNull() || !part.destination.isValid()) {
            continue;
        }
        painter.save();
        painter.translate(part.destination.x(), part.destination.y() + part.destination.height());
        painter.scale(1, -1);
        painter.drawImage(QRect(0, 0, part.destination.width(), part.destination.height()), part.image);
        painter.restore();
    }
    painter.end();

    // Only outside the band the GPU renders at the delivered size in
    // (planCapture).
    if (plan.finalSize != plan.renderSize) {
        image = image.scaled(plan.finalSize, Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
        if (image.isNull()) {
            *error = QStringLiteral("capture downscale failed");
            return {};
        }
    }
    image.setDevicePixelRatio(plan.finalScale);

    return encodeImage(std::move(image), format, opaqueBackground, plan.nativeScale, error);
}

/**
 * The agent as an ordinary input device, for a compositor it owns outright.
 *
 * The dedicated seat exists so the agent can drive the desktop without touching
 * the human's pointer, and it is the right answer whenever a human is present.
 * It has one cost, which no amount of care removes: a client that never bound
 * that seat cannot be reached on it. Chromium binds exactly one wl_seat and
 * Xwayland does the same for every X11 client behind it, and both take the one
 * the compositor advertised first.
 *
 * A nested session has no human to protect, so there the agent stops being a
 * second seat and becomes a device on the first one. Events enter KWin's normal
 * input stack, which means focus follows clicks, global shortcuts fire, Xwayland
 * forwards to X11 clients, and Chromium's single seat is the seat being driven.
 * The agent's drawn cursor stands in for KWin's own while a session runs, so
 * the pointer looks the same here as on every other backend.
 */
class SynaraVirtualInputDevice : public InputDevice
{
public:
    explicit SynaraVirtualInputDevice(QObject *parent = nullptr)
        : InputDevice(parent)
    {
    }

    QString name() const override
    {
        return QStringLiteral("Synara Agent Input");
    }
    bool isEnabled() const override
    {
        return true;
    }
    void setEnabled(bool) override
    {
    }
    bool isKeyboard() const override
    {
        return true;
    }
    bool isPointer() const override
    {
        return true;
    }
    bool isTouchpad() const override
    {
        return false;
    }
    bool isTouch() const override
    {
        return false;
    }
    bool isTabletTool() const override
    {
        return false;
    }
    bool isTabletPad() const override
    {
        return false;
    }
    bool isTabletModeSwitch() const override
    {
        return false;
    }
    bool isLidSwitch() const override
    {
        return false;
    }

    void sendMotionAbsolute(const QPointF &pos)
    {
        Q_EMIT pointerMotionAbsolute(pos, timestamp(), this);
        Q_EMIT pointerFrame(this);
    }
    void sendButton(quint32 button, bool pressed)
    {
        Q_EMIT pointerButtonChanged(button,
                                    pressed ? PointerButtonState::Pressed : PointerButtonState::Released,
                                    timestamp(),
                                    this);
        Q_EMIT pointerFrame(this);
    }
    void sendKey(quint32 key, bool pressed)
    {
        Q_EMIT keyChanged(key, pressed ? KeyboardKeyState::Pressed : KeyboardKeyState::Released, timestamp(), this);
    }
    void sendAxis(PointerAxis axis, qreal delta, qint32 delta120)
    {
        // Wheel source with a value120 half, deliberately: see the delivery
        // contract above SynaraComputerUsePlugin::axis().
        Q_EMIT pointerAxisChanged(axis, delta, delta120, PointerAxisSource::Wheel, false, timestamp(), this);
        Q_EMIT pointerFrame(this);
    }

private:
    static std::chrono::microseconds timestamp()
    {
        return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch());
    }
};

/**
 * One waitForSettle in flight: the reply it owes, what it watches, and the
 * timer that wakes it when nothing else will. All times are the plugin's
 * settle clock, in nanoseconds.
 */
struct SynaraComputerUsePlugin::SettleRequest
{
    SettleRequest(const QDBusConnection &connection, const QDBusMessage &message)
        : connection(connection)
        , message(message)
    {
    }

    QDBusConnection connection;
    QDBusMessage message;
    // Null with anyWindow false means the window has gone.
    QPointer<Window> window;
    bool anyWindow = false;
    qint64 baselineNs = 0;
    qint64 startedNs = 0;
    qint64 quietNs = 0;
    qint64 deadlineNs = 0;
    // Owned by the plugin and released with deleteLater: a wait usually ends
    // inside this timer's own timeout.
    QPointer<QTimer> timer;
};

enum class PopupOwner {
    // Not a submenu: its parent is a toplevel, or not known.
    Unknown,
    Agent,
    Human,
};

// How long after the agent's press a popup can still be the agent's. Menus map
// within a frame or two; a slow page gets seconds. A late one is closed by the
// grab check rather than let through.
static constexpr qint64 s_popupAttributionMs = 5000;

/**
 * Whether a new popup is the agent's: a submenu follows its parent menu, and
 * otherwise the popup belongs to whoever pressed into its client last - the
 * agent recently enough, and more recently than the human. Ages are
 * milliseconds since that party's last press into this client, -1 for none.
 */
static bool popupOpenedByAgent(PopupOwner parent, qint64 agentPressAgeMs, qint64 humanPressAgeMs)
{
    if (parent != PopupOwner::Unknown) {
        return parent == PopupOwner::Agent;
    }
    if (agentPressAgeMs < 0 || agentPressAgeMs > s_popupAttributionMs) {
        return false;
    }
    return humanPressAgeMs < 0 || agentPressAgeMs < humanPressAgeMs;
}

struct SettleVerdict
{
    bool done = false;
    bool settled = false;
    // When to look again if nothing commits before then; meaningful while not done.
    qint64 recheckNs = 0;
};

/**
 * Whether a wait is over, from the last damaged commit of what it watches (-1
 * for none yet). Settled needs a commit strictly after the baseline and then
 * `quiet` without another; the deadline ends it unsettled. Until then the wait
 * is looked at again when the quiet period would end, or at the deadline, or
 * sooner if another commit arrives.
 */
static SettleVerdict settleVerdict(qint64 nowNs, qint64 lastCommitNs, qint64 baselineNs, qint64 quietNs, qint64 deadlineNs)
{
    const bool committed = lastCommitNs >= 0 && lastCommitNs > baselineNs;
    if (committed && nowNs - lastCommitNs >= quietNs) {
        return {true, true, 0};
    }
    if (nowNs >= deadlineNs) {
        return {true, false, 0};
    }
    return {false, false, committed ? std::min(lastCommitNs + quietNs, deadlineNs) : deadlineNs};
}

struct SynaraComputerUsePlugin::CaptureRequest
{
    CaptureRequest(const QDBusConnection &connection, const QDBusMessage &message)
        : connection(connection)
        , message(message)
    {
    }

    QDBusConnection connection;
    QDBusMessage message;
    QPointer<Window> window;
    QMetaObject::Connection windowDestroyedConnection;
    RectF region;
    uint maxDimension = 0;
    uint flags = 0;
    bool windowCapture = false;
    // captureWindowEx or captureRegionEx: the reply carries the MIME type.
    bool extended = false;
    std::atomic_bool renderStarted = false;
    std::atomic_bool finished = false;
};

/**
 * Renders the part of one output a capture covers, at @p scale, into a target
 * of exactly @p size - its rectangle in the capture's canvas - and reads it
 * back. The scene maps the viewport onto the whole target, so an output at a
 * lower scale than the capture's is magnified by the GPU and a downscaled
 * capture is rendered small in the first place; a rotated output needs nothing,
 * since the target is untransformed and the scene is laid out logically.
 */
static bool renderCapturePart(WorkspaceScene *scene,
                              EglContext *context,
                              CaptureTargetPool &targets,
                              LogicalOutput *output,
                              const RectF &viewport,
                              qreal scale,
                              const QSize &size,
                              Window *selectedWindow,
                              bool windowCapture,
                              bool sceneCursorIsAgents,
                              QImage *image,
                              QString *error)
{
    BackendOutput *backendOutput = output ? output->backendOutput() : nullptr;
    if (!scene || !context || !output || !backendOutput) {
        *error = QStringLiteral("render unavailable");
        return false;
    }
    if (!size.isValid() || size.isEmpty()) {
        *error = QStringLiteral("capture dimensions are invalid");
        return false;
    }

    GLFramebuffer *framebuffer = targets.acquire(context, size, error);
    if (!framebuffer) {
        return false;
    }

    CaptureLayer layer(backendOutput, framebuffer);
    if (!layer.preparePresentationTest()) {
        *error = QStringLiteral("render unavailable");
        return false;
    }
    const std::optional<OutputLayerBeginFrameInfo> frame = layer.beginFrame();
    if (!frame) {
        *error = QStringLiteral("render unavailable");
        return false;
    }

    SceneView view(scene, output, backendOutput, &layer);
    view.setViewport(viewport);
    view.setScale(scale);
    view.addWindowFilter([selectedWindow, windowCapture](Window *window) {
        if (!window || window->excludeFromCapture()) {
            return true;
        }
        return windowCapture && window != selectedWindow;
    });

    // A fresh SceneView has no exclusive views, so paint() covers the whole
    // overlay tree — the compositor's cursor and the agent's ghost cursor
    // included. That is the only way a cursor reaches this capture at all:
    // ItemTreeView::setExclusive(true) *removes* an item from the parent view's
    // rendering (each exclusive view is a layer the compositor presents
    // separately, and nothing presents one here). The output's own cursor layer
    // registers its exclusivity with the output's SceneView, not this one, so a
    // cursor shown on a native layer on screen still paints into the capture.
    // The one cursor that must not leak in is the human's: on the shared-desktop
    // backend the scene cursor is theirs, so it is claimed by an exclusive view
    // that is deliberately never painted. An agent-owned compositor needs no
    // exclusion: its native cursor is hidden while a session runs, and the ghost
    // item stands in for it.
    std::unique_ptr<ItemTreeView> humanCursorExclusion;
    if (!sceneCursorIsAgents) {
        if (Item *cursorItem = scene->cursorItem()) {
            humanCursorExclusion = std::make_unique<ItemTreeView>(&view, cursorItem, output, backendOutput, &layer);
            humanCursorExclusion->setExclusive(true);
        }
    }

    view.prePaint();
    view.paint(frame->renderTarget, QPoint(), Region(0, 0, size.width(), size.height()));
    view.postPaint();
    if (!layer.endFrame(Region(), Region(), nullptr)) {
        *error = QStringLiteral("offscreen frame submission failed");
        return false;
    }

    QImage readback(size, QImage::Format_RGBA8888_Premultiplied);
    if (readback.isNull()) {
        *error = QStringLiteral("capture readback allocation failed");
        return false;
    }
    GLFramebuffer::pushFramebuffer(framebuffer);
    context->glReadnPixels(0,
                           0,
                           size.width(),
                           size.height(),
                           GL_RGBA,
                           GL_UNSIGNED_BYTE,
                           static_cast<GLsizei>(readback.sizeInBytes()),
                           readback.bits());
    GLFramebuffer::popFramebuffer();
    *image = std::move(readback);
    return true;
}

// The arrow silhouette, tip first, in fractions of the cursor size. Proportions
// follow a stock theme arrow so the ghost still reads as a pointer, and the tip
// sits on the origin so the hotspot is exactly the point that gets clicked.
static const QPointF s_agentCursorOutline[] = {
    {0.00, 0.00},
    {0.00, 0.76},
    {0.19, 0.58},
    {0.30, 0.88},
    {0.44, 0.82},
    {0.32, 0.54},
    {0.56, 0.54},
};

static qreal agentInkStrokeWidth(qreal size)
{
    return std::max(s_agentMinInkStrokeWidth, size * s_agentInkStrokeRatio);
}

static qreal agentRimStrokeWidth(qreal size)
{
    return std::max(s_agentMinRimStrokeWidth, size * s_agentRimStrokeRatio);
}

/**
 * Transparent room for the strokes, which extend outward past the silhouette on
 * every side including the tip. In logical pixels, and therefore also the offset
 * from the drawn image's corner to the hotspot.
 */
static qreal agentStrokeMargin(qreal size)
{
    return agentInkStrokeWidth(size) / 2 + 1;
}

static qreal agentGlowRadius(qreal size)
{
    return std::max(s_agentMinGlowRadius, size * s_agentGlowRadiusRatio);
}

/** The cursor image's margin: the halo reaches further out than any stroke. */
static qreal agentCursorMargin(qreal size)
{
    return std::max(agentStrokeMargin(size), agentGlowRadius(size) + 1);
}

static QPainterPath agentCursorPath(qreal size)
{
    QPainterPath path;
    path.moveTo(s_agentCursorOutline[0] * size);
    for (size_t i = 1; i < std::size(s_agentCursorOutline); ++i) {
        path.lineTo(s_agentCursorOutline[i] * size);
    }
    path.closeSubpath();
    return path;
}

static QImage renderAgentImage(const QSizeF &logicalSize, qreal devicePixelRatio, const std::function<void(QPainter &)> &paint)
{
    const QSize deviceSize(int(std::ceil(logicalSize.width() * devicePixelRatio)),
                           int(std::ceil(logicalSize.height() * devicePixelRatio)));
    QImage image(deviceSize, QImage::Format_ARGB32_Premultiplied);
    if (image.isNull()) {
        return image;
    }
    image.fill(Qt::transparent);
    {
        QPainter painter(&image);
        painter.setRenderHint(QPainter::Antialiasing, true);
        painter.setRenderHint(QPainter::TextAntialiasing, true);
        // Scaled here rather than by letting QPainter pick the ratio up from the
        // image, so the device pixel ratio is only ever applied once.
        painter.scale(devicePixelRatio, devicePixelRatio);
        paint(painter);
    }
    image.setDevicePixelRatio(devicePixelRatio);
    return image;
}

static QImage renderAgentCursorImage(qreal size, qreal devicePixelRatio)
{
    const QPainterPath path = agentCursorPath(size);
    const QRectF bounds = path.boundingRect();
    const qreal margin = agentCursorMargin(size);
    const QSizeF logicalSize(bounds.right() + 2 * margin, bounds.bottom() + 2 * margin);
    return renderAgentImage(logicalSize, devicePixelRatio, [&path, size, margin](QPainter &painter) {
        painter.translate(margin, margin);
        // The halo, widest and faintest pass first. Stroking the silhouette at
        // shrinking widths and rising alpha layers into a soft radial falloff
        // without a blur pass, which these CPU-rendered images have no
        // pipeline for.
        const qreal glowRadius = agentGlowRadius(size);
        painter.setBrush(Qt::NoBrush);
        for (int pass = s_agentGlowPasses; pass >= 1; --pass) {
            QColor glow = s_agentAccentColor;
            glow.setAlphaF(s_agentGlowPassAlpha * (s_agentGlowPasses - pass + 1) / s_agentGlowPasses);
            QPen pen(glow, glowRadius * 2 * pass / s_agentGlowPasses);
            pen.setJoinStyle(Qt::RoundJoin);
            painter.setPen(pen);
            painter.drawPath(path);
        }
        // A core under the glyph, so antialiased edges blend into the halo's
        // colour rather than into whatever is behind the cursor.
        painter.setPen(Qt::NoPen);
        painter.setBrush(s_agentAccentColor);
        painter.drawPath(path);
        // The glyph itself: an ordinary pointer, white body over dark ink, the
        // same silhouette as a stock theme arrow. The halo is what says this
        // one is the agent's.
        painter.setBrush(Qt::NoBrush);
        QPen pen(s_agentInkColor, agentInkStrokeWidth(size));
        pen.setJoinStyle(Qt::RoundJoin);
        painter.setPen(pen);
        painter.drawPath(path);
        painter.setPen(Qt::NoPen);
        painter.setBrush(s_agentRimColor);
        painter.drawPath(path);
    });
}

static QFont agentBadgeFont(qreal size)
{
    QFont font;
    font.setPixelSize(std::max(s_agentBadgeMinTextPixels, int(std::lround(size * 0.5))));
    font.setWeight(QFont::DemiBold);
    return font;
}

static QImage renderAgentBadgeImage(const QString &name, qreal size, qreal devicePixelRatio)
{
    const QFont font = agentBadgeFont(size);
    const QFontMetricsF metrics(font);
    const QString text = metrics.elidedText(name, Qt::ElideRight, size * s_agentBadgeMaxTextWidthRatio);
    const qreal paddingX = std::round(size * 0.30);
    const qreal paddingY = std::round(size * 0.14);
    const QSizeF body(std::ceil(metrics.horizontalAdvance(text) + 2 * paddingX),
                      std::ceil(metrics.height() + 2 * paddingY));
    const qreal margin = agentStrokeMargin(size);
    const QSizeF logicalSize(body.width() + 2 * margin, body.height() + 2 * margin);
    return renderAgentImage(logicalSize, devicePixelRatio, [&body, &font, &text, size, margin](QPainter &painter) {
        const QRectF rect(margin, margin, body.width(), body.height());
        const qreal radius = rect.height() / 2;
        painter.setBrush(Qt::NoBrush);
        painter.setPen(QPen(s_agentInkColor, agentInkStrokeWidth(size)));
        painter.drawRoundedRect(rect, radius, radius);
        painter.setPen(QPen(s_agentRimColor, agentRimStrokeWidth(size)));
        painter.setBrush(s_agentAccentColor);
        painter.drawRoundedRect(rect, radius, radius);
        painter.setPen(s_agentRimColor);
        painter.setFont(font);
        painter.drawText(rect, Qt::AlignCenter, text);
    });
}

static qreal agentCursorSize()
{
    const Cursor *cursor = Cursors::self() ? Cursors::self()->mouse() : nullptr;
    const int size = cursor ? cursor->themeSize() : 0;
    // The human's own cursor size, so the ghost is the same physical size as the
    // pointer it sits beside; only the halo and the badge tell them apart.
    return size > 0 ? qreal(size) : qreal(Cursor::defaultThemeSize());
}

SynaraAgentCursorItem::SynaraAgentCursorItem(Item *parent)
    : Item(parent)
{
    m_badgeFade.setDuration(s_agentBadgeFadeMilliseconds);
    m_badgeFade.setStartValue(1.0);
    m_badgeFade.setEndValue(0.0);
    m_badgeFade.setEasingCurve(QEasingCurve::InOutQuad);
    connect(&m_badgeFade, &QVariantAnimation::valueChanged, this, [this](const QVariant &value) {
        if (m_badgeItem) {
            m_badgeItem->setOpacity(value.toReal());
        }
    });
    connect(&m_badgeFade, &QVariantAnimation::finished, this, [this]() {
        // A fully transparent badge is still a textured quad on every frame the
        // ghost cursor moves, so it leaves the scene instead of sitting at zero.
        if (m_badgeItem) {
            m_badgeItem->setVisible(false);
        }
    });
    m_badgeHoldTimer.setSingleShot(true);
    m_badgeHoldTimer.setInterval(s_agentBadgeHoldMilliseconds);
    connect(&m_badgeHoldTimer, &QTimer::timeout, &m_badgeFade, [this]() {
        m_badgeFade.start();
    });

    refresh();

    if (Cursor *cursor = Cursors::self() ? Cursors::self()->mouse() : nullptr) {
        connect(cursor, &Cursor::themeChanged, this, &SynaraAgentCursorItem::refresh);
    }
    if (Workspace *workspace = Workspace::self()) {
        connect(workspace, &Workspace::outputsChanged, this, &SynaraAgentCursorItem::refresh);
    }
}

void SynaraAgentCursorItem::setAgentName(const QString &name)
{
    const QString trimmed = name.trimmed();
    if (m_agentName == trimmed) {
        return;
    }
    m_agentName = trimmed;
    refresh();
}

void SynaraAgentCursorItem::setHotspot(const QPointF &position)
{
    setPosition(position);
    if (std::abs(targetDevicePixelRatio() - m_devicePixelRatio) > 0.001) {
        refresh();
    }
}

void SynaraAgentCursorItem::noteActivity()
{
    if (!m_badgeItem) {
        return;
    }
    m_badgeFade.stop();
    m_badgeItem->setOpacity(1);
    m_badgeItem->setVisible(true);
    m_badgeHoldTimer.start();
}

qreal SynaraAgentCursorItem::targetDevicePixelRatio() const
{
    if (Workspace *workspace = Workspace::self()) {
        if (LogicalOutput *output = workspace->outputAt(position())) {
            return output->scale();
        }
    }
    return 1;
}

void SynaraAgentCursorItem::refresh()
{
    m_cursorSize = agentCursorSize();
    m_devicePixelRatio = targetDevicePixelRatio();

    // KWin 6.7 removed ItemRenderer::createImageItem(); ImageItem now has a
    // public constructor. This mirrors KWin's own CursorItem::refresh().
    const QImage cursor = renderAgentCursorImage(m_cursorSize, m_devicePixelRatio);
    if (!m_imageItem) {
        m_imageItem = std::make_unique<ImageItem>(this);
    }
    // The arrow image carries the halo's margin, the badge only its strokes';
    // each offset compensates for its own image's padding so the hotspot and
    // the badge anchor stay exactly where they were.
    const qreal cursorMargin = agentCursorMargin(m_cursorSize);
    m_imageItem->setImage(cursor);
    m_imageItem->setPosition(QPointF(-cursorMargin, -cursorMargin));
    m_imageItem->setSize(cursor.deviceIndependentSize());

    const QImage badge = renderAgentBadgeImage(m_agentName.isEmpty() ? s_agentFallbackName : m_agentName,
                                               m_cursorSize,
                                               m_devicePixelRatio);
    if (!m_badgeItem) {
        m_badgeItem = std::make_unique<ImageItem>(this);
        m_badgeItem->setVisible(false);
    }
    const qreal badgeMargin = agentStrokeMargin(m_cursorSize);
    m_badgeItem->setImage(badge);
    // Below and right of the hotspot, clear of the arrow, so the badge never
    // covers the pixel the agent is about to click.
    m_badgeItem->setPosition(QPointF(std::round(m_cursorSize * 0.55) - badgeMargin,
                                     std::round(m_cursorSize * 0.90) - badgeMargin));
    m_badgeItem->setSize(badge.deviceIndependentSize());
}

static bool serialInBurst(quint32 serial, const SynaraSerialBurst &burst)
{
    return quint32(serial - burst.after - 1) < quint32(burst.last - burst.after);
}

// KWin's answer to a token it will not grant (XdgActivationV1Integration).
static const QString s_notGrantedToken = QStringLiteral("not-granted-666");
// Set on KWin's XdgActivationV1Interface to the instance whose creator is
// installed, so an older instance unloading after a newer one loaded leaves
// the newer one's in place.
static constexpr const char *s_activationOwnerProperty = "synaraActivationTokenCreator";

// KWin's own test (xdgactivationv1.cpp): Plasma's shell and lock screen may
// hand out tokens without a serial of their own.
static bool isPrivilegedInWindowManagement(const ClientConnection *client)
{
    const QStringList requestedInterfaces = client->property("requestedInterfaces").toStringList();
    return requestedInterfaces.contains(QLatin1StringView("org_kde_plasma_window_management"))
        || requestedInterfaces.contains(QLatin1StringView("kde_lockscreen_overlay_v1"));
}

/**
 * Whether a token is granted: never for a serial of the agent's, otherwise
 * exactly KWin 6.7.4's rule - any request from a privileged client or from the
 * active window (or while nothing is active), else a serial no older than the
 * human's last interaction and not from the future.
 */
static bool activationTokenGranted(bool agentSerial, bool privileged, bool fromActiveWindow, UInt32Serial lastInteraction, UInt32Serial serial, UInt32Serial displaySerial)
{
    if (agentSerial) {
        return false;
    }
    if (privileged || fromActiveWindow) {
        return true;
    }
    return lastInteraction <= serial && displaySerial >= serial;
}

/**
 * One borrow of a client's seat0 objects by direct injection.
 *
 * Every public entry point and every internal path that can send a direct
 * enter opens one, and the outermost closing hands the objects back to the
 * human (restoreHumanDelivery). Nesting is routine - stopSession inside
 * authenticate, clearPointerDelivery inside updatePointerFocus - and only the
 * outermost restores, so an object is never handed back halfway through a
 * burst.
 */
class SynaraComputerUsePlugin::DirectInjectionScope
{
public:
    explicit DirectInjectionScope(SynaraComputerUsePlugin *plugin)
        : m_plugin(plugin)
    {
        if (m_plugin->m_directInjectionDepth++ == 0) {
            m_plugin->m_burstStartSerial = m_plugin->displaySerial();
        }
    }
    ~DirectInjectionScope()
    {
        if (--m_plugin->m_directInjectionDepth == 0) {
            m_plugin->restoreHumanDelivery();
            m_plugin->noteAgentBurst(m_plugin->m_burstStartSerial, m_plugin->displaySerial());
        }
    }
    Q_DISABLE_COPY_MOVE(DirectInjectionScope)

private:
    SynaraComputerUsePlugin *const m_plugin;
};

SynaraComputerUsePlugin::SynaraComputerUsePlugin()
    : Plugin()
    , m_idleTimeoutMs(s_defaultIdleTimeoutMs)
    , m_humanActiveGuardMs(s_defaultHumanActiveGuardMs)
    , m_pos(Cursors::self()->mouse()->pos())
    , m_ownsCompositor(readOwnsCompositor())
    , m_captureTargets(std::make_unique<CaptureTargetPool>())
{
    m_auth.onRevoked = [this] {
        stopSession(StopReason::Request);
    };

    m_lastActivity.start();
    m_idleTimer.setSingleShot(true);
    m_idleTimer.setTimerType(Qt::CoarseTimer);
    connect(&m_idleTimer, &QTimer::timeout, this, [this]() {
        stopSession(StopReason::IdleTimeout);
    });
    registerReleaseShortcut();

    m_captureRenderWatchdog.setSingleShot(true);
    connect(&m_captureRenderWatchdog, &QTimer::timeout, this, [this]() {
        if (m_captureRequest) {
            failCapture(m_captureRequest, QStringLiteral("capture render timeout"));
        }
    });
    // Render targets are kept while captures keep coming (a preview polls
    // every half second) and freed once they stop.
    m_captureTargetIdle.setSingleShot(true);
    m_captureTargetIdle.setInterval(s_captureTargetIdleMs);
    connect(&m_captureTargetIdle, &QTimer::timeout, this, &SynaraComputerUsePlugin::releaseCaptureTargets);
    // The targets are objects of the compositor's GL context, and a
    // compositing restart (a GPU reset, a driver change) replaces that
    // context. Both signals come while the old one is still alive - before
    // the effects handler and the renderer go - so the targets are deleted in
    // it rather than abandoned; the pool's own context check stays as the
    // backstop for a replacement nothing announced.
    if (Compositor *compositor = Compositor::self()) {
        connect(compositor, &Compositor::aboutToToggleCompositing, this, &SynaraComputerUsePlugin::releaseCaptureTargets);
        connect(compositor, &Compositor::aboutToDestroy, this, &SynaraComputerUsePlugin::releaseCaptureTargets);
    }
    m_captureEncodeWatchdog.setSingleShot(true);
    connect(&m_captureEncodeWatchdog, &QTimer::timeout, this, [this]() {
        if (m_captureRequest) {
            failCapture(m_captureRequest, QStringLiteral("capture encode timeout"));
        }
    });

    if (m_ownsCompositor) {
        ensureInputDevice();
    } else {
        ensureSeat();
        // Only on the human's own compositor. In a compositor the agent owns,
        // the agent's own virtual device feeds this very pipeline, so the spy
        // would report the agent as the human and the guard would deadlock it.
        if (input()) {
            m_humanInputSpy = std::make_unique<SynaraHumanInputSpy>();
            m_humanInputSpy->onPointerInput = [this] {
                handleHumanPointerInput();
            };
            m_humanInputSpy->onKeyboardInput = [this] {
                handleHumanKeyboardInput();
            };
            m_humanInputSpy->onPointerPress = [this](const QPointF &position, bool byPointerFocus) {
                handleHumanPointerPress(position, byPointerFocus);
            };
            m_humanInputSpy->onKeyPress = [this] {
                handleHumanKeyPress();
            };
            input()->installInputEventSpy(m_humanInputSpy.get());
        }
        watchHumanSeat();
        watchPopups();
        installActivationTokenCreator();
    }
    ensureCursorItem();
    setCursorVisible(false);
    watchSessionState();

    m_settleClock.start();
    if (Workspace *workspace = Workspace::self()) {
        for (Window *window : workspace->windows()) {
            trackWindowDamage(window);
        }
        connect(workspace, &Workspace::windowAdded, this, &SynaraComputerUsePlugin::trackWindowDamage);
    }

    if (effects) {
        for (LogicalOutput *output : effects->screens()) {
            watchRenderLoop(output);
        }
        connect(effects, &EffectsHandler::screenAdded, this, [this](LogicalOutput *output) {
            watchRenderLoop(output);
        });
    }

    // Both the bus name and the object path can be held by an older build that
    // is still loaded (the versioned reload dance in the README). They fail
    // differently: every instance shares KWin's one connection, so the name
    // request succeeds for a second instance in the same process while the
    // object path stays taken until the older instance's destructor releases
    // it - just before that destructor drops the name. The name going
    // unowned is therefore the moment to take both, and until then healthJson
    // (answered by whichever instance holds the path) says which is missing.
    // Before the object is exported: QtDBus builds the introspection and the
    // argument demarshalling for keys() from these registrations.
    qDBusRegisterMetaType<SynaraKeyStroke>();
    qDBusRegisterMetaType<QList<SynaraKeyStroke>>();

    m_serviceWatcher.setConnection(QDBusConnection::sessionBus());
    m_serviceWatcher.setWatchMode(QDBusServiceWatcher::WatchForUnregistration);
    m_serviceWatcher.addWatchedService(s_service);
    connect(&m_serviceWatcher, &QDBusServiceWatcher::serviceUnregistered, this, &SynaraComputerUsePlugin::handleServiceUnregistered);
    registerOnBus();
}

SynaraComputerUsePlugin::~SynaraComputerUsePlugin()
{
    m_idleTimer.stop();
    // The compositor outlives the plugin, so the hide owed on its cursor must
    // not: a mid-session unload would otherwise leave the desktop cursorless.
    setNativeCursorHidden(false);
    // Before this code can go away with the library.
    restoreActivationTokenCreator();
    // Before anything else touches input: ~InputEventSpy uninstalls itself from
    // InputRedirection, and that has to happen while InputRedirection is still
    // the one this was installed into.
    m_humanInputSpy.reset();
    // An encode in flight is not waited for: the request is answered now, and
    // the worker's late result finds no receiver (see encodePool).
    if (m_captureRequest) {
        failCapture(m_captureRequest, QStringLiteral("capture canceled: plugin destroyed"));
    }
    finishAllSettleRequests();
    releaseCaptureTargets();
    releasePressedState();
    detachInputDevice();
    // Both paths, because a session can end with either outstanding and a client
    // left holding an enter keeps drawing hover and believing it has focus.
    directPointerLeave();
    directKeyboardLeave();
    if (m_seat) {
        m_seat->notifyPointerLeave();
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
    clearWindowActivation();
    if (m_xkbState) {
        xkb_state_unref(m_xkbState);
        m_xkbState = nullptr;
    }
    // Only what this instance holds: unregistering the path while an older
    // instance exports it would pull that instance's object off the bus.
    if (m_objectRegistered) {
        QDBusConnection::sessionBus().unregisterObject(s_path);
    }
    if (m_serviceRegistered) {
        QDBusConnection::sessionBus().unregisterService(s_service);
    }
}

/**
 * Exports the object and takes the bus name, whichever of the two this
 * instance does not hold yet. The object first: a name that resolves to a
 * process with nothing at the path answers UnknownObject to every call, which
 * the server would read as a broken plugin rather than a reload in progress.
 */
void SynaraComputerUsePlugin::registerOnBus()
{
    QDBusConnection bus = QDBusConnection::sessionBus();
    if (!m_objectRegistered) {
        m_objectRegistered = bus.registerObject(s_path,
                                                s_interface,
                                                this,
                                                QDBusConnection::ExportAllInvokables | QDBusConnection::ExportScriptableSignals);
    }
    if (!m_serviceRegistered) {
        m_serviceRegistered = bus.registerService(s_service);
    }
}

/**
 * The name lost its owner. Whether that was an older instance in this process
 * letting go (its object path is free now too) or the name was ours and was
 * dropped for us, nothing is held any more, so both are taken again.
 */
void SynaraComputerUsePlugin::handleServiceUnregistered()
{
    m_serviceRegistered = false;
    registerOnBus();
}

QString SynaraComputerUsePlugin::toJson(const QJsonObject &object)
{
    return QString::fromUtf8(QJsonDocument(object).toJson(QJsonDocument::Compact));
}

QString SynaraComputerUsePlugin::toJson(const QJsonArray &array)
{
    return QString::fromUtf8(QJsonDocument(array).toJson(QJsonDocument::Compact));
}

QString SynaraComputerUsePlugin::authenticate(const QString &token)
{
    const QString instance = m_auth.authenticate(*this, token);
    if (!instance.isEmpty()) {
        stopSession(StopReason::Request);
    }
    return instance;
}

QString SynaraComputerUsePlugin::healthJson() const
{
    // Public diagnostics contain no captured pixels, window titles, or input API.
    QJsonObject health{
        {QStringLiteral("ok"), inputReady()},
        {QStringLiteral("running"), m_running},
        {QStringLiteral("service"), s_service},
        {QStringLiteral("path"), s_path},
        {QStringLiteral("interface"), s_interface},
        {QStringLiteral("build"), s_build},
        {QStringLiteral("gitHash"), s_gitHash},
        {QStringLiteral("buildTimestamp"), s_buildTimestamp},
        {QStringLiteral("kwinVersion"), s_kwinVersion},
        {QStringLiteral("seat"), m_ownsCompositor ? QStringLiteral("seat0") : s_agentSeatName},
        {QStringLiteral("dedicatedSeat"), !m_ownsCompositor},
        // The agent owns this compositor, so it drives the only seat in it and
        // reaches every client, Chromium and Xwayland included.
        {QStringLiteral("ownsCompositor"), m_ownsCompositor},
        // Clients that skipped the agent seat are driven through their own seat0
        // resources instead of being refused, so reach is every window.
        {QStringLiteral("directInjection"), !m_ownsCompositor},
        {QStringLiteral("overlay"), bool(m_cursorItem)},
        {QStringLiteral("workspace"), Workspace::self() != nullptr},
        // Read from inside the compositor because that is the only place it is
        // known: KWin picks the display number for the Xwayland it starts and
        // publishes it by setenv on itself, with nothing on the bus and nothing
        // in its output to parse. A server that wants to launch an X11 client
        // into this session needs the answer, and guessing it races every other
        // Xwayland on the machine.
        {QStringLiteral("xDisplay"), qEnvironmentVariable("DISPLAY")},
        // The interface generation and the optional methods this build
        // implements. A server uses a feature only when it is listed here and
        // falls back to the version 1 methods otherwise, so an older plugin
        // keeps working with a newer server.
        {QStringLiteral("interfaceVersion"), s_interfaceVersion},
        {QStringLiteral("features"), QJsonArray::fromStringList(s_interfaceFeatures)},
        {QStringLiteral("effects"), effects != nullptr},
        {QStringLiteral("capture"), effects && effects->isOpenGLCompositing() && effects->openglContext()},
        {QStringLiteral("idleTimeoutMs"), double(m_idleTimeoutMs)},
        {QStringLiteral("releasedByUser"), m_releasedByUser},
        // The shortcut that actually fires, or null when none could be
        // registered: the server treats null as a setup blocker, because a
        // session with no panic switch is not one to start.
        {QStringLiteral("releaseShortcut"), releaseShortcutJson()},
        {QStringLiteral("releaseShortcutRegistered"), m_releaseShortcutRegistered},
        // Whether this instance holds the org.synara.ComputerUse bus name and
        // exports /org/synara/ComputerUse. Either can be false while an older
        // build still holds it; both are re-tried when that owner goes. A
        // caller reaching this method through the path reads the answer of
        // whichever instance exports it.
        {QStringLiteral("serviceRegistered"), m_serviceRegistered},
        {QStringLiteral("objectRegistered"), m_objectRegistered},
        // Screen locked or session inactive: every capture and input method is
        // refused with SessionLocked until this clears.
        {QStringLiteral("locked"), sessionLocked()},
    };
    if (Workspace::self()) {
        health.insert(QStringLiteral("workspaceGeometry"),
                     rectToJson(RectF(Workspace::self()->geometry())));
    }
    // The cookie file of the Xwayland this compositor started, which KWin
    // publishes the same way as the display: setenv on itself once Xwayland is
    // up. An X11 client launched into a nested session needs it, and the one
    // in the server's own environment is the human's. Absent without Xwayland.
    const QString xAuthority = qEnvironmentVariable("XAUTHORITY");
    if (!xAuthority.isEmpty()) {
        health.insert(QStringLiteral("xAuthority"), xAuthority);
    }
    return toJson(health);
}

QString SynaraComputerUsePlugin::stateJson() const
{
    if (!m_auth.permits(*this)) return {};
    // Locked means off limits to read as well: this names the window the human
    // has focused, where their pointer rests and how recently they typed.
    if (refuseIfSessionLocked()) return {};
    QJsonObject state{
        {QStringLiteral("running"), m_running},
        {QStringLiteral("seat"), m_ownsCompositor ? QStringLiteral("seat0") : s_agentSeatName},
        {QStringLiteral("dedicatedSeat"), !m_ownsCompositor},
        // The agent owns this compositor, so it drives the only seat in it and
        // reaches every client, Chromium and Xwayland included.
        {QStringLiteral("ownsCompositor"), m_ownsCompositor},
        // Clients that skipped the agent seat are driven through their own seat0
        // resources instead of being refused, so reach is every window.
        {QStringLiteral("directInjection"), !m_ownsCompositor},
        {QStringLiteral("position"), pointToJson(m_pos)},
        // The human's own cursor, reported next to the agent's because the one
        // property this whole design rests on is that these two move
        // independently. Anything that makes them track each other is a bug, and
        // this is how it gets caught rather than argued about.
        {QStringLiteral("humanPosition"),
         pointToJson(input() && input()->pointer() ? input()->pointer()->pos() : QPointF())},
        {QStringLiteral("agentName"), m_agentName.isEmpty() ? s_agentFallbackName : m_agentName},
        {QStringLiteral("pressedButtonCount"), m_pressedButtons.size()},
        {QStringLiteral("pressedKeyCount"), m_pressedKeys.size()},
        // Whether CapsLock is latched on the keyboard the next key goes out on.
        // The server's QWERTY synthesis is Shift-only, so a latched CapsLock
        // would turn "Hello" into "hELLO"; reporting it lets the backend invert
        // its Shift decisions for letters. On the agent seat this is the agent's
        // own xkb state; on the direct path the client's seat0 keyboard carries
        // the human's lock state merged in (directKeyboardModifiers), so theirs
        // counts too. Absent on builds older than this field.
        {QStringLiteral("capsLockOn"), effectiveCapsLockOn()},
        {QStringLiteral("humanCapsLockOn"), humanCapsLockOn()},
        // The xkb layout the agent's keys are interpreted with ("us", "de"),
        // which the server checks before synthesising text through its
        // US-QWERTY table; see keyboardLayout(). The descriptive name is for
        // messages.
        {QStringLiteral("keyboardLayout"), keyboardLayout()},
        {QStringLiteral("keyboardLayoutName"), keyboardLayoutName()},
        {QStringLiteral("idleTimeoutMs"), double(m_idleTimeoutMs)},
        {QStringLiteral("idleMs"), double(idleMilliseconds())},
        {QStringLiteral("releasedByUser"), m_releasedByUser},
        {QStringLiteral("releaseShortcut"), releaseShortcutJson()},
        {QStringLiteral("locked"), sessionLocked()},
    };
    if (m_running && m_idleTimeoutMs > 0) {
        state.insert(QStringLiteral("idleRemainingMs"),
                     double(std::max<qint64>(0, qint64(m_idleTimeoutMs) - idleMilliseconds())));
    }
    if (!m_stopReason.isEmpty()) {
        state.insert(QStringLiteral("stopReason"), m_stopReason);
    }
    if (m_pointerWindow) {
        state.insert(QStringLiteral("pointerWindowId"), m_pointerWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("pointerWindowTitle"), m_pointerWindow->caption());
        // Whether seat0's pointer is somewhere in this window's client, which is
        // when the direct path borrows and hands back the client's pointer per
        // call instead of keeping its enter; see restoreHumanDelivery.
        state.insert(QStringLiteral("pointerClientShared"),
                     m_pointerDirect && humanPointerSurfaceInClientOf(m_pointerWindow->surface()) != nullptr);
    }
    if (m_keyboardWindow) {
        state.insert(QStringLiteral("keyboardWindowId"), m_keyboardWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("keyboardWindowTitle"), m_keyboardWindow->caption());
        state.insert(QStringLiteral("keyboardWindowActive"), m_keyboardWindow->isActive());
        state.insert(QStringLiteral("keyboardClientShared"),
                     m_keyboardDirect && humanKeyboardSurfaceInClientOf(m_keyboardWindow->surface()) != nullptr);
    }
    // True while the agent, rather than the compositor, is the reason the focused
    // window reports itself active to its client.
    state.insert(QStringLiteral("borrowedActivation"), !m_activatedWindow.isNull());
    // Popups the agent opened, held without a grab (see watchPopups), and how
    // many of the agent's popups have been closed on its behalf so far.
    state.insert(QStringLiteral("agentPopupCount"), int(std::count_if(m_agentPopups.cbegin(), m_agentPopups.cend(), [](const QPointer<Window> &popup) {
                     return popup && !popup->isDeleted();
                 })));
    state.insert(QStringLiteral("agentPopupsDismissed"), double(m_popupsDismissed));
    state.insert(QStringLiteral("activationTokensRefused"), double(m_activationTokensRefused));
    // The human-active guard, laid out so a server or a diagnosing human can see
    // each half of the rule separately: which window is theirs, and how long ago
    // they last touched anything. `msSinceHumanInput` is -1 when no real device
    // event has been observed yet, which is not the same as "a long time ago".
    const Window *human = humanFocusWindow();
    state.insert(QStringLiteral("humanFocusWindowId"),
                 human ? human->internalId().toString(QUuid::WithoutBraces) : QString());
    state.insert(QStringLiteral("msSinceHumanInput"), double(humanInputAgeMilliseconds()));
    state.insert(QStringLiteral("msSinceHumanPointerInput"), double(humanPointerAgeMilliseconds()));
    state.insert(QStringLiteral("msSinceHumanKeyboardInput"), double(humanKeyboardAgeMilliseconds()));
    state.insert(QStringLiteral("humanActiveGuardMs"), double(m_humanActiveGuardMs));
    if (m_targetRequested && !usableWindow(m_targetWindow)) {
        state.insert(QStringLiteral("targetLost"), true);
    }
    if (m_targetWindow) {
        state.insert(QStringLiteral("targetWindowId"), m_targetWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("targetWindowTitle"), m_targetWindow->caption());
    }
    return toJson(state);
}

QString SynaraComputerUsePlugin::windowsJson() const
{
    if (!m_auth.permits(*this)) return {};
    // Window titles are the desktop's contents in words; locked hides them too.
    if (refuseIfSessionLocked()) return {};
    return toJson(windowsArray());
}

QString SynaraComputerUsePlugin::windowsStateJson() const
{
    if (!m_auth.permits(*this)) return {};
    const bool locked = sessionLocked();
    QJsonObject state{
        // Locked hides the windows and the target exactly as windowsJson and
        // stateJson refuse them; the geometry is public in healthJson anyway.
        {QStringLiteral("windows"), locked ? QJsonArray() : windowsArray()},
        {QStringLiteral("targetWindowId"),
         !locked && m_targetWindow ? QJsonValue(m_targetWindow->internalId().toString(QUuid::WithoutBraces)) : QJsonValue()},
        {QStringLiteral("locked"), locked},
    };
    if (Workspace::self()) {
        state.insert(QStringLiteral("workspace"), rectToJson(RectF(Workspace::self()->geometry())));
        // Each monitor's rect, so the server can photograph the one the agent
        // is working on instead of every screen squeezed into one image.
        QJsonArray outputs;
        for (LogicalOutput *output : Workspace::self()->outputs()) {
            outputs.append(rectToJson(output->geometryF()));
        }
        state.insert(QStringLiteral("outputs"), outputs);
    }
    return toJson(state);
}

QJsonArray SynaraComputerUsePlugin::windowsArray() const
{
    QJsonArray windows;
    if (!Workspace::self()) {
        return windows;
    }

    // Emitted topmost-first so `stackingIndex` reads as depth, and so each
    // window's occluders are exactly the windows already emitted. A coordinate
    // click lands on whatever is topmost at that point, so the agent cannot
    // choose a target safely without knowing what covers it.
    struct StackedWindow
    {
        QString id;
        RectF bounds;
    };
    QList<StackedWindow> covering;

    const QList<Window *> stacking = Workspace::self()->stackingOrder();
    int stackingIndex = 0;
    for (auto it = stacking.crbegin(); it != stacking.crend(); ++it) {
        Window *window = *it;
        if (!window || window->isDeleted() || !window->isClient()) {
            continue;
        }

        const QString id = window->internalId().toString(QUuid::WithoutBraces);
        const RectF bounds = window->frameGeometry();
        const bool visible = usableWindow(window);

        // Frame-rect overlap, not true pixel occlusion: a window above may be
        // translucent or shaped. Overstating the risk is the safe direction,
        // because the remedy is scoping the click to a window either way.
        QJsonArray occludedBy;
        for (const StackedWindow &above : std::as_const(covering)) {
            if (above.bounds.intersects(bounds)) {
                occludedBy.append(above.id);
            }
        }

        QJsonObject object{
            {QStringLiteral("id"), id},
            {QStringLiteral("title"), window->caption()},
            {QStringLiteral("appId"), window->desktopFileName().isEmpty() ? window->resourceClass() : window->desktopFileName()},
            {QStringLiteral("resourceClass"), window->resourceClass()},
            {QStringLiteral("pid"), int(window->pid())},
            {QStringLiteral("bounds"), rectToJson(bounds)},
            {QStringLiteral("visible"), visible},
            {QStringLiteral("focusable"), window->wantsInput()},
            {QStringLiteral("normal"), window->isNormalWindow()},
            {QStringLiteral("desktop"), window->isDesktop()},
            {QStringLiteral("dock"), window->isDock()},
            {QStringLiteral("minimized"), window->isMinimized()},
            // Toolkits gate shortcut dispatch on this, not on keyboard focus, so
            // the agent has to be able to see it before blaming a lost hotkey on
            // the input path.
            {QStringLiteral("active"), window->isActive()},
            {QStringLiteral("stackingIndex"), stackingIndex},
            {QStringLiteral("occludedBy"), occludedBy},
        };
        windows.append(object);
        stackingIndex += 1;
        if (visible) {
            covering.append({id, bounds});
        }
    }
    return windows;
}

bool SynaraComputerUsePlugin::start()
{
    if (!m_auth.permits(*this)) return false;
    if (m_releasedByUser) {
        if (calledFromDBus()) {
            sendErrorReply(s_releasedErrorName,
                           QStringLiteral("computer control was released with %1")
                               .arg(releaseShortcutText()));
        }
        return false;
    }
    // A session must not begin behind the lock screen: the ghost cursor would
    // be drawn over it, and the first action would be refused anyway.
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (m_ownsCompositor) {
        ensureInputDevice();
    } else {
        ensureSeat();
    }
    if (!inputReady()) {
        return false;
    }
    DirectInjectionScope scope(this);
    m_running = true;
    m_stopReason.clear();
    attachInputDevice();
    setCursorVisible(true);
    movePointer(m_pos.x(), m_pos.y());
    noteActivity();
    return true;
}

bool SynaraComputerUsePlugin::stop()
{
    if (!m_auth.permits(*this)) return false;
    stopSession(StopReason::Request);
    return true;
}

bool SynaraComputerUsePlugin::setIdleTimeout(uint milliseconds)
{
    if (!m_auth.permits(*this)) return false;
    if (milliseconds != 0 && (milliseconds < s_minIdleTimeoutMs || milliseconds > s_maxIdleTimeoutMs)) {
        return false;
    }
    m_idleTimeoutMs = milliseconds;
    armIdleTimer();
    return true;
}

/**
 * How recently seat0 must have seen the human for the agent to give way on their
 * focused window. `0` disables the guard.
 *
 * Clamped rather than trusted: a value below the floor would refuse nothing that
 * matters while still costing a focus lookup per action, and one above the
 * ceiling would lock the agent out of a window for a minute after a stray mouse
 * nudge, which is indistinguishable from the feature being broken.
 */
bool SynaraComputerUsePlugin::setHumanActiveGuardMs(uint milliseconds)
{
    if (!m_auth.permits(*this)) return false;
    if (milliseconds != 0 && (milliseconds < s_minHumanActiveGuardMs || milliseconds > s_maxHumanActiveGuardMs)) {
        return false;
    }
    m_humanActiveGuardMs = milliseconds;
    return true;
}

bool SynaraComputerUsePlugin::setAgentName(const QString &name)
{
    if (!m_auth.permits(*this)) return false;
    m_agentName = name.trimmed();
    if (m_cursorItem) {
        m_cursorItem->setAgentName(m_agentName);
        // A handover mid-session has to announce itself, so the badge comes back
        // for the new name rather than staying faded until the next action.
        if (m_running) {
            m_cursorItem->noteActivity();
        }
    }
    return true;
}

void SynaraComputerUsePlugin::stopSession(StopReason reason)
{
    DirectInjectionScope scope(this);
    m_idleTimer.stop();
    // Nothing is left to settle: every wait is answered, unsettled, as the
    // Hyprland plugin answers them. A lock has answered its own already, with
    // SessionLocked (handleSessionStateChanged).
    finishAllSettleRequests();
    if (m_captureRequest) {
        if (reason == StopReason::SessionLocked) {
            failCapture(m_captureRequest, QStringLiteral("session locked"), s_sessionLockedErrorName);
        } else {
            failCapture(m_captureRequest, QStringLiteral("capture canceled by stop"));
        }
    }
    releasePressedState();
    detachInputDevice();
    // Both paths, because a session can end with either outstanding and a client
    // left holding an enter keeps drawing hover and believing it has focus.
    directPointerLeave();
    directKeyboardLeave();
    if (m_seat) {
        m_seat->notifyPointerLeave();
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
    m_pointerWindow.clear();
    m_pointerDirect = false;
    m_keyboardWindow.clear();
    m_keyboardDirect = false;
    m_targetWindow.clear();
    m_targetRequested = false;
    clearWindowActivation();
    // A session that ended leaves nothing of the agent's open on the desktop.
    dismissAgentPopups([](const Window *) {
        return true;
    });

    const bool changed = recordStop(reason);
    setCursorVisible(false);
    if (changed) {
        Q_EMIT sessionStopped(m_stopReason);
    }
}

/**
 * The lifetime half of a stop: the running flag, the reason, and the release
 * latch. Returns whether anything observable changed, which is exactly when
 * sessionStopped is emitted.
 *
 * The latch is one-way here. Only the human's panic shortcut sets it, and only
 * the human's resume shortcut (handleReleaseShortcut) clears it. Everything
 * else that stops a session - a server re-authenticating after a restart, an
 * explicit stop(), an idle timeout, the screen locking - tears down the input
 * state and leaves the latch exactly as the human left it. Before this rule a
 * re-authentication assigned the latch false, so a server that came back after
 * the human hit the panic switch could start driving again without the human
 * ever having handed control back.
 */
bool SynaraComputerUsePlugin::recordStop(StopReason reason)
{
    const bool wasRunning = m_running;
    const bool latching = reason == StopReason::UserRelease;
    const bool changed = wasRunning || (latching && !m_releasedByUser);
    m_running = false;
    m_stopReason = stopReasonName(reason);
    m_releasedByUser = m_releasedByUser || latching;
    return changed;
}

QString SynaraComputerUsePlugin::stopReasonName(StopReason reason)
{
    switch (reason) {
    case StopReason::IdleTimeout:
        return QStringLiteral("idle-timeout");
    case StopReason::UserRelease:
        return QStringLiteral("user-release");
    case StopReason::SessionLocked:
        return QStringLiteral("session-locked");
    case StopReason::Request:
        break;
    }
    return QStringLiteral("request");
}

/**
 * Whether the desktop is off limits: the screen is locked (or a lock is being
 * acquired), or the logind session is inactive because the human switched to
 * another VT or a greeter.
 *
 * Both are the compositor's own answers - KWin gates its input filters and its
 * lock-screen rendering on the same two facts - so the plugin cannot disagree
 * with what the human sees on screen.
 */
bool SynaraComputerUsePlugin::sessionLocked() const
{
    if (waylandServer() && waylandServer()->isScreenLocked()) {
        return true;
    }
    const Session *session = kwinApp() ? kwinApp()->session() : nullptr;
    return session && !session->isActive();
}

/**
 * Refuses the current D-Bus call with SessionLocked while sessionLocked().
 *
 * Every input and capture entry point checks this at admission, so nothing is
 * injected into or read from a desktop the human has locked away; the server
 * turns the error into a retryable refusal rather than a broken connection.
 */
bool SynaraComputerUsePlugin::refuseIfSessionLocked() const
{
    if (!sessionLocked()) {
        return false;
    }
    if (calledFromDBus()) {
        sendErrorReply(s_sessionLockedErrorName,
                       QStringLiteral("The desktop session is locked or inactive, so nothing was captured or "
                                      "injected. Retry once the human has unlocked it."));
    }
    return true;
}

void SynaraComputerUsePlugin::watchSessionState()
{
    if (waylandServer()) {
        connect(waylandServer(), &WaylandServer::lockStateChanged, this, &SynaraComputerUsePlugin::handleSessionStateChanged);
    }
    if (Session *session = kwinApp() ? kwinApp()->session() : nullptr) {
        connect(session, &Session::activeChanged, this, &SynaraComputerUsePlugin::handleSessionStateChanged);
    }
}

/**
 * Locking ends a running session outright, rather than leaving it to refuse
 * the next call: keys and buttons the agent holds are released before the
 * lock screen takes the desktop, the ghost cursor is not drawn over the lock
 * screen, and a capture already waiting for a frame fails with SessionLocked
 * instead of reading pixels from under the greeter. Unlocking restarts
 * nothing; the server starts the next session when it next acts, exactly as
 * after an idle timeout, and the release latch is untouched either way.
 */
void SynaraComputerUsePlugin::handleSessionStateChanged()
{
    if (!sessionLocked()) {
        return;
    }
    if (m_captureRequest) {
        failCapture(m_captureRequest, QStringLiteral("session locked"), s_sessionLockedErrorName);
    }
    failSettleRequests(s_sessionLockedErrorName, QStringLiteral("session locked"));
    if (m_running) {
        stopSession(StopReason::SessionLocked);
    }
}

void SynaraComputerUsePlugin::registerReleaseShortcut()
{
    m_releaseAction = new QAction(this);
    m_releaseAction->setObjectName(s_releaseActionName);
    m_releaseAction->setText(QStringLiteral("Release Synara computer control"));
    connect(m_releaseAction, &QAction::triggered, this, &SynaraComputerUsePlugin::handleReleaseShortcut);
    // The default is a request, not a fact: the human may have remapped it in
    // System Settings, KGlobalAccel may refuse it because another component
    // holds it, or the daemon may be unreachable. What healthJson advertises is
    // the sequence that actually fires, read back after registration and again
    // whenever it changes.
    m_releaseShortcutRegistered = KGlobalAccel::setGlobalShortcut(m_releaseAction, defaultReleaseShortcut());
    connect(KGlobalAccel::self(), &KGlobalAccel::globalShortcutChanged, this, [this](QAction *action, const QKeySequence &) {
        if (action == m_releaseAction) {
            updateEffectiveReleaseShortcut();
        }
    });
    updateEffectiveReleaseShortcut();
}

/** Reads back the sequence KGlobalAccel actually bound, empty when none. */
void SynaraComputerUsePlugin::updateEffectiveReleaseShortcut()
{
    const QList<QKeySequence> sequences = m_releaseAction ? KGlobalAccel::self()->shortcut(m_releaseAction) : QList<QKeySequence>();
    m_effectiveReleaseShortcut = QKeySequence();
    for (const QKeySequence &sequence : sequences) {
        if (!sequence.isEmpty()) {
            m_effectiveReleaseShortcut = sequence;
            break;
        }
    }
}

/** The effective shortcut for JSON: a native-text string, or null for none. */
QJsonValue SynaraComputerUsePlugin::releaseShortcutJson() const
{
    if (m_effectiveReleaseShortcut.isEmpty()) {
        return QJsonValue();
    }
    return m_effectiveReleaseShortcut.toString(QKeySequence::NativeText);
}

/** The effective shortcut for a message, which has to read even when none. */
QString SynaraComputerUsePlugin::releaseShortcutText() const
{
    if (m_effectiveReleaseShortcut.isEmpty()) {
        return QStringLiteral("the release shortcut (none could be registered)");
    }
    return m_effectiveReleaseShortcut.toString(QKeySequence::NativeText);
}

void SynaraComputerUsePlugin::handleReleaseShortcut()
{
    // Pressing it again hands control back without a trip through Synara, so a
    // panic stop can never strand the feature.
    if (!m_running && m_releasedByUser) {
        m_releasedByUser = false;
        m_stopReason = QStringLiteral("user-resume");
        return;
    }
    stopSession(StopReason::UserRelease);
}

bool SynaraComputerUsePlugin::requireRunning()
{
    if (!m_running) {
        return false;
    }
    noteActivity();
    return true;
}

void SynaraComputerUsePlugin::noteActivity()
{
    m_lastActivity.restart();
    armIdleTimer();
    if (m_cursorItem) {
        m_cursorItem->noteActivity();
    }
}

void SynaraComputerUsePlugin::armIdleTimer()
{
    if (!m_running || m_idleTimeoutMs == 0) {
        m_idleTimer.stop();
        return;
    }
    m_idleTimer.start(int(std::max<qint64>(0, qint64(m_idleTimeoutMs) - idleMilliseconds())));
}

qint64 SynaraComputerUsePlugin::idleMilliseconds() const
{
    return m_lastActivity.isValid() ? m_lastActivity.elapsed() : 0;
}

bool SynaraComputerUsePlugin::focusWindow(const QString &windowId)
{
    if (!m_auth.permits(*this)) return false;
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (!requireRunning()) {
        return false;
    }
    DirectInjectionScope scope(this);
    Window *window = findWindowById(windowId);
    if (!usableWindow(window)) {
        return false;
    }
    // Before adopting the target, not after: focusing a window that cannot
    // receive the agent's keys would report success and then swallow everything
    // typed into it.
    // Probed here rather than reused: this window has not been arrived on yet, so
    // no path decision has been taken for it.
    if (!requireReachableClient(window, usePointerDirectInjection(window))) {
        return false;
    }
    m_targetWindow = window;
    m_targetRequested = true;
    updatePointerFocus();
    updateKeyboardFocus();
    noteAgentInput();
    return true;
}

bool SynaraComputerUsePlugin::raiseWindow(const QString &windowId)
{
    if (!m_auth.permits(*this)) return false;
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (!requireRunning()) {
        return false;
    }
    Window *window = findWindowById(windowId);
    if (!usableWindow(window)) {
        return false;
    }
    if (refuseIfRaiseCoversHuman(window)) {
        return false;
    }
    // Restack only. `activateWindow` would move the human's keyboard focus,
    // and the agent already has its own seat, so raising is the whole point:
    // it makes the window the agent is driving the one the user can see.
    Workspace::self()->raiseWindow(window);
    noteAgentInput();
    return true;
}

bool SynaraComputerUsePlugin::clearFocusWindow()
{
    if (!m_auth.permits(*this)) return false;
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (!requireRunning()) {
        return false;
    }
    DirectInjectionScope scope(this);
    m_targetWindow.clear();
    m_targetRequested = false;
    updatePointerFocus();
    updateKeyboardFocus();
    return true;
}

bool SynaraComputerUsePlugin::movePointer(double x, double y)
{
    if (!m_auth.permits(*this)) return false;
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (!requireRunning()) {
        return false;
    }
    DirectInjectionScope scope(this);
    if (!inputReady()) {
        return false;
    }
    // NaN survives every downstream clamp (comparisons are all false), and
    // wl_fixed_from_double would encode it into the compositor's pointer
    // position, so non-finite input is refused at the door.
    if (!std::isfinite(x) || !std::isfinite(y)) {
        return false;
    }

    m_pos = confinedPoint(QPointF(x, y));
    // Hover can redraw (a highlighted button, a tooltip), so a move counts.
    noteAgentInput();
    if (m_ownsCompositor) {
        // KWin owns the cursor and the focus that follows it, so the move is the
        // whole action: the drawn cursor follows Cursor::posChanged once the
        // motion lands, and there is no focus to maintain.
        m_inputDevice->sendMotionAbsolute(m_pos);
        return true;
    }

    ensureCursorItem();
    if (m_cursorItem) {
        m_cursorItem->setHotspot(m_pos);
    }

    setTimestampNow();
    updatePointerFocus();
    m_seat->notifyPointerFrame();
    return true;
}

bool SynaraComputerUsePlugin::button(uint button, bool pressed)
{
    if (!m_auth.permits(*this)) return false;
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (!requireRunning()) {
        return false;
    }
    DirectInjectionScope scope(this);
    if (!inputReady()) {
        return false;
    }
    // Every refusal is decided on where the event would go, before anything
    // is sent to get it there: a refused click must not leave an enter, a
    // focus change or a borrowed activation behind in the human's client.
    Window *target = resolvePointerWindow();
    if (!target) {
        // updatePointerFocus tears down what the old target held, which is a
        // leave and never an intrusion.
        updatePointerFocus();
        return false;
    }
    const bool direct = directPathFor(target, m_pointerWindow, m_pointerDirect);
    if (!requireReachableClient(target, direct)) {
        return false;
    }
    // The release half of a press the agent already delivered is never refused:
    // the client is holding that button down because of us, and leaving it held
    // is worse than the press was.
    const bool completingPress = !pressed && m_pressedButtons.contains(button);
    if (!completingPress && refuseIfHumanActive(target, direct, InputKind::Pointer)) {
        return false;
    }
    if (!updatePointerFocus()) {
        return false;
    }
    if (!m_ownsCompositor) {
        updateKeyboardFocus();
    }
    if (pressed && !m_agentPopups.isEmpty()) {
        // What the popup's grab would have done for the agent: a press on
        // another application closes the menu. One in the same application
        // is the client's to judge, as it is under a real grab.
        const Window *target = m_pointerWindow;
        dismissAgentPopups([target](const Window *popup) {
            return !target || !Window::belongToSameApplication(target, popup);
        });
    }

    sendButton(button, pressed);
    return true;
}

// Pixels per wheel notch. The whole stack speaks pixels - the tool surface, the
// computer pane, and the `axis` D-Bus method below - while a wheel speaks
// notches, so the conversion lives at the one place the two meet. These are
// content pixels, what a page moves per click (about 86 in Firefox on Wayland,
// 80 in Chromium), not the 15 wire units libinput reports per click: those are
// degrees, which every toolkit scales up, and taking them for pixels made each
// scroll several times longer than asked. Keep in sync with SCROLL_STEP_PX in
// apps/server/src/computer/scrollUnits.ts, which carries the full rationale.
static constexpr double s_scrollPixelsPerNotch = 80.0;
// What one notch is worth in wl_pointer.axis: libinput's wheel unit is degrees
// of rotation, 15 per click, and that is the scale every client expects there.
static constexpr double s_axisUnitsPerNotch = 15.0;

/**
 * The continuous half of a wheel event for a scroll of @p pixels: the value
 * a client reads from wl_pointer.axis, in the units a physical wheel uses.
 */
static double scrollAxisValue(double pixels)
{
    if (!std::isfinite(pixels)) {
        return 0;
    }
    return pixels * s_axisUnitsPerNotch / s_scrollPixelsPerNotch;
}

/**
 * The value120 half of a wheel event for a scroll of @p pixels.
 *
 * value120 counts 1/120ths of a notch, so a single pixel is already eight of
 * them and nothing a caller can ask for rounds away. Clamped because the
 * protocol field is an int32 and a runaway accumulator must not wrap.
 */
static int scrollValue120(double pixels)
{
    if (!std::isfinite(pixels)) {
        return 0;
    }
    const double units = std::round(pixels * 120.0 / s_scrollPixelsPerNotch);
    return int(std::clamp(units, double(std::numeric_limits<int>::min()), double(std::numeric_limits<int>::max())));
}

/**
 * Scrolls by @p horizontal and @p vertical desktop pixels, not wheel notches.
 *
 * Positive is right and down, matching wl_pointer's axis directions.
 *
 * Wheel source with both halves — the pixel axis and its value120 notch count
 * — because it is the only scroll every toolkit acts on, measured live on
 * 2026-08-22: V22 sent finger-source continuous deltas instead, hoping their
 * pixels would be taken at face value, and Gecko ignored them completely (a
 * single 300 px burst and a touchpad-cadence stream of 6x50 px both moved a
 * form page zero pixels) while KWrite geared them ~5x. Wheel events always
 * deliver; what varies by toolkit is the distance — Qt honors the pixel half
 * exactly, browsers multiply the notch count by their own per-notch line
 * distance (~7x in Gecko). That per-window gearing is deliberately NOT
 * corrected here: the server measures real travel from before/after captures
 * and pre-divides each window's requests (scrollCalibration.ts), which is the
 * only place the correction can live, because no compositor-side unit is read
 * the same way by every client.
 */
bool SynaraComputerUsePlugin::axis(double horizontal, double vertical)
{
    if (!m_auth.permits(*this)) return false;
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (!requireRunning()) {
        return false;
    }
    DirectInjectionScope scope(this);
    if (!inputReady()) {
        return false;
    }
    // Same hazard as movePointer: a non-finite delta poisons the value120
    // conversion and any accumulator it touches.
    if (!std::isfinite(horizontal) || !std::isfinite(vertical)) {
        return false;
    }
    Window *target = resolvePointerWindow();
    if (!target) {
        updatePointerFocus();
        return false;
    }
    const bool direct = directPathFor(target, m_pointerWindow, m_pointerDirect);
    if (!requireReachableClient(target, direct)) {
        return false;
    }
    if (refuseIfHumanActive(target, direct, InputKind::Pointer)) {
        return false;
    }
    if (!updatePointerFocus()) {
        return false;
    }

    noteAgentInput();
    if (m_ownsCompositor) {
        if (horizontal != 0) {
            m_inputDevice->sendAxis(PointerAxis::Horizontal, scrollAxisValue(horizontal), scrollValue120(horizontal));
        }
        if (vertical != 0) {
            m_inputDevice->sendAxis(PointerAxis::Vertical, scrollAxisValue(vertical), scrollValue120(vertical));
        }
        return true;
    }

    if (m_pointerDirect) {
        directPointerAxis(horizontal, vertical);
        return true;
    }

    setTimestampNow();
    if (horizontal != 0) {
        m_seat->notifyPointerAxis(Qt::Horizontal, scrollAxisValue(horizontal), scrollValue120(horizontal), PointerAxisSource::Wheel);
    }
    if (vertical != 0) {
        m_seat->notifyPointerAxis(Qt::Vertical, scrollAxisValue(vertical), scrollValue120(vertical), PointerAxisSource::Wheel);
    }
    m_seat->notifyPointerFrame();
    return true;
}

bool SynaraComputerUsePlugin::key(uint keyCode, bool pressed)
{
    if (!m_auth.permits(*this)) return false;
    if (refuseIfSessionLocked()) {
        return false;
    }
    if (!requireRunning()) {
        return false;
    }
    DirectInjectionScope scope(this);
    return deliverKey(keyCode, pressed);
}

QDBusArgument &operator<<(QDBusArgument &argument, const SynaraKeyStroke &stroke)
{
    argument.beginStructure();
    argument << stroke.keyCode << stroke.pressed;
    argument.endStructure();
    return argument;
}

const QDBusArgument &operator>>(const QDBusArgument &argument, SynaraKeyStroke &stroke)
{
    argument.beginStructure();
    argument >> stroke.keyCode >> stroke.pressed;
    argument.endStructure();
    return argument;
}

/**
 * A word of typing in one call instead of two per character.
 *
 * One synchronous call is one burst (DirectInjectionScope): the human's own
 * events cannot land between two strokes, because the compositor thread is
 * here until the batch is done, so a borrowed seat0 object is handed back once
 * at the end rather than between every key. Everything that could change
 * between strokes - the target, the path, whether the human is active - is
 * still checked per stroke by the same code key() runs.
 */
uint SynaraComputerUsePlugin::keys(const QList<SynaraKeyStroke> &strokes)
{
    if (!m_auth.permits(*this)) return 0;
    if (strokes.size() > s_maxKeyStrokes) {
        if (calledFromDBus()) {
            sendErrorReply(QDBusError::InvalidArgs,
                           QStringLiteral("keys takes at most %1 strokes per call, not %2")
                               .arg(s_maxKeyStrokes)
                               .arg(strokes.size()));
        }
        return 0;
    }
    if (refuseIfSessionLocked()) {
        return 0;
    }
    if (!requireRunning()) {
        return 0;
    }
    DirectInjectionScope scope(this);
    uint delivered = 0;
    for (const SynaraKeyStroke &stroke : strokes) {
        m_quietRefusals = delivered > 0;
        const bool sent = deliverKey(stroke.keyCode, stroke.pressed);
        m_quietRefusals = false;
        if (!sent) {
            break;
        }
        ++delivered;
    }
    return delivered;
}

bool SynaraComputerUsePlugin::deliverKey(uint keyCode, bool pressed)
{
    if (!inputReady()) {
        return false;
    }
    // Refusals first, on the window the key would go to: focusing it is an
    // enter, a modifiers event and a borrowed activation, all of which the
    // human's window of the same client notices, so none may precede a
    // refusal (audit P2).
    Window *target = resolveKeyboardWindow();
    if (!target) {
        // updateKeyboardFocus drops a lost target's keys and focus, which is
        // cleanup, not delivery.
        updateKeyboardFocus();
        return false;
    }
    const bool direct = directPathFor(target, m_keyboardWindow, m_keyboardDirect);
    if (!requireReachableClient(target, direct)) {
        return false;
    }
    // Same exemption the pointer makes, and it matters more here: refusing the
    // release of a held Ctrl leaves the client believing a modifier is down.
    const bool completingPress = !pressed && m_pressedKeys.contains(keyCode);
    if (!completingPress && refuseIfHumanActive(target, direct, InputKind::Keyboard)) {
        return false;
    }
    if (!updateKeyboardFocus()) {
        return false;
    }

    sendKey(keyCode, pressed);
    return true;
}

void SynaraComputerUsePlugin::sendButton(quint32 code, bool pressed)
{
    if (!inputReady()) {
        return;
    }
    noteAgentInput();
    if (pressed) {
        m_pressedButtons.insert(code);
        noteAgentPress(m_pointerWindow);
    } else {
        m_pressedButtons.remove(code);
    }

    if (m_ownsCompositor) {
        m_inputDevice->sendButton(code, pressed);
        return;
    }

    // By the path decided when the pointer arrived, not by whether an enter is
    // outstanding: after the object was handed back to the human the enter is
    // gone but the window is still driven directly, and a release that took the
    // agent seat instead would leave the client's button latched for good.
    if (m_pointerDirect) {
        directPointerButton(code, pressed);
        return;
    }

    setTimestampNow();
    m_seat->notifyPointerButton(code, pressed ? PointerButtonState::Pressed : PointerButtonState::Released);
    m_seat->notifyPointerFrame();
}

void SynaraComputerUsePlugin::sendKey(quint32 keyCode, bool pressed)
{
    if (!inputReady()) {
        return;
    }
    noteAgentInput();
    // The direct path owes the target an enter whenever the object was handed
    // back to the human since the last key (restoreHumanDelivery) or KWin moved
    // seat0 through this client (handleHumanKeyboardFocusAboutToChange). It has
    // to go out with the held-key state as it is *before* this event mutates
    // it: an enter that already lists the key about to be pressed makes the
    // client see that key twice.
    if (!m_ownsCompositor && m_keyboardDirect) {
        ensureDirectKeyboardEnter();
    }
    if (pressed) {
        if (!m_pressedKeys.contains(keyCode)) {
            m_pressedKeys.append(keyCode);
        }
        noteAgentPress(m_keyboardWindow);
    } else {
        m_pressedKeys.removeOne(keyCode);
    }

    if (m_ownsCompositor) {
        // Through KWin's keyboard pipeline, which owns the xkb state, so there
        // is nothing to mirror here and modifiers need no separate sync.
        m_inputDevice->sendKey(keyCode, pressed);
        return;
    }

    if (m_keyboardDirect) {
        directKeyboardKey(keyCode, pressed);
    } else {
        setTimestampNow();
        const quint32 serial = waylandServer()->display()->nextSerial();
        // Delivered on the agent's own seat, never through KWin's real keyboard
        // pipeline, so the user's focus and typing are untouched.
        m_seat->notifyKeyboardKey(keyCode,
                                  pressed ? KeyboardKeyState::Pressed : KeyboardKeyState::Released,
                                  serial);
    }

    if (m_xkbState) {
        // evdev keycode -> xkb keycode offset is 8.
        xkb_state_update_key(m_xkbState, keyCode + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
        syncModifiers();
        directKeyboardModifiers();
    }
}

bool SynaraComputerUsePlugin::waitForSettle(const QString &windowId, uint quietMs, uint timeoutMs, uint &elapsedMs)
{
    elapsedMs = 0;
    if (!m_auth.permits(*this)) return false;
    if (!calledFromDBus()) {
        return false;
    }
    if (refuseIfSessionLocked()) {
        return false;
    }
    Window *window = windowId.isEmpty() ? nullptr : findWindowById(windowId);
    // Nothing to observe: no session, or no such window to watch. Answered
    // unsettled at once rather than as an error, as the Hyprland plugin does.
    if (!m_running || (!windowId.isEmpty() && !presentWindow(window))) {
        return false;
    }
    if (m_settleRequests.size() >= s_maxSettleWaits) {
        sendErrorReply(QDBusError::LimitsExceeded,
                       QStringLiteral("at most %1 waitForSettle calls may be pending at once").arg(s_maxSettleWaits));
        return false;
    }
    setDelayedReply(true);

    const qint64 now = m_settleClock.nsecsElapsed();
    auto request = std::make_unique<SettleRequest>(connection(), message());
    request->window = window;
    request->anyWindow = window == nullptr;
    // An input no settled wait has covered yet is what this one waits out;
    // with none, whatever happens after the call. A wait that times out
    // leaves its input pending for the next.
    const bool inputPending = m_lastAgentInputNs >= 0 && m_lastAgentInputNs > m_settledAgentInputNs;
    request->baselineNs = inputPending ? m_lastAgentInputNs : now;
    request->startedNs = now;
    request->quietNs = qint64(quietMs) * 1000000;
    request->deadlineNs = now + qint64(std::min(timeoutMs, s_maxSettleTimeoutMs)) * 1000000;
    request->timer = new QTimer(this);
    request->timer->setSingleShot(true);
    request->timer->setTimerType(Qt::PreciseTimer);
    SettleRequest *raw = request.get();
    connect(request->timer, &QTimer::timeout, this, [this, raw]() {
        evaluateSettle(raw);
    });
    m_settleRequests.push_back(std::move(request));
    evaluateSettle(raw);
    return false;
}

void SynaraComputerUsePlugin::noteAgentInput()
{
    m_lastAgentInputNs = m_settleClock.nsecsElapsed();
}

/**
 * Damage, not every commit: Window::damaged fires for commits that change
 * pixels in the window's surface tree (subsurfaces and the decoration
 * included), so a client that commits every frame only to ask for the next
 * frame callback still reads as quiet.
 */
void SynaraComputerUsePlugin::trackWindowDamage(Window *window)
{
    if (!window) {
        return;
    }
    connect(window, &Window::damaged, this, &SynaraComputerUsePlugin::handleWindowDamaged, Qt::UniqueConnection);
    connect(window, &Window::closed, this, [this, window]() {
        handleWindowClosed(window);
    });
}

void SynaraComputerUsePlugin::handleWindowDamaged(Window *window)
{
    const qint64 now = m_settleClock.nsecsElapsed();
    m_windowDamageNs.insert(window, now);
    m_anyDamageNs = now;
    if (m_settleRequests.empty()) {
        return;
    }
    // Collected first: evaluating may finish a request and erase it.
    QList<SettleRequest *> affected;
    for (const auto &request : m_settleRequests) {
        if (request->anyWindow || request->window == window) {
            affected.append(request.get());
        }
    }
    for (SettleRequest *request : std::as_const(affected)) {
        evaluateSettle(request);
    }
}

void SynaraComputerUsePlugin::handleWindowClosed(Window *window)
{
    m_windowDamageNs.remove(window);
    QList<SettleRequest *> affected;
    for (const auto &request : m_settleRequests) {
        if (!request->anyWindow && request->window == window) {
            affected.append(request.get());
        }
    }
    // A window that closed will not settle; the caller learns it from the
    // next observation rather than from an error.
    for (SettleRequest *request : std::as_const(affected)) {
        finishSettle(request, false);
    }
}

void SynaraComputerUsePlugin::evaluateSettle(SettleRequest *request)
{
    if (!request->anyWindow && (!request->window || request->window->isDeleted())) {
        finishSettle(request, false);
        return;
    }
    const qint64 now = m_settleClock.nsecsElapsed();
    const qint64 lastCommit = request->anyWindow ? m_anyDamageNs : m_windowDamageNs.value(request->window.data(), -1);
    const SettleVerdict verdict = settleVerdict(now, lastCommit, request->baselineNs, request->quietNs, request->deadlineNs);
    if (verdict.done) {
        finishSettle(request, verdict.settled);
        return;
    }
    // Rounded up, so the timer never fires a hair early and re-arms for 0 ms.
    const qint64 waitMs = (verdict.recheckNs - now + 999999) / 1000000;
    request->timer->start(int(std::clamp<qint64>(waitMs, 1, s_maxSettleTimeoutMs)));
}

void SynaraComputerUsePlugin::finishSettle(SettleRequest *request, bool settled)
{
    const auto it = std::find_if(m_settleRequests.begin(), m_settleRequests.end(), [request](const auto &candidate) {
        return candidate.get() == request;
    });
    if (it == m_settleRequests.end()) {
        return;
    }
    std::unique_ptr<SettleRequest> owned = std::move(*it);
    m_settleRequests.erase(it);
    if (settled && owned->baselineNs == m_lastAgentInputNs) {
        m_settledAgentInputNs = std::max(m_settledAgentInputNs, owned->baselineNs);
    }
    retireSettleTimer(owned.get());
    const qint64 elapsedMs = (m_settleClock.nsecsElapsed() - owned->startedNs) / 1000000;
    owned->connection.send(owned->message.createReply(QVariantList{settled, uint(std::clamp<qint64>(elapsedMs, 0, std::numeric_limits<uint>::max()))}));
}

void SynaraComputerUsePlugin::retireSettleTimer(SettleRequest *request)
{
    if (QTimer *timer = request->timer) {
        timer->stop();
        timer->disconnect(this);
        timer->deleteLater();
    }
}

void SynaraComputerUsePlugin::finishAllSettleRequests()
{
    std::vector<SettleRequest *> pending;
    for (const auto &request : m_settleRequests) {
        pending.push_back(request.get());
    }
    for (SettleRequest *request : pending) {
        finishSettle(request, false);
    }
}

void SynaraComputerUsePlugin::failSettleRequests(const QString &errorName, const QString &reason)
{
    std::vector<std::unique_ptr<SettleRequest>> requests = std::move(m_settleRequests);
    m_settleRequests.clear();
    for (const auto &request : requests) {
        retireSettleTimer(request.get());
        request->connection.send(request->message.createErrorReply(errorName, reason));
    }
}

QByteArray SynaraComputerUsePlugin::captureWindow(const QString &windowId, uint maxDimension)
{
    if (!admitCapture()) {
        return {};
    }
    auto request = std::make_shared<CaptureRequest>(connection(), message());
    request->window = findWindowById(windowId);
    request->windowCapture = true;
    startCapture(std::move(request), maxDimension, 0, false);
    return {};
}

QByteArray SynaraComputerUsePlugin::captureRegion(int x, int y, uint width, uint height, uint maxDimension)
{
    if (!admitCapture()) {
        return {};
    }
    auto request = std::make_shared<CaptureRequest>(connection(), message());
    request->region = RectF(qreal(x), qreal(y), qreal(width), qreal(height));
    startCapture(std::move(request), maxDimension, 0, false);
    return {};
}

QByteArray SynaraComputerUsePlugin::captureWindowEx(const QString &windowId, uint maxDimension, uint flags, QString &mime)
{
    Q_UNUSED(mime)
    if (!admitCapture()) {
        return {};
    }
    auto request = std::make_shared<CaptureRequest>(connection(), message());
    request->window = findWindowById(windowId);
    request->windowCapture = true;
    startCapture(std::move(request), maxDimension, flags, true);
    return {};
}

QByteArray SynaraComputerUsePlugin::captureRegionEx(int x, int y, uint width, uint height, uint maxDimension, uint flags, QString &mime)
{
    Q_UNUSED(mime)
    if (!admitCapture()) {
        return {};
    }
    auto request = std::make_shared<CaptureRequest>(connection(), message());
    request->region = RectF(qreal(x), qreal(y), qreal(width), qreal(height));
    startCapture(std::move(request), maxDimension, flags, true);
    return {};
}

/**
 * The refusals every capture method shares, in order, before anything is
 * queued: the caller, the release latch and the lock.
 */
bool SynaraComputerUsePlugin::admitCapture()
{
    if (!m_auth.permits(*this)) return false;
    if (!calledFromDBus()) {
        return false;
    }
    // The release shortcut revokes the agent's view as well as its hands:
    // a latched release refuses capture until the user resumes, matching
    // start() and the input path.
    if (m_releasedByUser) {
        sendErrorReply(s_releasedErrorName,
                       QStringLiteral("computer control was released with %1")
                           .arg(releaseShortcutText()));
        return false;
    }
    if (refuseIfSessionLocked()) {
        return false;
    }
    return true;
}

void SynaraComputerUsePlugin::startCapture(std::shared_ptr<CaptureRequest> request, uint maxDimension, uint flags, bool extended)
{
    setDelayedReply(true);
    // A passive frame is an observer's (the preview), not the agent acting: it
    // must not keep an idle session alive or bring the badge back.
    if (m_running && !(flags & CapturePassive)) {
        noteActivity();
    }
    request->maxDimension = maxDimension;
    request->flags = flags;
    request->extended = extended;
    queueCapture(std::move(request));
}

void SynaraComputerUsePlugin::releaseCaptureTargets()
{
    m_captureTargetIdle.stop();
    if (m_captureTargets->isEmpty()) {
        return;
    }
    // Deleted in the context they were made in, when it still exists.
    EglContext *current = nullptr;
    if (effects && effects->openglContext() == m_captureTargets->context() && effects->makeOpenGLContextCurrent()) {
        current = effects->openglContext();
    }
    m_captureTargets->clear(current);
}

void SynaraComputerUsePlugin::watchRenderLoop(LogicalOutput *output)
{
    if (!output || !output->backendOutput()) {
        return;
    }
    RenderLoop *loop = output->backendOutput()->renderLoop();
    if (!loop || m_renderLoops.contains(loop)) {
        return;
    }

    m_renderLoops.insert(loop);
    connect(loop, &QObject::destroyed, this, [this, loop]() {
        m_renderLoops.remove(loop);
        m_captureFrameLoops.remove(loop);
    });
}

void SynaraComputerUsePlugin::queueCapture(std::shared_ptr<CaptureRequest> request)
{
    if (!request) {
        return;
    }
    if (m_captureRequest) {
        failCapture(request, QStringLiteral("capture already in flight"));
        return;
    }
    m_captureRequest = request;

    Workspace *workspace = Workspace::self();
    if (!workspace) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    if (request->windowCapture) {
        Window *window = request->window.data();
        if (!window || window->isDeleted()) {
            failCapture(request, QStringLiteral("unknown window"));
            return;
        }
        if (!isWindowVisibleForCapture(window)) {
            failCapture(request, QStringLiteral("window not visible"));
            return;
        }
        if (window->excludeFromCapture()) {
            failCapture(request, QStringLiteral("window excluded from capture"));
            return;
        }
        if (!window->surface() || !window->surface()->isMapped() || !window->windowItem() || !window->readyForPainting()) {
            failCapture(request, QStringLiteral("window unavailable"));
            return;
        }
        request->region = window->frameGeometry();
    }

    request->region = request->region.intersected(RectF(workspace->geometry()));
    if (request->region.isEmpty()) {
        failCapture(request, request->windowCapture ? QStringLiteral("window not visible") : QStringLiteral("zero-size region"));
        return;
    }

    if (request->windowCapture) {
        Window *window = request->window.data();
        request->windowDestroyedConnection = connect(window, &QObject::destroyed, this, [this, request]() {
            if (m_captureRequest == request) {
                failCapture(request, QStringLiteral("window closed during capture"));
            }
        });
    }

    if (!effects || !effects->scene() || !effects->isOpenGLCompositing() || !effects->openglContext()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    bool hasOutput = false;
    qreal effectiveScale = 1.0;
    QSet<RenderLoop *> captureLoops;
    for (LogicalOutput *output : workspace->outputs()) {
        if (!output || !output->backendOutput()) {
            continue;
        }
        watchRenderLoop(output);
        RenderLoop *loop = output->backendOutput()->renderLoop();
        if (!loop) {
            continue;
        }
        const RectF viewport = request->region.intersected(output->geometryF());
        if (viewport.isEmpty()) {
            continue;
        }
        hasOutput = true;
        effectiveScale = std::max(effectiveScale, output->scale());
        captureLoops.insert(loop);
    }
    if (!hasOutput) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    const std::optional<CapturePlan> plan = planCapture(request->region, effectiveScale, request->maxDimension);
    if (!plan) {
        failCapture(request, QStringLiteral("capture dimensions are invalid"));
        return;
    }
    // On what is rendered, not the native size: a downscaled capture of a
    // large mixed-scale desktop renders small and is well within limits.
    if (!captureSizeWithinLimits(plan->renderSize)) {
        failCapture(request, s_captureSizeLimitReason);
        return;
    }

    for (RenderLoop *loop : std::as_const(captureLoops)) {
        if (m_captureFrameLoops.contains(loop)) {
            continue;
        }
        connect(loop, &RenderLoop::frameRequested, this, &SynaraComputerUsePlugin::handleFrameRequested, Qt::DirectConnection);
        m_captureFrameLoops.insert(loop);
    }

    m_captureRenderWatchdog.start(s_captureRenderDeadlineMilliseconds);
    scheduleCapture(std::move(request));
}

void SynaraComputerUsePlugin::scheduleCapture(std::shared_ptr<CaptureRequest> request)
{
    if (!Workspace::self()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    for (LogicalOutput *output : Workspace::self()->outputs()) {
        if (!output || !output->backendOutput() || !output->backendOutput()->renderLoop()) {
            continue;
        }
        if (!request->region.intersects(output->geometryF())) {
            continue;
        }
        output->backendOutput()->renderLoop()->scheduleRepaint();
    }
}

void SynaraComputerUsePlugin::handleFrameRequested(RenderLoop *loop)
{
    Q_UNUSED(loop)
    if (!m_captureRequest || m_captureRequest->finished.load() || m_captureRequest->renderStarted.exchange(true)) {
        return;
    }

    captureAtRenderOpportunity(m_captureRequest);
}

void SynaraComputerUsePlugin::captureAtRenderOpportunity(std::shared_ptr<CaptureRequest> request)
{
    if (!request || m_captureRequest != request || request->finished.load()) {
        return;
    }
    // Admission was checked when the request arrived; the lock can have landed
    // in the frames since, and this is the last moment before pixels are read.
    if (sessionLocked()) {
        failCapture(request, QStringLiteral("session locked"), s_sessionLockedErrorName);
        return;
    }

    Window *selectedWindow = request->window.data();
    if (request->windowCapture) {
        if (!selectedWindow || selectedWindow->isDeleted()) {
            failCapture(request, QStringLiteral("window closed during capture"));
            return;
        }
        if (!isWindowVisibleForCapture(selectedWindow)) {
            failCapture(request, QStringLiteral("window not visible"));
            return;
        }
        if (selectedWindow->excludeFromCapture()) {
            failCapture(request, QStringLiteral("window excluded from capture"));
            return;
        }
        if (!selectedWindow->surface() || !selectedWindow->surface()->isMapped() || !selectedWindow->windowItem() || !selectedWindow->readyForPainting()) {
            failCapture(request, QStringLiteral("window unavailable"));
            return;
        }
        request->region = selectedWindow->frameGeometry();
    }

    Workspace *workspace = Workspace::self();
    if (!workspace) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }
    request->region = request->region.intersected(RectF(workspace->geometry()));
    if (request->region.isEmpty()) {
        failCapture(request, request->windowCapture ? QStringLiteral("window not visible") : QStringLiteral("zero-size region"));
        return;
    }
    if (!effects || !effects->scene() || !effects->isOpenGLCompositing()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }
    if (!effects->makeOpenGLContextCurrent() || !effects->openglContext()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    struct OutputCapture
    {
        LogicalOutput *output;
        RectF viewport;
    };
    QList<OutputCapture> outputs;
    qreal effectiveScale = 1.0;
    for (LogicalOutput *output : workspace->outputs()) {
        if (!output || !output->backendOutput() || !output->backendOutput()->renderLoop()) {
            continue;
        }
        const RectF viewport = request->region.intersected(output->geometryF());
        if (viewport.isEmpty()) {
            continue;
        }
        outputs.append({output, viewport});
        effectiveScale = std::max(effectiveScale, output->scale());
    }
    if (outputs.isEmpty()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    const std::optional<CapturePlan> plan = planCapture(request->region, effectiveScale, request->maxDimension);
    if (!plan) {
        failCapture(request, QStringLiteral("capture dimensions are invalid"));
        return;
    }
    if (!captureSizeWithinLimits(plan->renderSize)) {
        failCapture(request, s_captureSizeLimitReason);
        return;
    }

    QList<CapturePart> parts;
    for (const OutputCapture &output : std::as_const(outputs)) {
        // Each part's rectangle in the canvas, edges rounded once so adjacent
        // outputs meet on the same pixel; the part is rendered to exactly
        // that size.
        const QRect destination = deviceDestination(output.viewport, request->region, plan->renderScale, plan->renderSize);
        if (destination.isEmpty()) {
            continue;
        }
        QImage image;
        QString error;
        if (!renderCapturePart(effects->scene(),
                               effects->openglContext(),
                               *m_captureTargets,
                               output.output,
                               output.viewport,
                               plan->renderScale,
                               destination.size(),
                               selectedWindow,
                               request->windowCapture,
                               m_ownsCompositor,
                               &image,
                               &error)) {
            failCapture(request, error);
            return;
        }
        parts.append({std::move(image), destination});
    }
    m_captureTargetIdle.start();

    QPointer<SynaraComputerUsePlugin> receiver(this);
    const CaptureFormat format = captureFormat(request->flags);
    m_captureRenderWatchdog.stop();
    m_captureEncodeWatchdog.start(s_captureEncodeDeadlineMilliseconds);
    encodePool()->start(new CaptureEncodeTask(
        [receiver, request, parts = std::move(parts), plan = *plan, windowCapture = request->windowCapture, format]() mutable {
            QString error;
            const EncodedCapture encoded = encodeCapture(parts, plan, windowCapture, format, &error);
            // Posted to the application, which outlives every plugin, rather
            // than to the plugin: an event posted to an object being destroyed
            // on another thread is a race, and the receiver is only looked at
            // on the main thread, where its destruction happens.
            QMetaObject::invokeMethod(QCoreApplication::instance(),
                                      [receiver, request, encoded, error]() {
                                          if (receiver) {
                                              receiver->finishCapture(request, encoded.bytes, encoded.mime, error);
                                          }
                                      },
                                      Qt::QueuedConnection);
        }));
}

void SynaraComputerUsePlugin::finishCapture(std::shared_ptr<CaptureRequest> request, const QByteArray &bytes, const QString &mime, const QString &error, const QString &errorName)
{
    if (!request || m_captureRequest != request || request->finished.exchange(true)) {
        return;
    }

    m_captureRenderWatchdog.stop();
    m_captureEncodeWatchdog.stop();
    for (RenderLoop *loop : std::as_const(m_captureFrameLoops)) {
        QObject::disconnect(loop, &RenderLoop::frameRequested, this, &SynaraComputerUsePlugin::handleFrameRequested);
    }
    m_captureFrameLoops.clear();
    QObject::disconnect(request->windowDestroyedConnection);
    request->windowDestroyedConnection = {};
    m_captureRequest.reset();

    QString reason = error.simplified();
    if (reason.isEmpty() && bytes.isEmpty()) {
        reason = QStringLiteral("capture failed");
    }
    if (!reason.isEmpty()) {
        request->connection.send(request->message.createErrorReply(errorName.isEmpty() ? s_captureErrorName : errorName, reason));
        return;
    }
    if (request->extended) {
        request->connection.send(request->message.createReply(QVariantList{QVariant::fromValue(bytes), mime}));
        return;
    }
    request->connection.send(request->message.createReply(QVariant::fromValue(bytes)));
}

void SynaraComputerUsePlugin::failCapture(std::shared_ptr<CaptureRequest> request, const QString &reason, const QString &errorName)
{
    if (!request) {
        return;
    }
    if (m_captureRequest == request) {
        finishCapture(std::move(request), {}, {}, reason, errorName);
        return;
    }
    if (!request->finished.exchange(true)) {
        QObject::disconnect(request->windowDestroyedConnection);
        request->windowDestroyedConnection = {};
        request->connection.send(request->message.createErrorReply(errorName.isEmpty() ? s_captureErrorName : errorName, reason.simplified()));
    }
}

bool SynaraComputerUsePlugin::inputReady() const
{
    return m_ownsCompositor ? bool(m_inputDevice) : bool(m_seat);
}

void SynaraComputerUsePlugin::ensureInputDevice()
{
    if (!m_inputDevice) {
        m_inputDevice = std::make_unique<SynaraVirtualInputDevice>(this);
    }
}

/**
 * Only while a session runs, so a stopped agent is not merely ignored but
 * absent: KWin counts attached devices when it decides whether a pointer exists
 * at all, and a device that is present but idle still asserts one.
 */
void SynaraComputerUsePlugin::attachInputDevice()
{
    if (m_deviceAttached || !m_inputDevice || !input()) {
        return;
    }
    input()->addInputDevice(m_inputDevice.get());
    m_deviceAttached = true;
}

void SynaraComputerUsePlugin::detachInputDevice()
{
    if (!m_deviceAttached) {
        return;
    }
    m_deviceAttached = false;
    if (!m_inputDevice || !input()) {
        return;
    }
    input()->removeInputDevice(m_inputDevice.get());
    // KWin's removeInputDevice() leaves in place every connection that
    // addInputDevice() made, so adding the same device again on the next start
    // would deliver each agent event once per session this plugin has run.
    // KWin's own virtual devices (fake input, EIS) are never re-added either:
    // a removed one is destroyed, which drops its connections, and the next
    // add uses a fresh one. Deferred, because a stop can run from inside one of
    // the old device's own emissions.
    std::exchange(m_inputDevice, std::make_unique<SynaraVirtualInputDevice>(this)).release()->deleteLater();
}

void SynaraComputerUsePlugin::ensureSeat()
{
    // A compositor the agent owns is driven through its own input stack, and a
    // second seat there would reintroduce the very clients it cannot reach.
    if (m_ownsCompositor) {
        return;
    }
    if (m_seat || !waylandServer() || !waylandServer()->display()) {
        return;
    }

    m_seat = new SeatInterface(waylandServer()->display(), s_agentSeatName, this);
    m_seat->setHasPointer(true);
    m_seat->setHasKeyboard(true);
    m_seat->keyboard()->setRepeatInfo(25, 660);

    refreshAgentKeymap();
    // The human can change their layouts at any time (System Settings,
    // locale1); the agent seat has to follow or its keycodes mean something
    // else to the client than to the server that chose them.
    if (KeyboardLayout *layouts = input() && input()->keyboard() ? input()->keyboard()->keyboardLayout() : nullptr) {
        connect(layouts, &KeyboardLayout::layoutsReconfigured, this, &SynaraComputerUsePlugin::refreshAgentKeymap);
    }
}

/**
 * Mirrors the real keyboard's keymap onto the agent seat so clients can
 * interpret the agent's evdev keycodes, and rebuilds the agent's own xkb state
 * on it so modifier events (Shift, Ctrl, ...) are correct for the agent's key
 * stream. Keys held across the change are released first, on the path that
 * saw the press: a release computed against the new state could unwind a
 * modifier the old map never set.
 */
void SynaraComputerUsePlugin::refreshAgentKeymap()
{
    const Xkb *xkb = humanXkb();
    xkb_keymap *keymap = xkb ? xkb->keymap() : nullptr;
    if (!m_seat || !keymap) {
        return;
    }
    DirectInjectionScope scope(this);
    releasePressedKeys();
    if (char *content = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1)) {
        m_seat->keyboard()->setKeymap(QByteArray(content));
        free(content);
    }
    if (m_xkbState) {
        xkb_state_unref(m_xkbState);
    }
    m_xkbState = xkb_state_new(keymap);
    syncModifiers();
}

/**
 * The index of the layout the agent's keys are interpreted with.
 *
 * On the human's compositor that is the group of the agent's own xkb state,
 * which starts on the keymap's first layout and stays there unless the agent
 * presses a group switch itself, whatever layout the human has switched to:
 * the agent seat sends the agent's group, and so does the direct path
 * (directKeyboardModifiers). In a compositor the agent owns its keys go
 * through KWin's own keyboard, so it is KWin's current layout.
 */
quint32 SynaraComputerUsePlugin::keyboardLayoutIndex() const
{
    if (!m_ownsCompositor && m_xkbState) {
        return xkb_state_serialize_layout(m_xkbState, XKB_STATE_LAYOUT_EFFECTIVE);
    }
    const Xkb *xkb = humanXkb();
    return xkb ? xkb->currentLayout() : 0;
}

/**
 * The xkb (RMLVO) name of that layout, "us" or "de", which is what the
 * server's typing gate compares. A keymap loaded without a layout list has no
 * short names; the descriptive name ("English (US)") stands in, which the
 * server's gate reads as it reads the short one: plain US passes, anything
 * else is refused and named in the refusal.
 */
QString SynaraComputerUsePlugin::keyboardLayout() const
{
    const Xkb *xkb = humanXkb();
    if (!xkb) {
        return {};
    }
    const quint32 index = keyboardLayoutIndex();
    const QString shortName = xkb->layoutShortName(int(index));
    return shortName.isEmpty() ? xkb->layoutName(index) : shortName;
}

QString SynaraComputerUsePlugin::keyboardLayoutName() const
{
    const Xkb *xkb = humanXkb();
    return xkb ? xkb->layoutName(keyboardLayoutIndex()) : QString();
}

void SynaraComputerUsePlugin::ensureCursorItem()
{
    // The agent's cursor is this drawn item on every backend, so a session looks
    // the same on every machine. On the human's compositor it is a second cursor
    // beside theirs; on a compositor the agent owns it stands in for KWin's own,
    // which depends on a cursor theme the host distro may not ship and on
    // clients not hiding or replacing it — the two ways the agent's cursor used
    // to vanish mid-session.
    if (m_cursorItem || !effects || !effects->scene()) {
        return;
    }

    m_cursorItem = std::make_unique<SynaraAgentCursorItem>(effects->scene()->overlayItem());
    m_cursorItem->setZ(1000);
    m_cursorItem->setAgentName(m_agentName);
    if (m_ownsCompositor) {
        // The one seat's cursor position is authoritative here — clients can
        // warp it and the human can drive it through the host window's pointer
        // grab — so the item follows the compositor's cursor rather than the
        // plugin's last injected point.
        if (Cursor *cursor = Cursors::self() ? Cursors::self()->mouse() : nullptr) {
            connect(cursor, &Cursor::posChanged, m_cursorItem.get(), [item = m_cursorItem.get()](const QPointF &pos) {
                item->setHotspot(pos);
            });
            m_cursorItem->setHotspot(cursor->pos());
        }
    } else {
        m_cursorItem->setHotspot(m_pos);
    }
    m_cursorItem->setVisible(m_running);
}

void SynaraComputerUsePlugin::setCursorVisible(bool visible)
{
    ensureCursorItem();
    if (m_cursorItem) {
        m_cursorItem->setVisible(visible);
        // In a compositor the agent owns, the drawn item replaces KWin's cursor
        // instead of joining it: two arrows over one seat would read as two
        // pointers. The native cursor comes back when the session ends, so a
        // human grabbing the nested window's pointer still sees one.
        if (m_ownsCompositor) {
            setNativeCursorHidden(visible);
        }
    }
}

void SynaraComputerUsePlugin::setNativeCursorHidden(bool hidden)
{
    if (m_nativeCursorHidden == hidden || !Cursors::self()) {
        return;
    }
    m_nativeCursorHidden = hidden;
    if (hidden) {
        Cursors::self()->hideCursor();
    } else {
        Cursors::self()->showCursor();
    }
}

QPointF SynaraComputerUsePlugin::confinedPoint(const QPointF &point) const
{
    if (!Workspace::self()) {
        return point;
    }
    LogicalOutput *output = Workspace::self()->outputAt(point);
    if (!output) {
        return point;
    }
    const RectF geometry = output->geometryF();
    return QPointF(std::clamp(point.x(), geometry.x(), geometry.x() + geometry.width() - 1),
                   std::clamp(point.y(), geometry.y(), geometry.y() + geometry.height() - 1));
}

/**
 * Topmost window at @p point that can take input of this kind.
 *
 * The kind matters because a popup takes the pointer and not the keyboard: a
 * click has to reach the menu drawn under the cursor, while a keystroke has to
 * reach a window that can be focused, which is the same window it reached
 * before any menu opened.
 */
Window *SynaraComputerUsePlugin::windowAt(const QPointF &point, InputKind kind) const
{
    if (!Workspace::self()) {
        return nullptr;
    }

    const QList<Window *> stacking = Workspace::self()->stackingOrder();
    auto it = stacking.end();
    while (it != stacking.begin()) {
        --it;
        Window *window = *it;
        const bool usable = kind == InputKind::Pointer ? pointerUsableWindow(window) : usableWindow(window);
        if (!usable) {
            continue;
        }
        if (window->hitTest(point)) {
            return window;
        }
    }
    return nullptr;
}

Window *SynaraComputerUsePlugin::findWindowById(const QString &windowId) const
{
    if (!Workspace::self()) {
        return nullptr;
    }
    return Workspace::self()->findWindow([&windowId](const Window *window) {
        return window->internalId().toString(QUuid::WithoutBraces) == windowId
            || window->internalId().toString() == windowId;
    });
}

namespace
{
struct AgentSeatProbe
{
    const SeatInterface *seat;
    bool bound;
};

// Whether the client created an actual wl_pointer *object* on the agent seat -
// not merely bound the seat's wl_seat global. Binding the global and creating
// the pointer are separate requests, and a toolkit can do the first without the
// second: Gecko binds every seat advertised to it but calls get_pointer only on
// the one seat it treats as "the" seat (seat0), so it binds the agent seat and
// has no pointer on it. Delivering through the agent seat to such a client
// reaches nothing and the event is dropped with no error - the "returns true,
// nothing lands" failure. The pointer's own seat is authoritative, via
// PointerInterface::get.
wl_iterator_result probeAgentSeatPointer(wl_resource *resource, void *data)
{
    auto *probe = static_cast<AgentSeatProbe *>(data);
    const char *klass = wl_resource_get_class(resource);
    if (klass && std::strcmp(klass, "wl_pointer") == 0) {
        if (PointerInterface *pointer = PointerInterface::get(resource); pointer && pointer->seat() == probe->seat) {
            probe->bound = true;
            return WL_ITERATOR_STOP;
        }
    }
    return WL_ITERATOR_CONTINUE;
}
}

bool SynaraComputerUsePlugin::clientHasAgentSeatPointer(const SurfaceInterface *surface) const
{
    if (!m_seat || !surface) {
        return false;
    }
    ClientConnection *connection = surface->client();
    if (!connection) {
        return false;
    }
    wl_client *client = connection->client();
    if (!client) {
        return false;
    }
    AgentSeatProbe probe{m_seat, false};
    wl_client_for_each_resource(client, probeAgentSeatPointer, &probe);
    return probe.bound;
}


namespace
{
struct ResourceCollector
{
    const char *klass;
    QList<wl_resource *> *out;
};

wl_iterator_result collectResource(wl_resource *resource, void *data)
{
    auto *collector = static_cast<ResourceCollector *>(data);
    const char *klass = wl_resource_get_class(resource);
    if (klass && std::strcmp(klass, collector->klass) == 0) {
        collector->out->append(resource);
        // Exactly one: a client can hold an input object of this class on more
        // than one seat — its own seat0 plus the agent seat it bound — and a
        // wl_keyboard/wl_pointer event written to every one of them is delivered
        // to the client that many times, so it types each character or fires
        // each click two-or-more times over. The client processes an event from
        // any one of its resources, so one delivery is both sufficient and
        // correct; more is a multiplier, never extra reach. Enter, key,
        // modifiers, button, axis, and leave all resolve to this same first
        // resource because resource iteration order is stable for the life of
        // the client, so the whole sequence lands on one coherent object.
        return WL_ITERATOR_STOP;
    }
    return WL_ITERATOR_CONTINUE;
}

/**
 * The single input resource of one class this client holds that the agent
 * injects into — the first the compositor iterates, deterministically.
 *
 * Injecting into every resource of the class instead delivers each event once
 * per resource, which is how driving a client that holds this object on both
 * seat0 and the bound agent seat produced quadrupled keystrokes. One is correct;
 * see collectResource.
 */
QList<wl_resource *> clientInputResources(const SurfaceInterface *surface, const char *klass)
{
    QList<wl_resource *> resources;
    if (!surface) {
        return resources;
    }
    ClientConnection *connection = surface->client();
    if (!connection) {
        return resources;
    }
    wl_client *client = connection->client();
    if (!client) {
        return resources;
    }
    ResourceCollector collector{klass, &resources};
    wl_client_for_each_resource(client, collectResource, &collector);
    return resources;
}

wl_iterator_result probeInputResource(wl_resource *resource, void *data)
{
    const char *klass = wl_resource_get_class(resource);
    if (klass && (std::strcmp(klass, "wl_pointer") == 0 || std::strcmp(klass, "wl_keyboard") == 0)) {
        *static_cast<bool *>(data) = true;
        return WL_ITERATOR_STOP;
    }
    return WL_ITERATOR_CONTINUE;
}

/** Whether this client holds a pointer or a keyboard at all, on any seat. */
bool clientHoldsInputResource(const SurfaceInterface *surface)
{
    if (!surface) {
        return false;
    }
    ClientConnection *connection = surface->client();
    if (!connection) {
        return false;
    }
    wl_client *client = connection->client();
    if (!client) {
        return false;
    }
    bool found = false;
    wl_client_for_each_resource(client, probeInputResource, &found);
    return found;
}

/**
 * Whole wheel clicks owed to a client too old for wl_pointer.axis_value120.
 *
 * That event carries only whole clicks, so any delta under one click truncates
 * to zero and a small scroll becomes a no-op in every client that acts on the
 * discrete event rather than the continuous one. The sub-click part is carried
 * in @p remainder instead, so repeated small deltas still add up to a click.
 */
int takeDiscreteSteps(double &remainder, double delta120)
{
    if (delta120 == 0) {
        return 0;
    }
    remainder += delta120;
    const double steps = std::trunc(remainder / 120.0);
    remainder -= steps * 120.0;
    return int(steps);
}

quint32 directTimestampMs()
{
    return quint32(std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now().time_since_epoch())
                       .count());
}

quint32 nextDirectSerial()
{
    return waylandServer() && waylandServer()->display() ? waylandServer()->display()->nextSerial() : 0;
}

/**
 * The surface the human's own seat is typing into, if any.
 *
 * Two callers with two different questions: the leave gating below, and the
 * human-active guard, which needs the window rather than the surface.
 */
SurfaceInterface *humanKeyboardSurface()
{
    SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
    return seat ? seat->focusedKeyboardSurface() : nullptr;
}

/**
 * seat0's pointer focus when it lies in the same client as @p surface, else
 * null.
 *
 * "Same client", not "same surface". A client holds one wl_pointer per seat,
 * shared by every window it owns, and Xwayland is one client for every X11
 * window on the desktop while a browser is one client for all of its windows.
 * The effective surface (PointerInterface::focusedSurface, a subsurface when
 * the pointer is over one) is what the client was actually told, so that is
 * what is compared and later re-sent. A null focus never matches: "nobody has
 * the pointer" must not read as "the human has this one".
 */
SurfaceInterface *humanPointerSurfaceInClientOf(const SurfaceInterface *surface)
{
    SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
    PointerInterface *pointer = seat ? seat->pointer() : nullptr;
    SurfaceInterface *focus = pointer ? pointer->focusedSurface() : nullptr;
    return surface && focus && focus->client() == surface->client() ? focus : nullptr;
}

/** The keyboard twin of humanPointerSurfaceInClientOf. */
SurfaceInterface *humanKeyboardSurfaceInClientOf(const SurfaceInterface *surface)
{
    SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
    KeyboardInterface *keyboard = seat ? seat->keyboard() : nullptr;
    SurfaceInterface *focus = keyboard ? keyboard->focusedSurface() : nullptr;
    return surface && focus && focus->client() == surface->client() ? focus : nullptr;
}

/**
 * The serial KWin recorded for seat0's current pointer enter.
 *
 * A re-sent enter has to carry exactly this one: the client answers an enter
 * with wl_pointer.set_cursor(serial), and KWin drops any set_cursor whose serial
 * is not the focused one, so a fresh serial would freeze the human's cursor
 * shape in that client from then on.
 */
quint32 humanPointerSerial()
{
    SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
    PointerInterface *pointer = seat ? seat->pointer() : nullptr;
    return pointer ? pointer->focusedSerial() : 0;
}

/**
 * Where seat0's pointer is, in the coordinates the client was told for
 * @p effective, its currently focused surface: the arithmetic of
 * SeatInterface::notifyPointerMotion, so a re-sent enter puts the pointer on
 * the pixel the human's own next motion will start from. Total: a re-sent
 * enter always carries a position, and when the seat's toplevel focus is
 * momentarily gone (its surface being destroyed) the effective surface stands
 * in for it.
 */
QPointF humanPointerClientPosition(SurfaceInterface *effective)
{
    SeatInterface *seat = waylandServer()->seat();
    SurfaceInterface *focus = seat->focusedPointerSurface();
    QPointF local = seat->focusedPointerSurfaceTransformation().map(seat->pointerPos());
    if (focus && focus != effective) {
        local = focus->mapToChild(effective, local);
    }
    return effective->toSurfaceLocal(local);
}

/** The xkb state of the human's real keyboard: what seat0 last told clients. */
const Xkb *humanXkb()
{
    return input() && input()->keyboard() ? input()->keyboard()->xkb() : nullptr;
}
}

/**
 * The window seat0 has keyboard focus on.
 *
 * Resolved through the workspace rather than `WaylandServer::findWindow`, which
 * only knows the windows it registered itself: an Xwayland client's surface is
 * focusable by the human and would come back as no window at all, which is the
 * one answer this must never give.
 */
Window *SynaraComputerUsePlugin::humanFocusWindow() const
{
    // There is no second seat in a compositor the agent owns - seat0 is the
    // agent's - so there is no human focus to report.
    if (m_ownsCompositor || !Workspace::self()) {
        return nullptr;
    }
    const SurfaceInterface *surface = humanKeyboardSurface();
    if (!surface) {
        return nullptr;
    }
    return Workspace::self()->findWindow([surface](const Window *window) {
        return window->surface() == surface;
    });
}

qint64 SynaraComputerUsePlugin::humanInputAgeMilliseconds() const
{
    return m_humanInputSpy ? m_humanInputSpy->ageMilliseconds() : -1;
}

qint64 SynaraComputerUsePlugin::humanPointerAgeMilliseconds() const
{
    return m_humanInputSpy ? m_humanInputSpy->pointerAgeMilliseconds() : -1;
}

qint64 SynaraComputerUsePlugin::humanKeyboardAgeMilliseconds() const
{
    return m_humanInputSpy ? m_humanInputSpy->keyboardAgeMilliseconds() : -1;
}

/**
 * Injection straight into one client's own input resources.
 *
 * This is the mechanism the macOS version uses, expressed in Wayland terms: hand
 * the events to the target process, stamped with window-local coordinates, and
 * leave the shared pointer alone. It exists because the agent seat cannot reach
 * Chromium or Xwayland, which bind the first seat the compositor advertises and
 * ignore every later one. Those clients did bind seat0, so their wl_pointer and
 * wl_keyboard resources are right there; we write to them without going through
 * SeatInterface, which is what would move the human's focus.
 *
 * KWin does not know these events happened, which is the point and also the
 * whole cost. The objects written to are the very ones KWin delivers the
 * human's input on, and a client keeps exactly ONE "entered" surface per
 * object: whichever surface the last enter named. wl_pointer.motion,
 * wl_pointer.button, wl_keyboard.key and wl_keyboard.modifiers name no surface;
 * the client routes them to that entered surface. So an enter the agent sends
 * for its target B silently re-routes the human's next motion or keystroke -
 * which KWin delivers without a new enter, because KWin still believes the
 * object is in their window A - into B. Every X11 window on the desktop is one
 * Xwayland client, and every window of a browser is one client, so "another
 * window" is not "another client".
 *
 * THE INVARIANT this file keeps: at every moment KWin could deliver a human
 * event, each client's seat0 objects name the surface KWin's seat0 has
 * focused. The agent may borrow an object only inside one synchronous D-Bus
 * call on the compositor thread (a burst, DirectInjectionScope), and hands it
 * back before the call returns - by re-sending seat0's real enter and
 * modifiers - whenever seat0's focus of that kind is on any surface of the same
 * client (restoreHumanDelivery, directPointerLeave, directKeyboardLeave). When
 * seat0 is on another client entirely the object carries no human events, so
 * the agent's enter may persist across calls and hover state and
 * press-move-release drags survive, until seat0 moves into that client; KWin's
 * own enter then supersedes ours, which handleHumanPointerFocusChanged and
 * handleHumanKeyboardFocusAboutToChange observe. Two rules follow: plain motion
 * never borrows a shared object at all (the enter is deferred to the action),
 * and while the human is actively using the client even a restored burst
 * disturbs them - their window sees a focus-out/in or a pointer leave/enter -
 * so the action is refused instead (humanConflict).
 */
bool SynaraComputerUsePlugin::usePointerDirectInjection(const Window *window) const
{
    if (m_ownsCompositor || !window) {
        return false;
    }
    // Pointer path by where the pointer *object* lives, not by seat binding. The
    // agent-seat pointer path can only reach a client that created a wl_pointer
    // on the agent seat; a client that bound the seat but put its pointer on
    // seat0 (Gecko does this) would be delivered nothing and never know. So the
    // agent seat is used only when the client is provably reachable through it,
    // and everything else - Chromium, Electron, Xwayland, and Gecko's pointer -
    // is driven by writing to its own pointer resource directly. A wrong guess
    // can only route a client to direct injection, which works for any
    // conformant client, so it never costs reach.
    return !clientHasAgentSeatPointer(window->surface());
}

/**
 * Enters the agent's target on the client's own pointer, or moves within it.
 *
 * The coordinates follow KWin's own arithmetic for a pointer event: the
 * window's input transformation, then the input-accepting subsurface under the
 * point, then the surface's own scale (toSurfaceLocal, which is where an
 * Xwayland scale override lives).
 *
 * If seat0's pointer is in this very client, the object is handed over the way
 * KWin itself would hand it over: a leave for the human's surface first, then
 * the enter. If seat0 is in this very surface, the object already names it and
 * only the position is ours to move, so no enter goes out at all and the
 * matching leave (directPointerLeave) is a motion back to where the human's
 * pointer rests.
 */
void SynaraComputerUsePlugin::directPointerEnter(Window *window)
{
    SurfaceInterface *root = window ? window->surface() : nullptr;
    if (!root) {
        return;
    }
    auto [surface, local] = root->mapToInputSurface(window->inputTransformation().map(m_pos));
    if (!surface) {
        surface = root;
    }
    const QPointF position = surface->toSurfaceLocal(local);
    if (m_directPointerSurface && m_directPointerSurface != surface) {
        directPointerLeave();
    }

    const QList<wl_resource *> resources = clientInputResources(surface, "wl_pointer");
    if (m_directPointerSurface != surface) {
        SurfaceInterface *human = humanPointerSurfaceInClientOf(surface);
        m_directPointerSurface = surface;
        if (human != surface) {
            const quint32 serial = nextDirectSerial();
            for (wl_resource *resource : resources) {
                if (human) {
                    wl_pointer_send_leave(resource, serial, human->resource());
                }
                wl_pointer_send_enter(resource,
                                      serial,
                                      surface->resource(),
                                      wl_fixed_from_double(position.x()),
                                      wl_fixed_from_double(position.y()));
            }
        }
    }

    for (wl_resource *resource : resources) {
        wl_pointer_send_motion(resource, directTimestampMs(), wl_fixed_from_double(position.x()), wl_fixed_from_double(position.y()));
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION) {
            wl_pointer_send_frame(resource);
        }
    }
}

/**
 * Withdraws the agent's enter and leaves the client's pointer in the human's
 * state, whatever that is.
 *
 * Three cases. seat0's pointer is in this very surface: the enter the client
 * believes in is seat0's, not ours to revoke, and nothing goes out - the
 * client's pointer stays where the agent last moved it, and the human's next
 * motion is absolute and puts it right. (A motion "back" to the human's
 * resting position would be a pointer jump the client reads as a drag when a
 * button is down, and a spurious hover move when none is.) seat0's pointer is
 * in a sibling surface of the same client: our leave, then seat0's own enter
 * re-sent - with the serial KWin recorded for it (humanPointerSerial) and the
 * position KWin would send - so the human's next motion lands where KWin
 * believes it will. seat0 is elsewhere: just our leave.
 *
 * Never called with a button held on a shared object except by the paths that
 * release first (handleHumanPointerInput, handleHumanPointerFocusChanged,
 * clearPointerDelivery): a press and its release have to reach one entered
 * surface, and each is its own D-Bus call.
 */
void SynaraComputerUsePlugin::directPointerLeave()
{
    SurfaceInterface *surface = m_directPointerSurface;
    m_directPointerSurface.clear();
    if (!surface) {
        return;
    }
    SurfaceInterface *human = humanPointerSurfaceInClientOf(surface);
    if (human == surface) {
        return;
    }
    const quint32 serial = nextDirectSerial();
    const quint32 humanSerial = humanPointerSerial();
    for (wl_resource *resource : clientInputResources(surface, "wl_pointer")) {
        wl_pointer_send_leave(resource, serial, surface->resource());
        if (human) {
            const QPointF position = humanPointerClientPosition(human);
            wl_pointer_send_enter(resource,
                                  humanSerial,
                                  human->resource(),
                                  wl_fixed_from_double(position.x()),
                                  wl_fixed_from_double(position.y()));
        }
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION) {
            wl_pointer_send_frame(resource);
        }
    }
}

/**
 * Makes sure the agent's pointer window holds a direct enter before an event
 * that needs one, re-entering it when the object was handed back to the human
 * or KWin moved seat0 through this client since the last event.
 */
bool SynaraComputerUsePlugin::ensureDirectPointerEnter()
{
    if (m_directPointerSurface) {
        return true;
    }
    Window *window = m_pointerWindow;
    if (!m_pointerDirect || !window || !window->surface()) {
        return false;
    }
    directPointerEnter(window);
    return !m_directPointerSurface.isNull();
}

void SynaraComputerUsePlugin::directPointerButton(quint32 code, bool pressed)
{
    if (!ensureDirectPointerEnter()) {
        return;
    }
    SurfaceInterface *surface = m_directPointerSurface;
    // Minted inside the burst, so it is recorded as the agent's: a popup the
    // press opens asks for its grab with it (handlePopupGrab).
    const quint32 serial = nextDirectSerial();
    const quint32 time = directTimestampMs();
    for (wl_resource *resource : clientInputResources(surface, "wl_pointer")) {
        wl_pointer_send_button(resource,
                               serial,
                               time,
                               code,
                               pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION) {
            wl_pointer_send_frame(resource);
        }
    }
}

void SynaraComputerUsePlugin::directPointerAxis(double horizontal, double vertical)
{
    if (!ensureDirectPointerEnter()) {
        return;
    }
    SurfaceInterface *surface = m_directPointerSurface;
    const quint32 time = directTimestampMs();
    const QList<wl_resource *> resources = clientInputResources(surface, "wl_pointer");
    const int horizontalV120 = scrollValue120(horizontal);
    const int verticalV120 = scrollValue120(vertical);

    // The remainder is only spent on resources that cannot be told about a
    // fraction of a click, so it is only taken when the client has one. Taking it
    // unconditionally would leave a value120-only client carrying a balance it
    // can never use, and hand the next old client a click it did not scroll.
    const bool needsDiscrete = std::any_of(resources.cbegin(), resources.cend(), [](wl_resource *resource) {
        const int version = wl_resource_get_version(resource);
        return version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && version < WL_POINTER_AXIS_VALUE120_SINCE_VERSION;
    });
    const int horizontalSteps = needsDiscrete ? takeDiscreteSteps(m_directAxisRemainderH, horizontalV120) : 0;
    const int verticalSteps = needsDiscrete ? takeDiscreteSteps(m_directAxisRemainderV, verticalV120) : 0;

    for (wl_resource *resource : resources) {
        const int version = wl_resource_get_version(resource);
        if (version >= WL_POINTER_AXIS_SOURCE_SINCE_VERSION) {
            wl_pointer_send_axis_source(resource, WL_POINTER_AXIS_SOURCE_WHEEL);
        }
        if (horizontal != 0) {
            wl_pointer_send_axis(resource,
                                 time,
                                 WL_POINTER_AXIS_HORIZONTAL_SCROLL,
                                 wl_fixed_from_double(scrollAxisValue(horizontal)));
            // value120 supersedes axis_discrete for the clients that have it, and
            // the two must not both be sent for one scroll.
            if (version >= WL_POINTER_AXIS_VALUE120_SINCE_VERSION) {
                wl_pointer_send_axis_value120(resource, WL_POINTER_AXIS_HORIZONTAL_SCROLL, horizontalV120);
            } else if (version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && horizontalSteps != 0) {
                wl_pointer_send_axis_discrete(resource, WL_POINTER_AXIS_HORIZONTAL_SCROLL, horizontalSteps);
            }
        }
        if (vertical != 0) {
            wl_pointer_send_axis(resource,
                                 time,
                                 WL_POINTER_AXIS_VERTICAL_SCROLL,
                                 wl_fixed_from_double(scrollAxisValue(vertical)));
            if (version >= WL_POINTER_AXIS_VALUE120_SINCE_VERSION) {
                wl_pointer_send_axis_value120(resource, WL_POINTER_AXIS_VERTICAL_SCROLL, verticalV120);
            } else if (version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && verticalSteps != 0) {
                wl_pointer_send_axis_discrete(resource, WL_POINTER_AXIS_VERTICAL_SCROLL, verticalSteps);
            }
        }
        if (version >= WL_POINTER_FRAME_SINCE_VERSION) {
            wl_pointer_send_frame(resource);
        }
    }
}

namespace
{
/** wl_keyboard.enter's array of held keys, from any list of evdev codes. */
struct HeldKeysArray
{
    explicit HeldKeysArray(const QList<quint32> &keys)
    {
        wl_array_init(&array);
        for (quint32 key : keys) {
            if (auto *slot = static_cast<quint32 *>(wl_array_add(&array, sizeof(quint32)))) {
                *slot = key;
            }
        }
    }
    ~HeldKeysArray()
    {
        wl_array_release(&array);
    }
    Q_DISABLE_COPY_MOVE(HeldKeysArray)
    wl_array array;
};
}

/**
 * Enters the agent's target on the client's own keyboard.
 *
 * The keyboard twin of directPointerEnter: if seat0's keyboard is in this
 * client, the object is handed over with a leave for the human's surface
 * first; if it is in this very surface, only the modifier state becomes the
 * agent's. No keymap is sent, and none is needed: the client bound seat0 and
 * already has that seat's keymap, which the agent's xkb state mirrors.
 */
void SynaraComputerUsePlugin::directKeyboardEnter(Window *window)
{
    SurfaceInterface *surface = window ? window->surface() : nullptr;
    if (!surface) {
        return;
    }
    if (m_directKeyboardSurface == surface) {
        return;
    }
    if (m_directKeyboardSurface) {
        directKeyboardLeave();
    }
    SurfaceInterface *human = humanKeyboardSurfaceInClientOf(surface);
    m_directKeyboardSurface = surface;
    if (human != surface) {
        HeldKeysArray keys(m_pressedKeys);
        const quint32 serial = nextDirectSerial();
        for (wl_resource *resource : clientInputResources(surface, "wl_keyboard")) {
            if (human) {
                wl_keyboard_send_leave(resource, serial, human->resource());
            }
            wl_keyboard_send_enter(resource, serial, surface->resource(), &keys.array);
        }
    }
    directKeyboardModifiers();
}

/**
 * Withdraws the agent's enter and leaves the client's keyboard in the human's
 * state: seat0's own enter re-sent, carrying the keys KWin knows the human
 * holds, and seat0's real modifiers - or, when seat0 is in this very surface
 * and the enter was never ours, the modifiers alone.
 */
void SynaraComputerUsePlugin::directKeyboardLeave()
{
    SurfaceInterface *surface = m_directKeyboardSurface;
    m_directKeyboardSurface.clear();
    if (!surface) {
        return;
    }
    SurfaceInterface *human = humanKeyboardSurfaceInClientOf(surface);
    if (human != surface) {
        const QList<quint32> humanKeys = human && input() && input()->keyboard() ? input()->keyboard()->unfilteredKeys() : QList<quint32>();
        HeldKeysArray keys(humanKeys);
        // A fresh serial for the re-sent human enter, unlike the pointer's:
        // KeyboardInterface keeps its enter serial private. It is harmless
        // where a client quotes an enter serial back - set_selection is
        // accepted for any serial not older than the current selection's, and
        // xdg_activation validates tokens against the last key or button
        // press, never the enter - so nothing KWin checks can disagree with it.
        const quint32 serial = nextDirectSerial();
        for (wl_resource *resource : clientInputResources(surface, "wl_keyboard")) {
            wl_keyboard_send_leave(resource, serial, surface->resource());
            if (human) {
                wl_keyboard_send_enter(resource, serial, human->resource(), &keys.array);
            }
        }
    }
    if (human) {
        sendHumanKeyboardModifiers(human);
    }
}

/** The keyboard twin of ensureDirectPointerEnter. */
bool SynaraComputerUsePlugin::ensureDirectKeyboardEnter()
{
    if (m_directKeyboardSurface) {
        return true;
    }
    Window *window = m_keyboardWindow;
    if (!m_keyboardDirect || !window || !window->surface()) {
        return false;
    }
    directKeyboardEnter(window);
    return !m_directKeyboardSurface.isNull();
}

void SynaraComputerUsePlugin::directKeyboardKey(quint32 keyCode, bool pressed)
{
    SurfaceInterface *surface = m_directKeyboardSurface;
    if (!surface) {
        return;
    }
    const quint32 serial = nextDirectSerial();
    const quint32 time = directTimestampMs();
    for (wl_resource *resource : clientInputResources(surface, "wl_keyboard")) {
        wl_keyboard_send_key(resource,
                             serial,
                             time,
                             keyCode,
                             pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
    }
}

/**
 * The agent's modifier state, as the client's seat0 keyboard should hold it
 * while the agent has that object.
 *
 * Depressed and latched are the agent's alone: its Shift is not the human's
 * Shift and the other way round, exactly as on the agent seat. The human's
 * locked modifiers are merged in, because CapsLock and NumLock are properties
 * of the keyboard the client believes it is hearing and stateJson.capsLockOn
 * reports the merged state so the server's Shift decisions match. The group is
 * the agent's, whose keys are synthesised for the first layout of the keymap
 * (see keyboardLayout in stateJson) whatever layout the human has switched to.
 * The human's own state comes back with the leave (sendHumanKeyboardModifiers).
 */
void SynaraComputerUsePlugin::directKeyboardModifiers()
{
    SurfaceInterface *surface = m_directKeyboardSurface;
    if (!surface || !m_xkbState) {
        return;
    }
    const quint32 serial = nextDirectSerial();
    const quint32 depressed = xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_DEPRESSED);
    const quint32 latched = xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_LATCHED);
    quint32 locked = xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_LOCKED);
    const quint32 group = xkb_state_serialize_layout(m_xkbState, XKB_STATE_LAYOUT_EFFECTIVE);
    if (const Xkb *xkb = humanXkb()) {
        locked |= xkb->modifierState().locked;
    }
    for (wl_resource *resource : clientInputResources(surface, "wl_keyboard")) {
        wl_keyboard_send_modifiers(resource, serial, depressed, latched, locked, group);
    }
}

/**
 * Re-sends seat0's real modifier state to this client, through KWin's own
 * per-client path, so the delivery is exactly what KWin sends on its next
 * change and lands on every seat0 keyboard the client holds.
 */
void SynaraComputerUsePlugin::sendHumanKeyboardModifiers(SurfaceInterface *surface)
{
    SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
    KeyboardInterface *keyboard = seat ? seat->keyboard() : nullptr;
    const Xkb *xkb = humanXkb();
    if (!keyboard || !xkb || !surface || !surface->client()) {
        return;
    }
    const auto &modifiers = xkb->modifierState();
    keyboard->sendModifiers(modifiers.depressed, modifiers.latched, modifiers.locked, xkb->currentLayout(), surface->client());
}

quint32 SynaraComputerUsePlugin::displaySerial() const
{
    return waylandServer() && waylandServer()->display() ? waylandServer()->display()->serial() : 0;
}

/**
 * Records the serials one burst minted as the agent's. Bursts that follow each
 * other with nothing minted in between share a range, so a long run of typing
 * costs one slot; the ring keeps the most recent 512 of them.
 */
void SynaraComputerUsePlugin::noteAgentBurst(quint32 after, quint32 last)
{
    if (after == last) {
        return;
    }
    if (m_agentBurstCount > 0) {
        SynaraSerialBurst &previous = m_agentBursts[(m_agentBurstNext + m_agentBursts.size() - 1) % m_agentBursts.size()];
        if (previous.last == after) {
            previous.last = last;
            return;
        }
    }
    m_agentBursts[m_agentBurstNext] = {after, last};
    m_agentBurstNext = (m_agentBurstNext + 1) % m_agentBursts.size();
    m_agentBurstCount = std::min(m_agentBurstCount + 1, m_agentBursts.size());
}

bool SynaraComputerUsePlugin::agentMintedSerial(quint32 serial) const
{
    for (size_t i = 0; i < m_agentBurstCount; ++i) {
        if (serialInBurst(serial, m_agentBursts[i])) {
            return true;
        }
    }
    return false;
}

/**
 * xdg_activation on the human's desktop: KWin's own token rule, except that a
 * serial the agent minted never counts as the human's interaction.
 *
 * KWin grants a token for any serial at or after the last interaction it saw
 * on a real device (XdgActivationV1Integration::requestToken:
 * `lastInteractionSerial() <= serial`), or for any serial at all when the
 * request comes from the active window, and activates the window that
 * presents it while nothing newer happened (Workspace::mayActivate:
 * `lastInteractionSerial() <= tokenSerial`). Every event the agent sends - on
 * either path - carries a fresh display serial, newer than anything the
 * human did, so a client could turn the agent's click into real activation:
 * measured on KWin 6.7.4, Chromium answers a click into one of its windows by
 * requesting a token with that click's serial while another of its windows
 * has the human's focus, KWin granted it, and seat0's keyboard - the human's -
 * moved to the agent's window.
 *
 * So the creator is replaced by one that refuses a token quoting the agent
 * seat or a serial one of the agent's bursts minted, and otherwise makes
 * KWin's decision and hands the token out through KWin's integration
 * (requestPrivilegedToken, then the client's own serial for an unprivileged
 * request, which is what KWin stores). Nothing the agent does moves KWin's
 * last interaction, so a launch the human started - Kickoff, KRunner, a link
 * - still activates when its window maps in the middle of the agent's work.
 * A compositor the agent owns has no human focus to protect and keeps KWin's
 * creator.
 */
void SynaraComputerUsePlugin::installActivationTokenCreator()
{
    if (m_ownsCompositor || !waylandServer() || !waylandServer()->xdgActivationIntegration()) {
        return;
    }
    // Owned by the WaylandServer; a plugin has no other way to reach it.
    m_activation = waylandServer()->findChild<XdgActivationV1Interface *>();
    if (!m_activation) {
        return;
    }
    m_activation->setActivationTokenCreator([this](ClientConnection *client, SurfaceInterface *surface, uint serial, SeatInterface *seat, const QString &appId) {
        return createActivationToken(client, surface, serial, seat, appId);
    });
    // The newest instance owns the creator: during a versioned reload the old
    // one unloads after the new one has installed its own.
    m_activation->setProperty(s_activationOwnerProperty, QVariant::fromValue<QObject *>(this));
}

/**
 * Puts KWin's own creator back before this plugin's code is unloaded. KWin
 * keeps no handle to its original, so a fresh XdgActivationV1Integration - code
 * that lives in KWin - installs it, and its activation handler is cut so the
 * original integration stays the one that activates surfaces. A token object
 * a client created while this creator was installed and has not committed yet
 * keeps a copy of it; KWin copies the creator into every token, and nothing
 * outside KWin can reach those.
 */
void SynaraComputerUsePlugin::restoreActivationTokenCreator()
{
    if (!m_activation || m_activation->property(s_activationOwnerProperty).value<QObject *>() != this) {
        return;
    }
    m_activation->setProperty(s_activationOwnerProperty, QVariant());
    if (!waylandServer() || !Workspace::self()) {
        return;
    }
    auto *kwinCreator = new XdgActivationV1Integration(m_activation, waylandServer());
    QObject::disconnect(m_activation, &XdgActivationV1Interface::activateRequested, kwinCreator, nullptr);
}

QString SynaraComputerUsePlugin::createActivationToken(ClientConnection *client, SurfaceInterface *surface, uint serial, SeatInterface *seat, const QString &appId)
{
    XdgActivationV1Integration *integration = waylandServer() ? waylandServer()->xdgActivationIntegration() : nullptr;
    Workspace *workspace = Workspace::self();
    if (!integration || !workspace || !input()) {
        return s_notGrantedToken;
    }
    const bool privileged = client && isPrivilegedInWindowManagement(client);
    const bool agentSerial = (m_seat && seat == m_seat) || agentMintedSerial(serial);
    const Window *active = workspace->activeWindow();
    const bool fromActiveWindow = !active || (surface && active->surface() == surface);
    if (!activationTokenGranted(agentSerial, privileged, fromActiveWindow, input()->lastInteractionSerial(), serial, displaySerial())) {
        ++m_activationTokensRefused;
        return s_notGrantedToken;
    }
    const QString token = integration->requestPrivilegedToken(surface, serial, seat, appId);
    if (!privileged) {
        // requestPrivilegedToken stored KWin's last interaction as the token's
        // serial; an unprivileged request keeps its own, as in KWin.
        workspace->setActivationToken(token, serial, appId);
    }
    return token;
}

/**
 * Hands borrowed seat0 objects back at the end of a burst; see the invariant
 * above usePointerDirectInjection. Only an object the human's seat is using in
 * that client is handed back; an enter on a client seat0 is nowhere near
 * carries no human events and persists, so hover state and press-move-release
 * drags survive ordinary agent motion.
 *
 * Never with a button or key still held on the object. A press and its
 * release are separate D-Bus calls (the server holds a click for 20 ms, and a
 * Shift+key chord is four calls), and a gesture has to land on one entered
 * surface: a leave with a button down is a lost press or a cancelled drag to
 * most toolkits, and Xwayland answers a keyboard leave by releasing every held
 * key and the next enter by re-pressing its keys array, which typed a chord's
 * letters twice. So a held object stays borrowed across calls, and is handed
 * back by whichever comes first: the release that empties the held set, the
 * human's own next event of that class (handleHumanPointerInput,
 * handleHumanKeyboardInput - the spy runs before KWin delivers it, so the
 * release lands first and their event is still routed right), or seat0 moving
 * through the client (the focus-change handlers).
 */
void SynaraComputerUsePlugin::restoreHumanDelivery()
{
    if (m_directPointerSurface && m_pressedButtons.isEmpty() && humanPointerSurfaceInClientOf(m_directPointerSurface)) {
        directPointerLeave();
    }
    if (m_directKeyboardSurface && m_pressedKeys.isEmpty() && humanKeyboardSurfaceInClientOf(m_directKeyboardSurface)) {
        directKeyboardLeave();
    }
}

/**
 * The human's pointer, touch or tablet produced an event, and KWin is about to
 * deliver it to seat0's focus. If the agent still holds a client's pointer
 * object the human's seat shares - which after restoreHumanDelivery means a
 * button is down mid-gesture - the buttons are released on the agent's surface
 * and the object handed back now, before the human's event reaches the client,
 * so it is routed to their window rather than dragged through the agent's.
 */
void SynaraComputerUsePlugin::handleHumanPointerInput()
{
    SurfaceInterface *agent = m_directPointerSurface;
    if (!agent || !humanPointerSurfaceInClientOf(agent)) {
        return;
    }
    DirectInjectionScope scope(this);
    releasePressedButtons();
    directPointerLeave();
}

/** The keyboard twin of handleHumanPointerInput. */
void SynaraComputerUsePlugin::handleHumanKeyboardInput()
{
    SurfaceInterface *agent = m_directKeyboardSurface;
    if (!agent || !humanKeyboardSurfaceInClientOf(agent)) {
        return;
    }
    DirectInjectionScope scope(this);
    releasePressedKeys();
    directKeyboardLeave();
}

void SynaraComputerUsePlugin::watchHumanSeat()
{
    SeatInterface *seat = !m_ownsCompositor && waylandServer() ? waylandServer()->seat() : nullptr;
    if (!seat) {
        return;
    }
    connect(seat, &SeatInterface::focusedKeyboardSurfaceAboutToChange, this, &SynaraComputerUsePlugin::handleHumanKeyboardFocusAboutToChange);
    // The PointerInterface is created and destroyed with the seat's pointer
    // capability (unplug every mouse and it goes away), so the connection
    // follows it rather than the seat.
    connect(seat, &SeatInterface::hasPointerChanged, this, &SynaraComputerUsePlugin::watchHumanPointer);
    watchHumanPointer();
}

void SynaraComputerUsePlugin::watchHumanPointer()
{
    SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
    PointerInterface *pointer = seat ? seat->pointer() : nullptr;
    if (!pointer || m_watchedHumanPointer == pointer) {
        return;
    }
    m_watchedHumanPointer = pointer;
    m_humanPointerFocus = pointer->focusedSurface();
    connect(pointer, &PointerInterface::focusedSurfaceChanged, this, &SynaraComputerUsePlugin::handleHumanPointerFocusChanged);
}

/**
 * seat0's pointer focus changed. Emitted after KWin's leave and enter went out,
 * and the signal carries no payload, so the previous focus is remembered here.
 *
 * When seat0 entered or left a surface of the client the agent is entered on,
 * that happened on the very object the agent's enter lived on: the client now
 * believes KWin's enter (or nothing), and ours is void - not revoked with a
 * leave, because the enter the client holds is not ours. Buttons the agent
 * holds were pressed on its surface, and a press nobody releases stays down in
 * that client for good, so they are released first: the release burst
 * re-stamps the agent's enter for them and hands the object straight back to
 * seat0's surface. Sub-notch scroll owed to the old enter goes with it. Focus
 * changes between other clients are left alone, so hover on the target
 * survives ordinary agent motion.
 */
void SynaraComputerUsePlugin::handleHumanPointerFocusChanged()
{
    SurfaceInterface *previous = m_humanPointerFocus;
    SurfaceInterface *current = m_watchedHumanPointer ? m_watchedHumanPointer->focusedSurface() : nullptr;
    m_humanPointerFocus = current;
    SurfaceInterface *agent = m_directPointerSurface;
    if (!agent) {
        return;
    }
    const ClientConnection *client = agent->client();
    const bool touchesAgentClient = (previous && previous->client() == client) || (current && current->client() == client);
    if (!touchesAgentClient) {
        return;
    }
    DirectInjectionScope scope(this);
    m_directPointerSurface.clear();
    m_directAxisRemainderH = 0;
    m_directAxisRemainderV = 0;
    releasePressedButtons();
}

/**
 * seat0's keyboard focus is about to change. Emitted before KWin sends its
 * leave and enter, so the client's object still names the agent's surface when
 * this runs: keys the agent holds are released there, where they were pressed,
 * and the agent's enter is withdrawn so KWin's enter lands on an object in the
 * human's state. Nothing is re-stamped afterwards; the next key re-enters.
 */
void SynaraComputerUsePlugin::handleHumanKeyboardFocusAboutToChange(SurfaceInterface *nextSurface)
{
    // The human is moving into another window of the application the agent
    // borrowed activation in: give it back first, or the client is told two
    // of its windows are active and may hand the agent's one their focus.
    if (Window *borrowed = m_activatedWindow; borrowed && borrowed->surface() && nextSurface
        && nextSurface->client() == borrowed->surface()->client() && nextSurface != borrowed->surface()) {
        clearWindowActivation();
    }
    SurfaceInterface *agent = m_directKeyboardSurface;
    if (!agent) {
        return;
    }
    SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
    KeyboardInterface *keyboard = seat ? seat->keyboard() : nullptr;
    SurfaceInterface *previous = keyboard ? keyboard->focusedSurface() : nullptr;
    const ClientConnection *client = agent->client();
    const bool touchesAgentClient = (nextSurface && nextSurface->client() == client) || (previous && previous->client() == client);
    if (!touchesAgentClient) {
        return;
    }
    DirectInjectionScope scope(this);
    releasePressedKeys();
    directKeyboardLeave();
}

/**
 * Hands every shared object back to the human and forgets the explicit target,
 * for the moment the desktop lease changes hands. Works whether or not a
 * session is running: a lease changing owner must always leave the human's
 * seat objects in the human's state, and the next holder starts from nothing -
 * no target, no held keys or buttons, no enter it did not send itself. Not
 * agent activity, so the idle deadline is untouched.
 */
bool SynaraComputerUsePlugin::resetInputDelivery()
{
    if (!m_auth.permits(*this)) return false;
    DirectInjectionScope scope(this);
    m_targetWindow.clear();
    m_targetRequested = false;
    releasePressedState();
    clearPointerDelivery();
    clearKeyboardFocus();
    // The two clears take the leaves of whichever path each window was on; an
    // enter that outlived its window (the QPointer to the window cleared but
    // the surface's client is still there) is withdrawn here.
    directPointerLeave();
    directKeyboardLeave();
    if (m_seat) {
        m_seat->notifyPointerLeave();
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
    // The next holder starts from nothing, and that includes a menu the last
    // one left open.
    dismissAgentPopups([](const Window *) {
        return true;
    });
    return true;
}

/**
 * Agent-opened popups on the human's desktop: why their grab is withheld.
 *
 * KWin ignores the seat in xdg_popup.grab (XdgPopupWindow::handleGrabRequested
 * drops it), and PopupInputFilter treats every grabbing popup as seat0's: the
 * moment one maps it moves seat0's keyboard focus onto it, every key the human
 * presses is delivered to it, and their next press outside the popup's
 * application is swallowed to dismiss it (KWin 6.7.4 popup_input_filter.cpp).
 * So a menu the agent opened in Chromium took the keys of a human typing in
 * Kate - Enter activated a menu item - and ate their next click. That holds for
 * both of the agent's paths: an agent-seat client grabs with the agent seat,
 * which KWin ignores, and a directly driven client grabs with seat0.
 *
 * The plugin therefore never lets an agent popup grab. The filter only takes
 * a popup whose window reports a grab when it maps, and the window records one
 * only through its grabRequested connection, so the popup is attributed when
 * it is created - before the client can ask for a grab - and an agent popup
 * has that connection cut. It then behaves as a popup without a grab: seat0's
 * focus stays where the human put it, their keys go where they were going,
 * and every click reaches what it lands on. The two things the grab did for
 * the popup are done here instead: a human press anywhere outside the agent's
 * popups dismisses them (and is delivered, not eaten), and so does an agent
 * press on another application, which is what the grab would have done for
 * the agent. The agent's session ending or changing hands dismisses them too.
 * Toolkits route key navigation to an open menu themselves, so the agent's
 * keys still reach the menu through the window that opened it.
 *
 * Whether to cut the connection is guessed at creation, by who pressed into
 * that client last - the agent (on either path) or the human - or by the
 * parent popup when this is a submenu. The popup becomes the agent's only
 * when its grab request arrives and is checked against the exact answer: the
 * agent seat, or a serial one of the agent's bursts minted. A popup that
 * never asks for a grab (a tooltip, an autocomplete list) is left alone, and
 * a mismatch either way dismisses the popup, which the agent or the human
 * simply reopens: a grab never reaches the filter for an agent popup, and a
 * human popup is never left without the grab it asked for.
 */
void SynaraComputerUsePlugin::watchPopups()
{
    if (m_ownsCompositor || !waylandServer()) {
        return;
    }
    // Owned by XdgShellIntegration, a child of the WaylandServer; there is no
    // other way to reach it from a plugin.
    XdgShellInterface *shell = waylandServer()->findChild<XdgShellInterface *>();
    if (!shell) {
        return;
    }
    // Connected after XdgShellIntegration's own handler, so the XdgPopupWindow
    // exists and has made its grabRequested connection by the time this runs.
    connect(shell, &XdgShellInterface::popupCreated, this, &SynaraComputerUsePlugin::handlePopupCreated);
}

void SynaraComputerUsePlugin::handlePopupCreated(XdgPopupInterface *popup)
{
    Window *window = popup && waylandServer() ? waylandServer()->findWindow(popup->surface()) : nullptr;
    if (!window) {
        return;
    }
    PopupOwner parent = PopupOwner::Unknown;
    Window *parentWindow = popup->parentSurface() ? waylandServer()->findWindow(popup->parentSurface()) : nullptr;
    if (parentWindow && parentWindow->isPopupWindow()) {
        parent = isAgentPopup(parentWindow) ? PopupOwner::Agent : PopupOwner::Human;
    }
    const ClientConnection *client = popup->surface() ? popup->surface()->client() : nullptr;
    const qint64 agentAge = client && m_lastAgentPressClient == client && m_lastAgentPress.isValid() ? m_lastAgentPress.elapsed() : -1;
    const qint64 humanAge = client && m_lastHumanPressClient == client && m_lastHumanPress.isValid() ? m_lastHumanPress.elapsed() : -1;
    if (popupOpenedByAgent(parent, agentAge, humanAge)) {
        // Cut now, before the client can ask: whose popup it is waits for the
        // grab request, and one that never asks - a tooltip, an autocomplete
        // list - is nobody's to dismiss.
        QObject::disconnect(popup, &XdgPopupInterface::grabRequested, window, nullptr);
        m_withheldGrabPopups.removeAll(nullptr);
        m_withheldGrabPopups.append(window);
        connect(window, &Window::closed, this, [this, window]() {
            m_withheldGrabPopups.removeAll(window);
            m_agentPopups.removeAll(window);
        });
    }
    // The window can be gone before the client asks for its grab (a popup
    // destroyed before its first commit), so it is held weakly.
    connect(popup, &XdgPopupInterface::grabRequested, this, [this, window = QPointer<Window>(window)](SeatInterface *seat, quint32 serial) {
        if (window && !window->isDeleted()) {
            handlePopupGrab(window, seat, serial);
        }
    });
}

void SynaraComputerUsePlugin::handlePopupGrab(Window *window, SeatInterface *seat, quint32 serial)
{
    const bool agentGrab = (m_seat && seat == m_seat) || agentMintedSerial(serial);
    const bool withheld = std::any_of(m_withheldGrabPopups.cbegin(), m_withheldGrabPopups.cend(), [window](const QPointer<Window> &popup) {
        return popup == window;
    });
    if (agentGrab && withheld) {
        // The agent's, and its grab never reached KWin: from here on the
        // plugin dismisses it where the grab would have.
        m_withheldGrabPopups.removeAll(window);
        m_agentPopups.append(window);
        return;
    }
    if (agentGrab == withheld) {
        return;
    }
    // The creation-time guess was wrong. An agent grab that got through would
    // take seat0 the moment the popup maps, and a human popup whose grab was
    // cut would not get their keys; neither is fixable in place, so the popup
    // is closed and whoever opened it opens it again, attributed correctly.
    ++m_popupsDismissed;
    window->popupDone();
}

bool SynaraComputerUsePlugin::isAgentPopup(const Window *window) const
{
    return window && std::any_of(m_agentPopups.cbegin(), m_agentPopups.cend(), [window](const QPointer<Window> &popup) {
        return popup == window;
    });
}

/** Newest first, so a submenu goes before the menu that opened it. */
void SynaraComputerUsePlugin::dismissAgentPopups(const std::function<bool(const Window *)> &shouldDismiss)
{
    const QList<QPointer<Window>> popups = m_agentPopups;
    for (auto it = popups.crbegin(); it != popups.crend(); ++it) {
        Window *popup = *it;
        if (popup && !popup->isDeleted() && shouldDismiss(popup)) {
            ++m_popupsDismissed;
            popup->popupDone();
        }
    }
}

void SynaraComputerUsePlugin::noteAgentPress(const Window *window)
{
    if (m_ownsCompositor || !window || !window->surface()) {
        return;
    }
    m_lastAgentPressClient = window->surface()->client();
    m_lastAgentPress.restart();
}

/**
 * The human pressed at @p position. Recorded for attribution against the
 * client the press is about to reach - seat0's pointer focus for the pointer
 * (the press has not been delivered yet, so that is still the surface it is
 * going to), the window under a finger or a pen for touch and tablet, whose
 * points are delivered where they land wherever the pointer is - then the
 * agent's popups are dismissed unless the press is on one of them. The press
 * itself goes on to wherever it was going: this is a spy, and nothing here
 * filters it.
 */
void SynaraComputerUsePlugin::handleHumanPointerPress(const QPointF &position, bool byPointerFocus)
{
    const SurfaceInterface *focus = nullptr;
    if (byPointerFocus) {
        SeatInterface *seat = waylandServer() ? waylandServer()->seat() : nullptr;
        PointerInterface *pointer = seat ? seat->pointer() : nullptr;
        focus = pointer ? pointer->focusedSurface() : nullptr;
    } else if (input()) {
        const Window *window = input()->findToplevel(position);
        focus = window ? window->surface() : nullptr;
    }
    m_lastHumanPressClient = focus ? focus->client() : nullptr;
    m_lastHumanPress.restart();
    if (m_agentPopups.isEmpty()) {
        return;
    }
    const bool onAgentPopup = std::any_of(m_agentPopups.cbegin(), m_agentPopups.cend(), [&position](const QPointer<Window> &popup) {
        return popup && !popup->isDeleted() && popup->hitTest(position);
    });
    if (!onAgentPopup) {
        dismissAgentPopups([](const Window *) {
            return true;
        });
    }
}

void SynaraComputerUsePlugin::handleHumanKeyPress()
{
    const SurfaceInterface *focus = humanKeyboardSurface();
    m_lastHumanPressClient = focus ? focus->client() : nullptr;
    m_lastHumanPress.restart();
}

bool SynaraComputerUsePlugin::humanCapsLockOn() const
{
    const Xkb *xkb = humanXkb();
    return xkb && xkb->state() && xkb_state_mod_name_is_active(xkb->state(), XKB_MOD_NAME_CAPS, XKB_STATE_MODS_LOCKED) == 1;
}

/**
 * CapsLock as the next key will experience it. On the agent seat that is the
 * agent's own lock state; on the direct path the human's is merged in
 * (directKeyboardModifiers). The path is the one decided for the keyboard
 * window when there is one, else the one the explicit target or the pointer's
 * window will take, because the server reads this before it focuses and types.
 */
bool SynaraComputerUsePlugin::effectiveCapsLockOn() const
{
    const bool agentCaps = m_xkbState != nullptr
        && xkb_state_mod_name_is_active(m_xkbState, XKB_MOD_NAME_CAPS, XKB_STATE_MODS_LOCKED) == 1;
    if (m_ownsCompositor) {
        return humanCapsLockOn();
    }
    bool direct = false;
    if (m_keyboardWindow) {
        direct = m_keyboardDirect;
    } else if (m_targetRequested && usableWindow(m_targetWindow)) {
        direct = usePointerDirectInjection(m_targetWindow);
    } else if (m_pointerWindow) {
        direct = m_pointerDirect;
    }
    return agentCaps || (direct && humanCapsLockOn());
}

/**
 * Refuse, out loud, rather than inject into a client that cannot hear us.
 *
 * Wayland delivers input per resource, so an event sent to a resource a client
 * does not hold is dropped with no error at any layer and the caller believes it
 * clicked. Almost nothing reaches this refusal now: a client that skipped the
 * agent seat is driven through its own seat0 resources instead. What is left is
 * a client holding no input resources at all - it never asked its seat for a
 * pointer or a keyboard - and no coordinate would have worked there.
 */
bool SynaraComputerUsePlugin::requireReachableClient(const Window *window, bool directInjection)
{
    // There is no second seat in a compositor the agent owns, so every client is
    // reachable and this refusal cannot apply.
    if (m_ownsCompositor || !window) {
        return true;
    }
    // The agent seat carries the event itself for a client that bound it, so the
    // only unreachable client is one being written to directly with nothing to
    // write to. The caller passes the path decision taken when the pointer or the
    // keyboard arrived, so this costs no second walk of the client's resources.
    if (!directInjection) {
        return true;
    }
    if (clientHoldsInputResource(window->surface())) {
        return true;
    }

    QString name = window->resourceClass();
    if (name.isEmpty()) {
        name = window->caption();
    }
    if (name.isEmpty()) {
        name = QStringLiteral("This window");
    }
    sendRefusal(s_seatUnsupportedErrorName,
                   QStringLiteral("%1 holds no pointer or keyboard on any seat, so input to it is dropped "
                                  "silently and the action would have no effect. Nothing aimed at this "
                                  "window will work until it asks its seat for input.")
                       .arg(name));
    return false;
}

/**
 * Give way to the person at the keyboard, on their own window.
 *
 * The agent has its own cursor and its own seat, which is what lets it work
 * while the human works - but the sixth E2E run showed the limit of that: a
 * correctly aimed click landed on the compose dialog the human was typing in.
 * Input isolation held (they did not lose a keystroke), and the action was still
 * wrong. So one window is off the table while its owner is in it, and every
 * other window on the desktop stays available.
 *
 * There is deliberately **no attribution epsilon** here. A guard that drove
 * seat0 itself would have to subtract the agent's own input from what it
 * observes; on this desktop the agent's events never enter seat0 (the dedicated
 * seat is a second `SeatInterface`, and direct injection writes to client
 * resources without a seat), so every event the spy saw is the human's by
 * construction, and there is nothing to subtract.
 *
 * Refused rather than delayed: the caller can retry, and a compositor that
 * queued the agent's click until the human paused would deliver it into a window
 * whose state had moved on.
 */
SynaraComputerUsePlugin::HumanConflict SynaraComputerUsePlugin::humanConflict(const Window *window, bool directInjection, InputKind kind, const Window **humanWindow) const
{
    *humanWindow = nullptr;
    // Off entirely in a compositor the agent owns. There the agent's input rides
    // seat0, so recency would count its own events and lock it out for good, and
    // there is no human in that compositor to protect in the first place.
    if (m_ownsCompositor || m_humanActiveGuardMs == 0 || !window) {
        return HumanConflict::None;
    }
    const auto active = [this](qint64 age) {
        return age >= 0 && age <= qint64(m_humanActiveGuardMs);
    };
    // Their focused window is off limits to any device: a click into the
    // window someone is typing in is as wrong as a keystroke into it.
    const Window *human = active(humanInputAgeMilliseconds()) ? humanFocusWindow() : nullptr;
    if (human) {
        // A menu takes the keyboard focus of the person using it, so when their
        // focus sits on a popup, the window that opened it is what they are
        // working in: walk up to the nearest non-popup ancestor first. Without
        // this, an agent click into the parent would be allowed - and a click
        // outside an open menu is exactly what dismisses it.
        while (human->isPopupWindow() && human->transientFor()) {
            human = human->transientFor();
        }
        // Their open menu is their window: a popup is a window of its own,
        // transient for the one that opened it, and clicking into it is clicking
        // into what they are doing.
        if (window == human || popupInTransientTree(human, window)) {
            *humanWindow = human;
            return HumanConflict::FocusedWindow;
        }
    }
    // Direct injection borrows the client's seat0 pointer or keyboard, which
    // every other window of that client shares (Xwayland: every X11 window; a
    // browser: all of its windows). Bursting into one window while the human is
    // using another of the same client disturbs theirs - it sees a focus-out
    // and focus-in, or a pointer leave and enter - so the client is off the
    // table until they pause. Per object and per device: a click borrows the
    // pointer object and competes with their pointer, a key borrows the
    // keyboard object and competes with their keyboard, and a person typing in
    // a terminal with their mouse resting on an X11 window is not using their
    // mouse. Only while they are active: the burst itself is routed correctly
    // (see usePointerDirectInjection), this refusal is about not interrupting
    // them.
    if (!directInjection || !window->surface()) {
        return HumanConflict::None;
    }
    if (kind == InputKind::Pointer) {
        if (humanPointerSurfaceInClientOf(window->surface()) && active(humanPointerAgeMilliseconds())) {
            return HumanConflict::SharedClient;
        }
    } else if (humanKeyboardSurfaceInClientOf(window->surface()) && active(humanKeyboardAgeMilliseconds())) {
        return HumanConflict::SharedClient;
    }
    return HumanConflict::None;
}

void SynaraComputerUsePlugin::sendRefusal(const QString &name, const QString &message) const
{
    if (!m_quietRefusals) {
        sendErrorReply(name, message);
    }
}

bool SynaraComputerUsePlugin::refuseIfHumanActive(const Window *window, bool directInjection, InputKind kind)
{
    const Window *human = nullptr;
    const HumanConflict conflict = humanConflict(window, directInjection, kind, &human);
    if (conflict == HumanConflict::None) {
        return false;
    }
    if (conflict == HumanConflict::FocusedWindow) {
        const qint64 age = humanInputAgeMilliseconds();
        QString title = human ? human->caption() : QString();
        if (title.isEmpty() && human) {
            title = human->resourceClass();
        }
        if (title.isEmpty()) {
            title = QStringLiteral("the focused window");
        }
        sendRefusal(s_humanActiveErrorName,
                       QStringLiteral("The human is using %1 right now - their keyboard focus is on it and "
                                      "their own devices were active %2 ms ago - so nothing was sent to it. "
                                      "Every other window is still available, and this action can be retried "
                                      "once they have been idle for %3 ms.")
                           .arg(title)
                           .arg(age)
                           .arg(m_humanActiveGuardMs));
        return true;
    }
    QString name = window->resourceClass();
    if (name.isEmpty()) {
        name = window->caption();
    }
    if (name.isEmpty()) {
        name = QStringLiteral("this application");
    }
    const bool pointer = kind == InputKind::Pointer;
    sendRefusal(s_humanActiveErrorName,
                   QStringLiteral("The human is using %1 right now - their %2 is in another window of the "
                                  "same application, which shares one %3 connection with this one (every X11 "
                                  "window shares Xwayland's), and their %2 was active %4 ms ago - so nothing "
                                  "was sent to it. Windows of other applications are still available, and "
                                  "this action can be retried once their %2 has been idle for %5 ms.")
                       .arg(name,
                            pointer ? QStringLiteral("pointer") : QStringLiteral("keyboard"),
                            pointer ? QStringLiteral("pointer") : QStringLiteral("keyboard"))
                       .arg(pointer ? humanPointerAgeMilliseconds() : humanKeyboardAgeMilliseconds())
                       .arg(m_humanActiveGuardMs));
    return true;
}

/**
 * The window the human is working in that raising @p window would cover, or
 * null when the raise is theirs to ignore.
 *
 * A restack moves no focus, but it can bury the window someone is typing in
 * under the agent's: their keys still go there, and they can no longer see
 * what they type. So while they are active (the same recency as every other
 * refusal) a raise is refused when it would put the window above theirs where
 * the two overlap. Nothing changes for them when the window is already above
 * theirs, sits in a lower layer that cannot rise past theirs, does not overlap
 * it, or owns it as a transient (KWin keeps a transient above its parent).
 */
const Window *SynaraComputerUsePlugin::humanWindowCoveredByRaise(const Window *window) const
{
    if (m_ownsCompositor || m_humanActiveGuardMs == 0 || !window || !Workspace::self()) {
        return nullptr;
    }
    const qint64 age = humanInputAgeMilliseconds();
    if (age < 0 || age > qint64(m_humanActiveGuardMs)) {
        return nullptr;
    }
    const Window *human = humanFocusWindow();
    while (human && human->isPopupWindow() && human->transientFor()) {
        human = human->transientFor();
    }
    if (!human || human == window || window->hasTransient(human, true)) {
        return nullptr;
    }
    const QList<Window *> &stacking = Workspace::self()->stackingOrder();
    const qsizetype windowIndex = stacking.indexOf(const_cast<Window *>(window));
    const qsizetype humanIndex = stacking.indexOf(const_cast<Window *>(human));
    if (windowIndex < 0 || humanIndex < 0 || windowIndex > humanIndex || window->layer() < human->layer()) {
        return nullptr;
    }
    return window->frameGeometry().intersects(human->frameGeometry()) ? human : nullptr;
}

bool SynaraComputerUsePlugin::refuseIfRaiseCoversHuman(const Window *window)
{
    const Window *human = humanWindowCoveredByRaise(window);
    if (!human) {
        return false;
    }
    QString title = human->caption();
    if (title.isEmpty()) {
        title = human->resourceClass();
    }
    if (title.isEmpty()) {
        title = QStringLiteral("the focused window");
    }
    sendRefusal(s_humanActiveErrorName,
                QStringLiteral("The human is using %1 right now, and raising this window would cover it where the two "
                               "overlap, so nothing was restacked. Focus the window instead (it takes the agent's input "
                               "without being raised), or retry once they have been idle for %2 ms.")
                    .arg(title)
                    .arg(m_humanActiveGuardMs));
    return true;
}

/**
 * On screen, on this desktop, and finished enough to be aimed at.
 *
 * Everything except whether the window takes input at all, which is the one
 * requirement the pointer and the keyboard disagree about.
 */
bool SynaraComputerUsePlugin::presentWindow(const Window *window) const
{
    return window
        && !window->isDeleted()
        && window->isClient()
        && window->surface()
        && window->surface()->isMapped()
        && window->isOnCurrentActivity()
        && window->isOnCurrentDesktop()
        && !window->isMinimized()
        && !window->isHidden()
        && !window->isHiddenByShowDesktop()
        && window->readyForPainting();
}

bool SynaraComputerUsePlugin::usableWindow(const Window *window) const
{
    return presentWindow(window) && window->wantsInput();
}

/**
 * The pointer's version of usableWindow, which also accepts popups.
 *
 * `wantsInput` is a statement about keyboard focus, and KWin's XdgPopupWindow
 * answers it `false` unconditionally - a menu never wants to be activated, it
 * borrows the keyboard through the compositor's popup grab instead. Gating the
 * pointer on it too is why a context menu, a dropdown, or a combo popup could
 * never be clicked: the hit test skipped it and the click landed on whatever
 * the menu was drawn over. The human's compositor delivers those clicks, so
 * this was our filter refusing them, not Wayland.
 *
 * `isPopupWindow` is the right predicate for that: XdgPopupWindow returns true
 * from it for every xdg_popup, and the base implementation adds the
 * window-type popups (combo box, dropdown, menu, tooltip) that managed X11 and
 * internal windows declare. Nothing else widens: `presentWindow` still demands
 * `isClient`, and `hitTest` still honours the surface's input region, so a
 * tooltip that takes no input is not hit even though it is a popup.
 */
bool SynaraComputerUsePlugin::pointerUsableWindow(const Window *window) const
{
    return presentWindow(window) && (window->wantsInput() || window->isPopupWindow());
}

/**
 * The deepest popup in @p ancestor's transient tree that owns @p point.
 *
 * A menu is a window of its own, transient for the window that opened it, so an
 * agent that scopes itself to a window and then opens that window's context
 * menu is aiming at something that is not its target. Walking down from the
 * target rather than back up from whatever the stacking order returns keeps
 * this off the motion path's budget: for the overwhelmingly common target with
 * no transients it is one empty list.
 *
 * Deepest first, because a submenu is transient for the menu that spawned it
 * and is drawn above it. The walk descends through transients that are not
 * popups - a menu opened from a modal dialog is still the target's descendant -
 * but only a popup is ever returned, so a dialog keeps its existing behaviour
 * of having to be targeted in its own right.
 */
Window *SynaraComputerUsePlugin::popupTransientAt(const Window *ancestor, const QPointF &point) const
{
    if (!ancestor) {
        return nullptr;
    }
    const QList<Window *> &transients = ancestor->transients();
    for (Window *transient : transients) {
        if (!transient) {
            continue;
        }
        if (Window *deeper = popupTransientAt(transient, point)) {
            return deeper;
        }
        if (transient->isPopupWindow() && pointerUsableWindow(transient) && transient->hitTest(point)) {
            return transient;
        }
    }
    return nullptr;
}

/**
 * Whether @p candidate is a popup somewhere below @p ancestor in the transient
 * tree.
 *
 * The same walk as popupTransientAt with a different question - descending
 * through transients that are not popups, because a menu opened from a modal
 * dialog is still the dialog owner's descendant, and answering only for popups,
 * because a dialog is a window in its own right and is targeted as one.
 */
bool SynaraComputerUsePlugin::popupInTransientTree(const Window *ancestor, const Window *candidate) const
{
    if (!ancestor || !candidate) {
        return false;
    }
    const QList<Window *> &transients = ancestor->transients();
    for (const Window *transient : transients) {
        if (!transient) {
            continue;
        }
        if (transient == candidate && transient->isPopupWindow()) {
            return true;
        }
        if (popupInTransientTree(transient, candidate)) {
            return true;
        }
    }
    return false;
}

/**
 * The window the pointer's next event goes to, or null when it must be
 * refused: the rule updatePointerFocus delivers by, with nothing sent.
 */
Window *SynaraComputerUsePlugin::resolvePointerWindow() const
{
    if (m_targetRequested) {
        // An explicit target owns the pointer, exactly as it owns the keyboard.
        // Falling back to whatever the stacking order puts under the cursor is
        // how a click aimed at a partly covered window is delivered to the
        // window covering it, which reads to the caller as a button that does
        // nothing. A target that has gone away, or that does not accept input
        // at this point, therefore fails the injection instead: the caller can
        // recover from a refusal and cannot recover from a click it never made.
        //
        // The target's own menus are the exception, and they have to be, because
        // they are separate windows: the target still owns the point a dropdown
        // is drawn over, so refusing everything that is not the target itself
        // sent the click straight through the open menu into the window behind
        // it. A popup the target opened is the target as far as the caller is
        // concerned, and taking it first is what makes the menu item, rather
        // than what it covers, receive the press.
        if (Window *popup = popupTransientAt(m_targetWindow, m_pos)) {
            return popup;
        }
        if (!pointerUsableWindow(m_targetWindow) || !m_targetWindow->hitTest(m_pos)) {
            return nullptr;
        }
        return m_targetWindow;
    }
    return windowAt(m_pos, InputKind::Pointer);
}

/**
 * The path a window is driven on: the one decided when the input arrived on
 * it while it is still there (@p current, @p currentDirect), else what a
 * fresh arrival would decide.
 */
bool SynaraComputerUsePlugin::directPathFor(const Window *window, const Window *current, bool currentDirect) const
{
    if (m_ownsCompositor || !window) {
        return false;
    }
    return window == current ? currentDirect : usePointerDirectInjection(window);
}

bool SynaraComputerUsePlugin::updatePointerFocus()
{
    Window *window = resolvePointerWindow();
    if (!window) {
        clearPointerDelivery();
        return false;
    }

    if (m_ownsCompositor) {
        // The scoping above still applies - an explicit target must own the
        // point, or the click is refused rather than delivered to whatever
        // covers it - but the delivery itself is KWin's, and it derives pointer
        // focus from the cursor position the motion already set.
        m_pointerWindow = window;
        return true;
    }

    // Which path this window takes is decided on arrival and held for the stay,
    // because the probe walks every resource the client holds and a motion stream
    // is not the place to pay for that per event. A client that binds the agent
    // seat while the pointer already sits on it keeps the seat0 resources the
    // direct path is writing to, so it stays reachable until the next leave and
    // re-enter re-decides. The old delivery is always torn down by the same call
    // that knows how it was made.
    if (m_pointerWindow != window) {
        clearPointerDelivery();
        m_pointerWindow = window;
        m_pointerDirect = usePointerDirectInjection(window);
        if (!m_pointerDirect) {
            m_seat->notifyPointerEnter(window->surface(), m_pos, window->inputTransformation());
            return true;
        }
    }

    if (m_pointerDirect) {
        // Plain motion never borrows an object seat0 is using in this client:
        // the enter is deferred to the action (ensureDirectPointerEnter), which
        // is what a burst is for, and the action itself is refused while the
        // human is active there. An enter on a client the human's seat is
        // nowhere near persists, so hover follows the ghost cursor exactly as
        // it does on the agent seat. An object already borrowed - a button is
        // held mid-gesture, see restoreHumanDelivery - keeps receiving motion,
        // or a drag would not move.
        if (m_directPointerSurface || !humanPointerSurfaceInClientOf(window->surface())) {
            directPointerEnter(window);
        }
        return true;
    }

    m_seat->notifyPointerMotion(m_pos);
    return true;
}

/**
 * Undo whichever enter is outstanding, without needing to be told which.
 *
 * The direct surface is set only by the direct path and the seat's focus only by
 * the seat path, so each is torn down by exactly the code that made it.
 */
void SynaraComputerUsePlugin::clearPointerDelivery()
{
    // The old destination must receive releases before its focus is dropped,
    // including when the pointer moves onto empty desktop or outside a target.
    releasePressedButtons();
    if (m_pointerDirect) {
        directPointerLeave();
    } else if (m_pointerWindow && m_seat) {
        m_seat->notifyPointerLeave();
    }
    // Owed sub-notch scroll belonged to the window being left; the next one
    // must not inherit it. Tied to the window, not to the enter: a shared
    // object is handed back after every idle scroll call, and an old client
    // would never accumulate a click otherwise.
    m_directAxisRemainderH = 0;
    m_directAxisRemainderV = 0;
    m_pointerWindow.clear();
    m_pointerDirect = false;
}

/**
 * The window the keyboard's next key goes to, or null when it must be
 * refused: the rule updateKeyboardFocus delivers by, with nothing sent.
 */
Window *SynaraComputerUsePlugin::resolveKeyboardWindow() const
{
    if (m_targetRequested) {
        // An explicit target that has gone away has to fail loudly. Silently
        // falling back to whatever sits under the ghost cursor is how a Ctrl+Q
        // aimed at a closing window ends up quitting an unrelated one, and it
        // reads to the caller as input being delivered late.
        return usableWindow(m_targetWindow) ? m_targetWindow.data() : nullptr;
    }
    if (usableWindow(m_pointerWindow)) {
        return m_pointerWindow;
    }
    // Reached whenever the pointer sits on a popup, among other things: a
    // menu cannot be focused, so the keyboard stays on the focusable window
    // under the cursor, which is where it was before the menu opened, and the
    // toolkit routes the keys to its open menu from there. KWin's popup
    // filter plays no part: it would move seat0's keyboard - the human's -
    // onto any grabbing popup, so an agent popup is never let grab (see
    // watchPopups).
    return windowAt(m_pos, InputKind::Keyboard);
}

bool SynaraComputerUsePlugin::updateKeyboardFocus()
{
    Window *window = resolveKeyboardWindow();
    if (!window) {
        if (m_targetRequested) {
            forgetPressedKeys();
            clearKeyboardFocus();
        }
        return false;
    }

    if (m_ownsCompositor) {
        // Real activation, not the borrowed `activated` flag the shared desktop
        // needs: this compositor's focus is the agent's to move, so the window
        // becomes genuinely active and its shortcut handling works for the same
        // reason it works for a human.
        m_keyboardWindow = window;
        if (Workspace::self() && Workspace::self()->activeWindow() != window) {
            Workspace::self()->activateWindow(window);
        }
        return true;
    }

    // Decided on arrival and held for the stay, for the same reason the pointer's
    // is: the probe is a full walk of the client's resources and a keystroke
    // stream would pay for it per key.
    if (m_keyboardWindow != window) {
        // Released on the surface that saw the press, before anything moves.
        releasePressedKeys();
        clearKeyboardDelivery();
        m_keyboardWindow = window;
        m_keyboardDirect = usePointerDirectInjection(window);
        if (!m_keyboardDirect) {
            if (!m_seat) {
                return false;
            }
            // Keys still held while focus migrates were released above, on the
            // surface that saw the press. Handing the pressed-key array to the
            // next surface makes that client believe the agent is holding Ctrl,
            // and then delivers it the orphaned release, so a half-finished chord
            // leaks into an unrelated window.
            m_seat->setFocusedKeyboardSurface(window->surface(), m_pressedKeys);
            updateWindowActivation(window);
            return true;
        }
    }

    if (m_keyboardDirect) {
        // The same deferral as the pointer's: an object seat0's keyboard is
        // using in this client is borrowed only for the key itself
        // (ensureDirectKeyboardEnter), never on arrival.
        if (!humanKeyboardSurfaceInClientOf(window->surface())) {
            directKeyboardEnter(window);
        }
        // Still borrowed, not real: this is the human's compositor, and a
        // toolkit gates its shortcut matcher on the window being active whether
        // the keys arrived on a seat or straight down the socket.
        updateWindowActivation(window);
        return true;
    }

    if (!m_seat) {
        return false;
    }

    // Re-borrowing is not enough once KWin has revoked the window's active flag:
    // that revocation means the human's seat focus churned through the window,
    // and the leave that seat sent reset the client's keyboard-focus state.
    // Verified live: re-sending xdg `activated` alone leaves Qt's shortcut
    // matcher dead, while a fresh enter on our seat revives it. So cycle our
    // keyboard focus too, carrying any held keys, and let updateWindowActivation
    // re-assert the flag - unless no flag will be re-asserted, because the
    // human is typing in another window of this client: then the cycle would
    // be a focus-out and focus-in per key for nothing.
    if (!window->isActive() && window->surface() && !humanKeyboardInSiblingOf(window)) {
        m_seat->setFocusedKeyboardSurface(nullptr);
        m_seat->setFocusedKeyboardSurface(window->surface(), m_pressedKeys);
    }
    updateWindowActivation(window);
    return true;
}

/** The keyboard twin of clearPointerDelivery. */
void SynaraComputerUsePlugin::clearKeyboardDelivery()
{
    if (m_keyboardDirect) {
        directKeyboardLeave();
    } else if (m_seat) {
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
}

void SynaraComputerUsePlugin::clearKeyboardFocus()
{
    // Delivery first, while the path it was on is still recorded.
    clearKeyboardDelivery();
    m_keyboardWindow.clear();
    m_keyboardDirect = false;
    clearWindowActivation();
}

/**
 * Whether seat0's keyboard is in another window of @p window's client.
 *
 * A toolkit tracks one active window per application: activating this one
 * tells the client the human's window lost activation, which is a FocusOut in
 * the window they are typing in (and a committed or lost IME pre-edit). So
 * no activation is borrowed while this holds; the agent's keys still arrive,
 * and only shortcuts that need an active window wait until the human leaves
 * the application.
 */
bool SynaraComputerUsePlugin::humanKeyboardInSiblingOf(const Window *window) const
{
    if (m_ownsCompositor || !window || !window->surface()) {
        return false;
    }
    const SurfaceInterface *human = humanKeyboardSurfaceInClientOf(window->surface());
    return human && human != window->surface();
}

void SynaraComputerUsePlugin::updateWindowActivation(Window *window)
{
    if (window && humanKeyboardInSiblingOf(window)) {
        if (m_activatedWindow == window) {
            clearWindowActivation();
        }
        return;
    }
    if (m_activatedWindow == window) {
        // A borrow is not durable: KWin revokes the window's active flag when the
        // human moves real activation through it (activate the borrowed window,
        // then another). The borrow pointer alone therefore proves nothing, and
        // returning here on a revoked borrow is how chords die: the client keeps
        // wl_keyboard focus, text still types, but its shortcut matcher sees an
        // inactive window and drops every QAction. Re-assert lazily, on the next
        // focus or key call, rather than from a signal handler that would fight
        // the compositor mid-transition.
        if (!window || window->isDeleted() || window->isActive() || !m_running) {
            return;
        }
        if (Workspace::self() && Workspace::self()->activeWindow() == window) {
            return;
        }
        window->setActive(true);
        return;
    }
    clearWindowActivation();
    if (!window || !m_running) {
        return;
    }
    // Toolkits do not derive "this window is active" from wl_keyboard focus: Qt
    // tracks the xdg_toplevel `activated` state, and its shortcut matcher refuses
    // to match anything while the application has no active window. Without this,
    // the agent's keystrokes reach the focus widget (text still types) but every
    // QAction shortcut is dropped.
    //
    // Window::setActive() is the narrow tool for that: it flips the window's
    // activation state, and therefore the `activated` flag the client sees, while
    // leaving the compositor's keyboard focus alone. That is a property of KWin
    // 6.7.4's code, checked rather than assumed, because moving seat0's keyboard
    // focus is the one thing this plugin must never do:
    //  - Window::setActive (window.cpp) sets m_active, opacity and layer, calls
    //    doSetActive() (XdgToplevelWindow: schedules a configure with the
    //    Activated state; X11Window: sets NET::Focused) and emits
    //    Window::activeChanged. It does not call Workspace::setActiveWindow;
    //    the call direction is the reverse (activation.cpp's setActiveWindow
    //    calls setActive on the old and new window).
    //  - seat0's keyboard focus moves only in KeyboardInputRedirection::update
    //    (keyboard_input.cpp), from pickFocus() - the lock screen, a grab, or
    //    workspace()->activeWindow() - and update() runs on
    //    Workspace::windowActivated, the lock state, the active window's
    //    surfaceChanged, and every real key (input.cpp's forwarding filter).
    //    workspace()->activeWindow() is Workspace::m_activeWindow, which only
    //    setActiveWindow assigns, and windowActivated is emitted only there.
    //  - The one core consumer of Window::activeChanged is the
    //    plasma-window-management mirror (window.cpp), which reports the flag
    //    to the taskbar.
    // So the borrow changes what the client and the taskbar are told and
    // nothing about where the human's keys go. The human's seat keeps typing
    // wherever it was, and their own window stays active in Workspace's eyes.
    if (Workspace::self() && Workspace::self()->activeWindow() == window) {
        return;
    }
    window->setActive(true);
    m_activatedWindow = window;
}

void SynaraComputerUsePlugin::clearWindowActivation()
{
    Window *window = m_activatedWindow;
    m_activatedWindow.clear();
    if (!window || window->isDeleted()) {
        return;
    }
    // KWin may have handed the window real activation in the meantime; that state
    // is the compositor's to own, so only undo activation we invented ourselves.
    if (Workspace::self() && Workspace::self()->activeWindow() == window) {
        return;
    }
    window->setActive(false);
}

void SynaraComputerUsePlugin::releasePressedButtons()
{
    const auto buttons = m_pressedButtons.values();
    for (quint32 button : buttons) {
        sendButton(button, false);
    }
}

void SynaraComputerUsePlugin::releasePressedKeys()
{
    const auto keys = m_pressedKeys;
    for (auto it = keys.crbegin(); it != keys.crend(); ++it) {
        sendKey(*it, false);
    }
}

void SynaraComputerUsePlugin::forgetPressedKeys()
{
    if (m_pressedKeys.isEmpty()) {
        return;
    }
    // The surface that saw the presses is gone, so no release can land there.
    // Drop the keys locally instead, or the next window the agent focuses inherits
    // a phantom Ctrl through the enter event's pressed-key array.
    const auto keys = m_pressedKeys;
    m_pressedKeys.clear();
    if (!m_xkbState) {
        return;
    }
    for (auto it = keys.crbegin(); it != keys.crend(); ++it) {
        xkb_state_update_key(m_xkbState, *it + 8, XKB_KEY_UP);
    }
    syncModifiers();
}

void SynaraComputerUsePlugin::releasePressedState()
{
    // Whichever path this compositor uses, because a stop that skips the release
    // latches the held button or modifier in the client for good. Callers run
    // this before detachInputDevice(), while the path can still carry events.
    if (!inputReady()) {
        return;
    }

    // Bypasses the public entry points: a release must land even when the
    // session is already stopping, and it must never re-target focus.
    releasePressedButtons();
    releasePressedKeys();
}

void SynaraComputerUsePlugin::setTimestampNow()
{
    if (!m_seat) {
        return;
    }
    m_seat->setTimestamp(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()));
}

void SynaraComputerUsePlugin::syncModifiers()
{
    if (!m_seat || !m_xkbState) {
        return;
    }
    m_seat->notifyKeyboardModifiers(
        xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_DEPRESSED),
        xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_LATCHED),
        xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_LOCKED),
        xkb_state_serialize_layout(m_xkbState, XKB_STATE_LAYOUT_EFFECTIVE));
}

} // namespace KWin

#include "moc_synaracomputeruseplugin.cpp"
