// The panic-release latch, driven through the production lifetime bookkeeping
// with the input teardown modelled away.
#include <iostream>
#include <stdexcept>
#include <string>

using QString = std::string;
#define QStringLiteral(literal) std::string(literal)

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
    int stopsEmitted = 0;

    static QString stopReasonName(StopReason reason);
    bool recordStop(StopReason reason);
    void handleReleaseShortcut();
    // Teardown of input state is not under test here; the latch rule is.
    void stopSession(StopReason reason) {
        if (recordStop(reason)) ++stopsEmitted;
    }
    // Re-authentication stops whatever the previous server left running.
    void authenticate() { stopSession(StopReason::Request); }
    bool start() {
        if (m_releasedByUser) return false;
        m_running = true;
        return true;
    }
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    SynaraComputerUsePlugin plugin;
    check(plugin.start(), "a fresh plugin must start");

    plugin.handleReleaseShortcut();
    check(!plugin.m_running && plugin.m_releasedByUser, "the panic shortcut must stop and latch");
    check(plugin.m_stopReason == "user-release", "the panic stop must be reported as user-release");
    check(plugin.stopsEmitted == 1, "the panic stop must emit sessionStopped once");
    check(!plugin.start(), "start must be refused while latched");

    // The server restarts and authenticates again: the previous session's input
    // state is torn down, and the human's latch must survive that.
    plugin.authenticate();
    check(plugin.m_releasedByUser, "re-authentication must not clear the user-release latch");
    check(plugin.m_stopReason == "request", "re-authentication reports its own stop reason");
    check(!plugin.start(), "start must still be refused after re-authentication");

    plugin.stopSession(SynaraComputerUsePlugin::StopReason::IdleTimeout);
    plugin.stopSession(SynaraComputerUsePlugin::StopReason::SessionLocked);
    check(plugin.m_releasedByUser, "no other stop reason may clear the latch");
    check(plugin.stopsEmitted == 1, "stops of a stopped session emit nothing");

    // Only the human's resume press hands control back.
    plugin.handleReleaseShortcut();
    check(!plugin.m_releasedByUser && plugin.m_stopReason == "user-resume", "the resume shortcut must clear the latch");
    check(plugin.start(), "start must work again after the resume");

    // A stopped, unlatched plugin still latches on the panic press, and that
    // change alone is worth a signal.
    plugin.stopSession(SynaraComputerUsePlugin::StopReason::Request);
    const int before = plugin.stopsEmitted;
    plugin.handleReleaseShortcut();
    check(plugin.m_releasedByUser, "the panic shortcut must latch a stopped session");
    check(plugin.stopsEmitted == before + 1, "latching a stopped session must emit sessionStopped");

    std::cout << "Only the resume shortcut clears the user-release latch.\n";
}
