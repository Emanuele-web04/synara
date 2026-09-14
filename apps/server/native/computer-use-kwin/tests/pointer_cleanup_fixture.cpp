#include <cstdint>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using quint32 = uint32_t;
struct Buttons {
    std::set<quint32> held;
    void insert(quint32 button) { held.insert(button); }
    void remove(quint32 button) { held.erase(button); }
    std::vector<quint32> values() const { return {held.begin(), held.end()}; }
};
struct Focus {
    int window = 0;
    explicit operator bool() const { return window != 0; }
    void clear() { window = 0; }
};
struct Event {
    std::string kind;
    int window;
    quint32 button = 0;
    bool pressed = false;
};
std::vector<Event> events;
enum class PointerButtonState { Pressed, Released };
struct Seat {
    int focus = 0;
    void notifyPointerButton(quint32 button, PointerButtonState state) {
        events.push_back({"seat-button", focus, button, state == PointerButtonState::Pressed});
    }
    void notifyPointerFrame() {}
    void notifyPointerLeave() {
        events.push_back({"seat-leave", focus});
        focus = 0;
    }
};
struct InputDevice {
    void sendButton(quint32 button, bool pressed) { events.push_back({"device-button", 1, button, pressed}); }
};
struct SynaraComputerUsePlugin {
    bool m_ownsCompositor = false, m_pointerDirect = false;
    Focus m_directPointerSurface, m_pointerWindow;
    Buttons m_pressedButtons;
    Seat* m_seat;
    InputDevice* m_inputDevice;

    bool inputReady() const { return true; }
    void setTimestampNow() {}
    void directPointerButton(quint32 button, bool pressed) {
        events.push_back({"direct-button", m_directPointerSurface.window, button, pressed});
    }
    void directPointerLeave() {
        events.push_back({"direct-leave", m_directPointerSurface.window});
        m_directPointerSurface.clear();
    }
    void sendButton(quint32 button, bool pressed);
    void releasePressedButtons();
    void clearPointerDelivery();
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    for (const bool direct : {false, true}) {
        Seat seat;
        InputDevice device;
        SynaraComputerUsePlugin plugin;
        plugin.m_seat = &seat;
        plugin.m_inputDevice = &device;
        plugin.m_pointerWindow.window = 7;
        plugin.m_pointerDirect = direct;
        if (direct) plugin.m_directPointerSurface.window = 7;
        else seat.focus = 7;

        plugin.sendButton(272, true);
        plugin.sendButton(273, true);
        events.clear();

        // Both leaving the target's bounds and entering empty desktop call
        // this cleanup without assigning a replacement target first.
        plugin.clearPointerDelivery();
        check(events.size() == 3, "held buttons were not released before leaving");
        for (size_t i = 0; i < 2; ++i) {
            check(events[i].kind == (direct ? "direct-button" : "seat-button"), "release used the wrong input path");
            check(events[i].window == 7, "release lost its original window");
            check(events[i].button == 272 + i && !events[i].pressed, "held button did not receive its release");
        }
        check(events[2].kind == (direct ? "direct-leave" : "seat-leave") && events[2].window == 7,
              "old focus was not cleared after releasing buttons");
        check(plugin.m_pressedButtons.held.empty(), "cleanup retained held buttons");
        check(!plugin.m_pointerWindow && !plugin.m_directPointerSurface && !plugin.m_pointerDirect,
              "cleanup retained pointer delivery");

        plugin.clearPointerDelivery();
        check(events.size() == 3, "repeated cleanup duplicated input");
    }
    std::cout << "Direct and agent-seat pointer cleanup releases held buttons before dropping focus.\n";
}
