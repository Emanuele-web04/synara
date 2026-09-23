// The popup rule (audit N2), driven through the production attribution, grab
// check and dismissal against modelled windows: an agent-opened popup never
// grabs, a human press outside it closes it and still goes through, and a
// wrong creation-time guess is closed rather than left grabbing seat0.
#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using quint32 = uint32_t;
using quint64 = uint64_t;
using qint64 = int64_t;

struct QPointF {
    double xv = 0, yv = 0;
    double x() const { return xv; }
    double y() const { return yv; }
};
template <class T> struct QPointer {
    T* p = nullptr;
    QPointer() = default;
    QPointer(T* v) : p(v) {}
    operator T*() const { return p; }
    T* operator->() const { return p; }
};
template <class T> struct QList : std::vector<T> {
    using std::vector<T>::vector;
    bool isEmpty() const { return this->empty(); }
    void append(const T& v) { this->push_back(v); }
    template <class U> void removeAll(const U& v) { this->erase(std::remove(this->begin(), this->end(), T(v)), this->end()); }
};
struct QElapsedTimer {
    bool valid = false;
    qint64 ms = 0;
    void restart() { valid = true; ms = 0; }
    bool isValid() const { return valid; }
    qint64 elapsed() const { return ms; }
};
struct SynaraSerialBurst {
    quint32 after = 0;
    quint32 last = 0;
};
struct ClientConnection {};
struct SurfaceInterface {
    ClientConnection* owner = nullptr;
    ClientConnection* client() const { return owner; }
};
struct PointerInterface {
    SurfaceInterface* focus = nullptr;
    SurfaceInterface* focusedSurface() const { return focus; }
};
struct SeatInterface {
    PointerInterface pointerObject;
    PointerInterface* pointer() { return &pointerObject; }
};
std::vector<std::string> dismissed;
struct Window {
    std::string name;
    double x = 0, y = 0, w = 0, h = 0;
    bool deleted = false;
    SurfaceInterface* surf = nullptr;
    bool popupWindow = true;
    std::vector<std::function<void()>> closedHandlers;
    bool isDeleted() const { return deleted; }
    bool hitTest(const QPointF& p) const { return p.x() >= x && p.x() < x + w && p.y() >= y && p.y() < y + h; }
    void popupDone() { dismissed.push_back(name); deleted = true; }
    SurfaceInterface* surface() const { return surf; }
    bool isPopupWindow() const { return popupWindow; }
    void closed() {}
};
struct WaylandServer {
    SeatInterface seat0;
    std::vector<Window*> windows;
    SeatInterface* seat() { return &seat0; }
    Window* findWindow(const SurfaceInterface* s) const {
        for (Window* w : windows) if (s && w->surf == s) return w;
        return nullptr;
    }
};
WaylandServer server;
WaylandServer* waylandServer() { return &server; }
SurfaceInterface* humanKeyboardSurface() { return nullptr; }
// xdg_popup as KWin exposes it: the popup's and its parent's surfaces, and the
// grab request, which KWin's XdgPopupWindow is connected to (kwinGrab) before
// the plugin sees the popup.
struct XdgPopupInterface {
    SurfaceInterface* s = nullptr;
    SurfaceInterface* parent = nullptr;
    bool kwinGrab = true;
    std::vector<std::function<void(SeatInterface*, quint32)>> grabHandlers;
    SurfaceInterface* surface() const { return s; }
    SurfaceInterface* parentSurface() const { return parent; }
    void grabRequested(SeatInterface*, quint32) {}
    // The client asks for its grab: KWin records it, then the plugin hears it.
    bool requestGrab(SeatInterface* seat, quint32 serial) {
        const bool kwinRecorded = kwinGrab;
        for (auto& handler : grabHandlers) handler(seat, serial);
        return kwinRecorded;
    }
};
// Where a finger or a pen lands: the window KWin gives that point to.
struct InputRedirection {
    Window* under = nullptr;
    Window* findToplevel(const QPointF&) const { return under; }
} inputObject;
InputRedirection* input() { return &inputObject; }
struct QObject {
    static void disconnect(XdgPopupInterface* popup, void (XdgPopupInterface::*)(SeatInterface*, quint32), Window*, std::nullptr_t) { popup->kwinGrab = false; }
};

// PRODUCTION_FREE

struct SynaraComputerUsePlugin {
    SeatInterface agentSeat;
    SeatInterface* m_seat = &agentSeat;
    QList<QPointer<Window>> m_agentPopups;
    QList<QPointer<Window>> m_withheldGrabPopups;
    quint64 m_popupsDismissed = 0;
    const ClientConnection* m_lastHumanPressClient = nullptr;
    QElapsedTimer m_lastHumanPress;
    std::array<SynaraSerialBurst, 512> m_agentBursts = {};
    size_t m_agentBurstNext = 0;
    size_t m_agentBurstCount = 0;

