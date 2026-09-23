// The lock-screen and session-activity gate, driven through the production
// admission check and state-change handler against a modelled compositor.
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using QString = std::string;
#define QStringLiteral(literal) std::string(literal)

struct WaylandServer {
    bool locked = false;
    bool isScreenLocked() const { return locked; }
};
struct Session {
    bool active = true;
    bool isActive() const { return active; }
};
struct Application {
    Session sessionObject;
    Session* session() { return &sessionObject; }
};
WaylandServer server;
Application application;
WaylandServer* waylandServer() { return &server; }
Application* kwinApp() { return &application; }

struct CaptureRequest {};
struct ErrorReply {
    QString name;
    QString message;
};

struct SynaraComputerUsePlugin {
    enum class StopReason {
        Request,
        IdleTimeout,
        UserRelease,
        SessionLocked,
    };

    bool m_running = false;
    bool m_releasedByUser = false;
    QString m_stopReason;
    std::shared_ptr<CaptureRequest> m_captureRequest;
    bool fromDBus = true;
    mutable std::vector<ErrorReply> errors;
    std::vector<ErrorReply> captureFailures;
    int stopsEmitted = 0;

    bool calledFromDBus() const { return fromDBus; }
    void sendErrorReply(const QString& name, const QString& message) const { errors.push_back({name, message}); }
    std::vector<ErrorReply> settleFailures;
    void failSettleRequests(const QString& errorName, const QString& reason) { settleFailures.push_back({errorName, reason}); }
    void failCapture(std::shared_ptr<CaptureRequest> request, const QString& reason, const QString& errorName = QString()) {
        if (request == m_captureRequest) m_captureRequest.reset();
        captureFailures.push_back({errorName, reason});
    }
    // The teardown itself is modelled away; the reason and latch bookkeeping is
    // the production code.
    void stopSession(StopReason reason) {
        if (m_captureRequest) failCapture(m_captureRequest, QStringLiteral("capture canceled by stop"));
        if (recordStop(reason)) ++stopsEmitted;
    }

    static QString stopReasonName(StopReason reason);
    bool recordStop(StopReason reason);
    bool sessionLocked() const;
    bool refuseIfSessionLocked() const;
    void handleSessionStateChanged();
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    SynaraComputerUsePlugin plugin;
    plugin.m_running = true;

    check(!plugin.sessionLocked() && !plugin.refuseIfSessionLocked(), "an unlocked, active session must not be refused");
    check(plugin.errors.empty(), "no error may be sent while unlocked");

    // The screen locks with a capture waiting for a frame.
    plugin.m_captureRequest = std::make_shared<CaptureRequest>();
    server.locked = true;
    plugin.handleSessionStateChanged();
    check(!plugin.m_running && plugin.m_stopReason == "session-locked", "locking must stop the running session with its own reason");
    check(plugin.stopsEmitted == 1, "the lock stop must be announced");
    check(plugin.captureFailures.size() == 1 && plugin.captureFailures[0].name == SYNARA_SESSION_LOCKED_ERROR,
          "an in-flight capture must fail with the SessionLocked error, not CaptureFailed");
    check(!plugin.m_releasedByUser, "locking must not touch the user-release latch");
    check(plugin.settleFailures.size() == 1 && plugin.settleFailures[0].name == SYNARA_SESSION_LOCKED_ERROR,
          "waits for a settle must end with the SessionLocked error too");

    check(plugin.refuseIfSessionLocked(), "every entry point must refuse while locked");
    check(plugin.errors.size() == 1 && plugin.errors[0].name == SYNARA_SESSION_LOCKED_ERROR, "the refusal must carry the SessionLocked error name");
    check(!plugin.errors[0].message.empty(), "the refusal must explain itself");

    // Unlocking restarts nothing.
    server.locked = false;
    plugin.handleSessionStateChanged();
    check(!plugin.m_running && plugin.stopsEmitted == 1, "unlocking must neither restart nor re-announce");
    check(!plugin.refuseIfSessionLocked(), "an unlocked session is admitted again");

    // An inactive logind session (another VT, a greeter) is the same gate.
    plugin.m_running = true;
    application.sessionObject.active = false;
    check(plugin.sessionLocked(), "an inactive session counts as locked");
    plugin.handleSessionStateChanged();
    check(!plugin.m_running && plugin.m_stopReason == "session-locked", "a VT switch must stop the session too");
    application.sessionObject.active = true;

    // Internal callers (no D-Bus context) get the verdict without a reply.
    server.locked = true;
    plugin.fromDBus = false;
    const size_t before = plugin.errors.size();
    check(plugin.refuseIfSessionLocked() && plugin.errors.size() == before, "no reply may be sent outside a D-Bus call");

    std::cout << "Lock and session activity gate input and capture with SessionLocked.\n";
}
