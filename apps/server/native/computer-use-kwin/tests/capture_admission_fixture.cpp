// The extended captures' admission and the passive flag, driven through the
// production entry points against a modelled plugin: which refusals come
// first, how flags pick the format, and that a passive frame is not agent
// activity (R9: an open preview kept an abandoned session alive).
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using uint = unsigned int;
using qreal = double;
struct QString : std::string {
    using std::string::string;
    QString(const std::string& s) : std::string(s) {}
    QString arg(uint value) const {
        std::string out = *this;
        const auto at = out.find("%1");
        if (at != std::string::npos) out.replace(at, 2, std::to_string(value));
        return out;
    }
    QString arg(const QString& value) const {
        std::string out = *this;
        const auto at = out.find("%1");
        if (at != std::string::npos) out.replace(at, 2, value);
        return out;
    }
};
#define QStringLiteral(literal) QString(literal)
#define Q_UNUSED(x) (void)x;
struct QDBusError {
    enum ErrorType { InvalidArgs };
};
struct QDBusConnection {};
struct QDBusMessage {};
struct Window {};
struct RectF {
    double x = 0, y = 0, w = 0, h = 0;
    RectF() = default;
    RectF(double x, double y, double w, double h) : x(x), y(y), w(w), h(h) {}
};
QString s_releasedErrorName = "org.synara.ComputerUse.Error.ControlReleased";

// PRODUCTION_FLAGS

struct SynaraComputerUsePlugin;
struct Auth {
    bool authenticated = true;
    bool permits(const SynaraComputerUsePlugin&) const;
};

struct SynaraComputerUsePlugin {
    struct CaptureRequest {
        CaptureRequest(const QDBusConnection&, const QDBusMessage&) {}
        Window* window = nullptr;
        RectF region;
        uint maxDimension = 0;
        uint flags = 0;
        bool windowCapture = false;
        bool extended = false;
    };

    Auth m_auth;
    bool m_running = true;
    bool m_releasedByUser = false;
    bool locked = false;
    bool delayed = false;
    int activity = 0;
    std::vector<std::string> errors;
    std::vector<std::shared_ptr<CaptureRequest>> queued;
    Window window;

    bool calledFromDBus() const { return true; }
    QDBusConnection connection() const { return {}; }
    QDBusMessage message() const { return {}; }
    void setDelayedReply(bool value) { delayed = value; }
    void sendErrorReply(const QString& name, const QString&) { errors.push_back(name); }
    void sendErrorReply(QDBusError::ErrorType, const QString&) { errors.push_back("InvalidArgs"); }
    QString releaseShortcutText() const { return "Meta+Shift+Esc"; }
    bool refuseIfSessionLocked() {
        if (locked) errors.push_back("SessionLocked");
        return locked;
    }
    void noteActivity() { ++activity; }
    void queueCapture(std::shared_ptr<CaptureRequest> request) { queued.push_back(std::move(request)); }
    Window* findWindowById(const QString&) { return &window; }

    bool admitCapture();
    void startCapture(std::shared_ptr<CaptureRequest> request, uint maxDimension, uint flags, bool extended);
    std::string captureWindow(const QString& windowId, uint maxDimension);
    std::string captureWindowEx(const QString& windowId, uint maxDimension, uint flags, QString& mime);
    std::string captureRegionEx(int x, int y, uint width, uint height, uint maxDimension, uint flags, QString& mime);
};
bool Auth::permits(const SynaraComputerUsePlugin&) const { return authenticated; }
using QByteArray = std::string;

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        QString mime;
        {
            SynaraComputerUsePlugin plugin;
            plugin.captureWindow("w", 2048);
            check(plugin.activity == 1, "a version 1 capture while running is agent activity");
            check(!plugin.queued.back()->extended, "a version 1 capture replies with bytes alone");
            plugin.captureWindowEx("w", 2048, CapturePassive, mime);
            check(plugin.activity == 1, "a passive capture must not reset the idle deadline or the badge");
            check(plugin.queued.back()->extended && plugin.queued.back()->windowCapture, "an extended window capture is queued as one");
            plugin.captureRegionEx(0, 0, 10, 10, 0, CaptureJpeg, mime);
            check(plugin.activity == 2, "an active JPEG capture is agent activity");
            plugin.captureRegionEx(0, 0, 10, 10, 0, CapturePassive | CaptureLuma, mime);
            check(plugin.activity == 2, "a passive luma capture is not");
            check(plugin.queued.back()->flags == (CapturePassive | CaptureLuma), "the flags travel with the request");
            check(plugin.errors.empty() && plugin.delayed, "valid captures reply later, without an error");
        }
        {
            SynaraComputerUsePlugin plugin;
            plugin.m_running = false;
            plugin.captureWindowEx("w", 0, 0, mime);
            check(plugin.activity == 0 && plugin.queued.size() == 1, "a stopped session still captures, without activity");
        }
        // The Hyprland plugin's rules: luma outranks JPEG, unknown bits are
        // ignored.
        check(captureFormat(0) == CaptureFormat::Png && captureFormat(CapturePassive) == CaptureFormat::Png, "no format flag is a PNG");
        check(captureFormat(CaptureJpeg) == CaptureFormat::Jpeg, "2 is JPEG");
        check(captureFormat(CaptureLuma) == CaptureFormat::Luma && captureFormat(CaptureJpeg | CaptureLuma) == CaptureFormat::Luma, "4 is luma, and wins over 2");
        {
            SynaraComputerUsePlugin plugin;
            plugin.captureRegionEx(0, 0, 10, 10, 0, 8u | CapturePassive, mime);
            check(plugin.errors.empty() && plugin.queued.size() == 1 && plugin.activity == 0, "unknown bits are ignored, the known ones still apply");
        }
        {
            SynaraComputerUsePlugin plugin;
            plugin.m_releasedByUser = true;
            plugin.captureWindowEx("w", 0, CapturePassive, mime);
            check(plugin.errors.size() == 1 && plugin.errors[0] == s_releasedErrorName, "the release latch refuses a passive capture too");
            SynaraComputerUsePlugin locked;
            locked.locked = true;
            locked.captureWindowEx("w", 0, CapturePassive, mime);
            check(locked.errors.size() == 1 && locked.errors[0] == "SessionLocked", "locked refuses a passive capture too");
            SynaraComputerUsePlugin stranger;
            stranger.m_auth.authenticated = false;
            stranger.captureRegionEx(0, 0, 1, 1, 0, 0, mime);
            check(stranger.queued.empty() && stranger.errors.empty(), "an unauthenticated caller is turned away by the auth check alone");
        }
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "extended captures: admission order, flag validation, and passive frames are not activity.\n";
}
