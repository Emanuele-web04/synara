// xdg_activation on the human's desktop, driven through the production token
// creator against modelled KWin objects: a token quoting a serial the agent
// minted (or the agent's seat) is refused wherever it comes from, and every
// other request gets KWin 6.7.4's own answer, with the serial KWin would have
// stored - so a launch the human started still activates while the agent
// works, which the old "move KWin's last interaction past the burst" rule
// broke.
#include <algorithm>
#include <array>
#include <compare>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using quint32 = uint32_t;
using quint64 = uint64_t;
using uint = unsigned int;

struct QString : std::string {
    using std::string::string;
    QString(const std::string& s) : std::string(s) {}
};
#define QStringLiteral(s) QString(s)
using QLatin1StringView = QString;
struct QStringList : std::vector<QString> {
    using std::vector<QString>::vector;
    bool contains(const QString& s) const { return std::find(begin(), end(), s) != end(); }
};
struct QVariant {
    QStringList list;
    QStringList toStringList() const { return list; }
};

// KWin's utils/serial.h, verbatim in behaviour.
struct UInt32Serial {
    uint32_t value = 0;
    constexpr UInt32Serial() {}
    constexpr UInt32Serial(uint32_t v) : value(v) {}
    constexpr std::weak_ordering operator<=>(const UInt32Serial& other) const {
        if (value == other.value) return std::weak_ordering::equivalent;
        if (value - other.value < std::numeric_limits<uint32_t>::max() / 2) return std::weak_ordering::greater;
        return std::weak_ordering::less;
    }
    constexpr bool operator==(const UInt32Serial& other) const = default;
};

struct SynaraSerialBurst {
    quint32 after = 0;
    quint32 last = 0;
};

struct ClientConnection {
    QStringList requested;
    QVariant property(const char*) const { return {requested}; }
};
struct SurfaceInterface {};
struct SeatInterface {};
struct Window {
    SurfaceInterface* s = nullptr;
    SurfaceInterface* surface() const { return s; }
};
struct Issued {
    QString token;
    UInt32Serial serial;
    QString appId;
};
struct Workspace {
    Window* active = nullptr;
    Issued stored;
    Window* activeWindow() const { return active; }
    void setActivationToken(const QString& token, UInt32Serial serial, const QString& appId) { stored = {token, serial, appId}; }
    static Workspace* self() { static Workspace w; return &w; }
};
struct InputRedirection {
    quint32 lastInteraction = 0;
    quint32 lastInteractionSerial() const { return lastInteraction; }
};
InputRedirection inputObject;
InputRedirection* input() { return &inputObject; }
// KWin's requestToken(true, ...): no check, and KWin's last interaction as the
// stored serial.
struct XdgActivationV1Integration {
    int issued = 0;
    QString requestPrivilegedToken(SurfaceInterface*, uint, SeatInterface*, const QString& appId) {
        const QString token = "kwin-" + std::to_string(++issued);
        Workspace::self()->setActivationToken(token, input()->lastInteractionSerial(), appId);
        return token;
    }
};
struct WaylandServer {
    XdgActivationV1Integration integration;
    XdgActivationV1Integration* xdgActivationIntegration() { return &integration; }
};
WaylandServer server;
WaylandServer* waylandServer() { return &server; }

// PRODUCTION_FREE

struct SynaraComputerUsePlugin {
    SeatInterface agentSeat;
    SeatInterface* m_seat = &agentSeat;
    quint32 display = 0;
    std::array<SynaraSerialBurst, 512> m_agentBursts = {};
    size_t m_agentBurstNext = 0;
    size_t m_agentBurstCount = 0;
    quint64 m_activationTokensRefused = 0;
    quint32 displaySerial() const { return display; }

    void noteAgentBurst(quint32 after, quint32 last);
    bool agentMintedSerial(quint32 serial) const;
    QString createActivationToken(ClientConnection* client, SurfaceInterface* surface, uint serial, SeatInterface* seat, const QString& appId);
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        {
            // The ranges: exact, wrap-safe, adjacent bursts merged, oldest dropped.
            SynaraComputerUsePlugin plugin;
            plugin.noteAgentBurst(100, 100);
            check(plugin.m_agentBurstCount == 0, "a burst that minted nothing records nothing");
            plugin.noteAgentBurst(100, 104);
            check(!plugin.agentMintedSerial(100) && plugin.agentMintedSerial(101) && plugin.agentMintedSerial(104) && !plugin.agentMintedSerial(105),
                  "a burst owns exactly the serials after its start up to its end");
            plugin.noteAgentBurst(104, 110);
            check(plugin.m_agentBurstCount == 1 && plugin.agentMintedSerial(110), "a burst right after another extends it");
            plugin.noteAgentBurst(120, 121);
            check(plugin.m_agentBurstCount == 2 && !plugin.agentMintedSerial(115), "a gap - the human, KWin itself - stays out");
            plugin.noteAgentBurst(0xfffffffeu, 3);
            check(plugin.agentMintedSerial(0xffffffffu) && plugin.agentMintedSerial(0) && plugin.agentMintedSerial(3) && !plugin.agentMintedSerial(4),
                  "a burst across the wrap is still one range");
            SynaraComputerUsePlugin full;
            for (quint32 i = 0; i < 600; ++i) full.noteAgentBurst(1000 + i * 10, 1000 + i * 10 + 2);
            check(full.m_agentBurstCount == 512, "the ring is bounded");
            check(!full.agentMintedSerial(1001) && full.agentMintedSerial(1000 + 599 * 10 + 1), "the oldest bursts give way to the newest");
        }