    void connect(Window* window, void (Window::*)(), SynaraComputerUsePlugin*, std::function<void()> f) { window->closedHandlers.push_back(std::move(f)); }
    void connect(XdgPopupInterface* popup, void (XdgPopupInterface::*)(SeatInterface*, quint32), SynaraComputerUsePlugin*, std::function<void(SeatInterface*, quint32)> f) {
        popup->grabHandlers.push_back(std::move(f));
    }
    const ClientConnection* m_lastAgentPressClient = nullptr;
    QElapsedTimer m_lastAgentPress;
    void handlePopupCreated(XdgPopupInterface* popup);
    void handlePopupGrab(Window* window, SeatInterface* seat, quint32 serial);
    bool isAgentPopup(const Window* window) const;
    void dismissAgentPopups(const std::function<bool(const Window*)>& shouldDismiss);
    void noteAgentBurst(quint32 after, quint32 last);
    bool agentMintedSerial(quint32 serial) const;
    void handleHumanPointerPress(const QPointF& position, bool byPointerFocus);
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        // Attribution at creation.
        check(popupOpenedByAgent(PopupOwner::Unknown, 30, -1), "the agent pressed into this client and the human never did");
        check(popupOpenedByAgent(PopupOwner::Unknown, 30, 900), "the agent pressed more recently than the human");
        check(!popupOpenedByAgent(PopupOwner::Unknown, 900, 30), "the human pressed more recently");
        check(!popupOpenedByAgent(PopupOwner::Unknown, -1, -1), "nobody pressed: KWin's own rules");
        check(!popupOpenedByAgent(PopupOwner::Unknown, s_popupAttributionMs + 1, -1), "an old agent press does not claim a popup");
        check(popupOpenedByAgent(PopupOwner::Agent, -1, 5), "a submenu of the agent's menu is the agent's");
        check(!popupOpenedByAgent(PopupOwner::Human, 5, -1), "a submenu of the human's menu is the human's");

