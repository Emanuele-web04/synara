// Every waitForSettle is answered exactly once, whatever ends it: a session
// stop (or the plugin going away) answers each pending wait unsettled, as the
// Hyprland plugin does, and a lock answers them SessionLocked.
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

using qint64 = int64_t;
using uint = unsigned int;
using QString = std::string;
#define QStringLiteral(s) std::string(s)
struct QVariant : std::variant<bool, uint> {
    using std::variant<bool, uint>::variant;
};
using QVariantList = std::vector<QVariant>;
struct Reply {
    int wait = 0;
    bool error = false;
    std::string errorName;
    bool settled = false;
};
std::vector<Reply> replies;
struct QDBusMessage {
    int wait = 0;
    Reply createReply(const QVariantList& args) const { return {wait, false, {}, std::get<bool>(args.at(0))}; }
    Reply createErrorReply(const QString& name, const QString&) const { return {wait, true, name, false}; }
};
struct QDBusConnection {
    void send(const Reply& reply) const { replies.push_back(reply); }
};
struct QTimer {
    bool stopped = false, deleted = false;
    void stop() { stopped = true; }
    template <class T> void disconnect(T*) {}
    void deleteLater() { deleted = true; }
};
template <class T> struct QPointer {
    T* p = nullptr;
    QPointer() = default;
    QPointer(T* v) : p(v) {}
    operator T*() const { return p; }
    T* operator->() const { return p; }
};
struct Window {};
struct QElapsedTimer {
    qint64 now = 0;
    qint64 nsecsElapsed() const { return now; }
};

struct SynaraComputerUsePlugin {
    struct SettleRequest;
    std::vector<std::unique_ptr<SettleRequest>> m_settleRequests;
    QElapsedTimer m_settleClock;
    qint64 m_lastAgentInputNs = -1;
    qint64 m_settledAgentInputNs = -1;

    void finishSettle(SettleRequest* request, bool settled);
    void retireSettleTimer(SettleRequest* request);
    void finishAllSettleRequests();
    void failSettleRequests(const QString& errorName, const QString& reason);
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        SynaraComputerUsePlugin plugin;
        std::vector<std::unique_ptr<QTimer>> timers;
        auto pending = [&](int n) {
            for (int i = 0; i < n; ++i) {
                auto request = std::make_unique<SynaraComputerUsePlugin::SettleRequest>(QDBusConnection{}, QDBusMessage{int(plugin.m_settleRequests.size()) + 1});
                timers.push_back(std::make_unique<QTimer>());
                request->timer = timers.back().get();
                plugin.m_settleRequests.push_back(std::move(request));
            }
        };
        pending(3);
        plugin.finishAllSettleRequests();
        check(replies.size() == 3 && plugin.m_settleRequests.empty(), "a stop left a wait unanswered");
        check(std::all_of(replies.begin(), replies.end(), [](const Reply& r) { return !r.error && !r.settled; }), "a stop answers unsettled, never as an error");
        check(std::all_of(timers.begin(), timers.end(), [](const auto& t) { return t->stopped && t->deleted; }), "a stop left a wait's timer running");
        plugin.finishAllSettleRequests();
        check(replies.size() == 3, "a wait was answered twice");

        replies.clear();
        pending(2);
        plugin.failSettleRequests("org.synara.ComputerUse.Error.SessionLocked", "session locked");
        plugin.finishAllSettleRequests();
        check(replies.size() == 2 && std::all_of(replies.begin(), replies.end(), [](const Reply& r) { return r.error && r.errorName == "org.synara.ComputerUse.Error.SessionLocked"; }),
              "a lock answers every wait SessionLocked, once, before the stop that follows it");
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "settle answers: a stop answers every wait unsettled, a lock answers SessionLocked, each once.\n";
}