        // KWin's rule, and the agent's serials taken out of it.
        check(!activationTokenGranted(true, true, true, 0, 50, 60), "an agent serial is refused even to a privileged client or the active window");
        check(activationTokenGranted(false, true, false, 90, 10, 100), "a privileged client needs no serial of its own");
        check(activationTokenGranted(false, false, true, 90, 10, 100), "the active window may ask with any serial");
        check(activationTokenGranted(false, false, false, 90, 90, 100), "the human's own last interaction is granted");
        check(!activationTokenGranted(false, false, false, 90, 89, 100), "anything older than the human's last interaction is refused");
        check(!activationTokenGranted(false, false, false, 90, 101, 100), "a serial from the future is refused");
        check(activationTokenGranted(false, false, false, 0xfffffff0u, 5, 10), "serials compare with wrap-around, as in KWin");

        ClientConnection app, shell;
        shell.requested = {"org_kde_plasma_window_management"};
        SurfaceInterface humanWindowSurface, agentWindowSurface, launcherSurface;
        Window humanWindow{&humanWindowSurface};
        Workspace& workspace = *Workspace::self();
        SeatInterface seat0;
        {
            // The measured case: the human types in one window of a browser,
            // the agent clicks another, and the browser asks for a token with
            // the click's serial - from its active window, which KWin grants
            // any serial.
            SynaraComputerUsePlugin plugin;
            inputObject.lastInteraction = 90;
            workspace.active = &humanWindow;
            plugin.noteAgentBurst(95, 98);
            plugin.display = 98;
            check(plugin.createActivationToken(&app, &humanWindowSurface, 97, &seat0, "chromium") == "not-granted-666",
                  "a token quoting the agent's click is refused, even from the active window");
            check(plugin.createActivationToken(&app, &agentWindowSurface, 97, &seat0, "chromium") == "not-granted-666",
                  "and from the window the agent clicked");
            check(plugin.createActivationToken(&app, &agentWindowSurface, 5, &plugin.agentSeat, "chromium") == "not-granted-666",
                  "a token quoting the agent's own seat is refused");
            check(plugin.createActivationToken(&shell, nullptr, 96, &seat0, "org.kde.dolphin") == "not-granted-666",
                  "a privileged client launching on the agent's click gets nothing either");
            check(plugin.m_activationTokensRefused == 4 && server.integration.issued == 0, "every refusal is counted, and KWin issued nothing");
        }
        {
            // The human launches: their click is the last interaction, the
            // agent keeps working, and the launch still carries the human's
            // serial - KWin's last interaction never moved.
            SynaraComputerUsePlugin plugin;
            inputObject.lastInteraction = 200;
            workspace.active = &humanWindow;
            plugin.display = 200;
            const QString token = plugin.createActivationToken(&app, &launcherSurface, 200, &seat0, "org.kde.kate");
            check(token == "kwin-1", "the human's launch is granted");
            check(workspace.stored.token == token && workspace.stored.serial == UInt32Serial(200) && workspace.stored.appId == "org.kde.kate",
                  "KWin stores the token with the client's own serial, as for any unprivileged request");
            plugin.noteAgentBurst(200, 230);
            plugin.display = 230;
            check(input()->lastInteractionSerial() == 200, "the agent's burst leaves KWin's last interaction alone, so the window may activate when it maps");
            inputObject.lastInteraction = 240;
            plugin.display = 240;
            const QString shellToken = plugin.createActivationToken(&shell, nullptr, 0, &seat0, "org.kde.konsole");
            check(shellToken == "kwin-2" && workspace.stored.serial == UInt32Serial(240),
                  "a privileged launch keeps KWin's own serial, the human's last interaction");
            check(plugin.createActivationToken(&app, &launcherSurface, 239, &seat0, "x") == "not-granted-666",
                  "an unprivileged serial older than the human's last interaction is still refused, as by KWin");
        }
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "activation tokens: the agent's serials refused, KWin's rule otherwise, the human's launch untouched.\n";
}