        ClientConnection chromium;
        SurfaceInterface page{&chromium};
        {
            // The grab check against the exact answer, when the request comes.
            SynaraComputerUsePlugin plugin;
            SeatInterface& seat0 = server.seat0;
            Window agentMenu{"agent-menu", 100, 100, 50, 80};
            Window agentSeatMenu{"agent-seat-menu", 200, 100, 50, 80};
            Window humanMenu{"human-menu", 400, 100, 50, 80};
            plugin.m_withheldGrabPopups.append(&agentMenu);
            plugin.m_withheldGrabPopups.append(&agentSeatMenu);
            // A burst that minted 4240..4242, the press among them.
            plugin.noteAgentBurst(4239, 4242);
            dismissed.clear();
            plugin.handlePopupGrab(&agentSeatMenu, &plugin.agentSeat, 1);
            plugin.handlePopupGrab(&agentMenu, &seat0, 4242);
            check(dismissed.empty(), "an agent popup grabbing with the agent seat or an agent serial is left open");
            check(plugin.isAgentPopup(&agentMenu) && plugin.isAgentPopup(&agentSeatMenu) && plugin.m_withheldGrabPopups.empty(),
                  "a withheld popup becomes the agent's when its grab arrives");
            plugin.handlePopupGrab(&humanMenu, &seat0, 17);
            check(dismissed.empty() && !plugin.isAgentPopup(&humanMenu), "a human popup grabbing with a human serial is left alone");
            plugin.handlePopupGrab(&humanMenu, &seat0, 4242);
            check(dismissed.size() == 1 && dismissed[0] == "human-menu", "a grab quoting an agent serial on a popup that kept its grab is closed");
            Window lateAgent{"late-agent", 0, 0, 1, 1};
            plugin.handlePopupGrab(&lateAgent, &plugin.agentSeat, 9);
            check(dismissed.size() == 2 && dismissed[1] == "late-agent", "an agent-seat grab that got through is closed before it maps");
            Window misread{"misread", 0, 0, 1, 1};
            plugin.m_withheldGrabPopups.append(&misread);
            plugin.handlePopupGrab(&misread, &seat0, 17);
            check(dismissed.size() == 3 && dismissed[2] == "misread", "a human grab on a popup taken for the agent's is closed, not left without its grab");
            plugin.handlePopupGrab(&humanMenu, &seat0, 0);
            check(dismissed.size() == 3, "serial 0 never matches the empty slots of the ring");
            plugin.handlePopupGrab(&humanMenu, &seat0, 4239);
            plugin.handlePopupGrab(&humanMenu, &seat0, 4243);
            check(dismissed.size() == 3, "the serials either side of the burst are not the agent's");
            check(plugin.m_popupsDismissed == 3, "every dismissal is counted");
        }
        {
            // A popup taken for the agent's that never asks for a grab - a
            // tooltip after the agent's click - is nobody's: a human press
            // elsewhere does not close it.
            SynaraComputerUsePlugin plugin;
            Window tooltip{"tooltip", 100, 100, 50, 20};
            plugin.m_withheldGrabPopups.append(&tooltip);
            dismissed.clear();
            plugin.handleHumanPointerPress({900, 900}, true);
            check(dismissed.empty() && !plugin.isAgentPopup(&tooltip), "a grab-less popup was closed by the human's click");
        }
        {
            // A human press: recorded, and it closes the agent's popups unless
            // it lands on one of them.
            SynaraComputerUsePlugin plugin;
            Window menu{"menu", 100, 100, 50, 80};
            Window submenu{"submenu", 150, 120, 50, 80};
            plugin.m_agentPopups.append(&menu);
            plugin.m_agentPopups.append(&submenu);
            server.seat0.pointerObject.focus = &page;
            dismissed.clear();
            plugin.handleHumanPointerPress({160, 130}, true);
            check(dismissed.empty(), "a human press on the agent's menu is theirs to make");
            check(plugin.m_lastHumanPressClient == &chromium && plugin.m_lastHumanPress.isValid(), "the press is recorded against seat0's pointer focus");
            plugin.handleHumanPointerPress({900, 900}, true);
            check(dismissed.size() == 2 && dismissed[0] == "submenu" && dismissed[1] == "menu", "a press elsewhere closes the agent's popups, submenu first");
        }
        {
            // A touch goes where the finger is, wherever the pointer rests:
            // attributed to the window under it, not to seat0's pointer focus.
            SynaraComputerUsePlugin plugin;
            ClientConnection terminal;
            SurfaceInterface terminalSurface{&terminal};
            Window terminalWindow{"terminal"};
            terminalWindow.surf = &terminalSurface;
            server.seat0.pointerObject.focus = &page;
            inputObject.under = &terminalWindow;
            plugin.handleHumanPointerPress({10, 10}, false);
            check(plugin.m_lastHumanPressClient == &terminal, "a touch was attributed to the pointer's client");
            inputObject.under = nullptr;
            plugin.handleHumanPointerPress({10, 10}, false);
            check(plugin.m_lastHumanPressClient == nullptr, "a touch on nothing is attributed to nobody");
        }
        {
            // The whole flow: the agent's press, the popup, its grab.
            SynaraComputerUsePlugin plugin;
            ClientConnection app;
            SurfaceInterface parentSurface{&app}, menuSurface{&app};
            Window parentWindow{"parent"};
            parentWindow.surf = &parentSurface;
            parentWindow.popupWindow = false;
            Window menu{"menu"};
            menu.surf = &menuSurface;
            server.windows = {&parentWindow, &menu};
            plugin.m_lastAgentPressClient = &app;
            plugin.m_lastAgentPress.restart();
            plugin.m_lastAgentPress.ms = 20;
            XdgPopupInterface popup{&menuSurface, &parentSurface};
            plugin.handlePopupCreated(&popup);
            check(!popup.kwinGrab && !plugin.isAgentPopup(&menu), "KWin's grab is cut at creation, attribution waits for the request");
            plugin.noteAgentBurst(30, 33);
            dismissed.clear();
            check(!popup.requestGrab(&server.seat0, 32), "KWin recorded the agent's grab");
            check(plugin.isAgentPopup(&menu) && dismissed.empty(), "the agent's grab made the popup the agent's");
        }
        {
            // A popup whose window is gone before its grab request arrives:
            // the request is dropped, never handed a dead window.
            SynaraComputerUsePlugin plugin;
            ClientConnection app;
            SurfaceInterface parentSurface{&app}, popupSurface{&app};
            Window parentWindow{"parent"};
            parentWindow.surf = &parentSurface;
            parentWindow.popupWindow = false;
            Window gone{"gone"};
            gone.surf = &popupSurface;
            server.windows = {&parentWindow, &gone};
            XdgPopupInterface popup{&popupSurface, &parentSurface};
            plugin.handlePopupCreated(&popup);
            gone.deleted = true;
            dismissed.clear();
            plugin.noteAgentBurst(10, 20);
            popup.requestGrab(&server.seat0, 15);
            check(dismissed.empty() && plugin.m_popupsDismissed == 0, "a grab request for a destroyed popup window was acted on");
        }
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "popup rule: attribution, the exact grab check, and dismissal on a human press outside.\n";
}
