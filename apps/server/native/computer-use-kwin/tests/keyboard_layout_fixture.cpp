// The layout stateJson reports: the one the agent's keys are interpreted with.
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using quint32 = uint32_t;
struct QString : std::string {
    using std::string::string;
    QString(const std::string& s) : std::string(s) {}
    bool isEmpty() const { return empty(); }
};
struct xkb_state { quint32 group = 0; };
enum { XKB_STATE_LAYOUT_EFFECTIVE };
quint32 xkb_state_serialize_layout(xkb_state* s, int) { return s->group; }

struct Xkb {
    std::vector<QString> shortNames{"us", "de"};
    std::vector<QString> longNames{"English (US)", "German"};
    quint32 current = 0;
    quint32 currentLayout() const { return current; }
    QString layoutShortName(int index) const { return size_t(index) < shortNames.size() ? shortNames[index] : QString(); }
    QString layoutName(quint32 index) const { return index < longNames.size() ? longNames[index] : QString(); }
};
Xkb* humanXkbObject = nullptr;
const Xkb* humanXkb() { return humanXkbObject; }

struct SynaraComputerUsePlugin {
    bool m_ownsCompositor = false;
    xkb_state* m_xkbState = nullptr;
    quint32 keyboardLayoutIndex() const;
    QString keyboardLayout() const;
    QString keyboardLayoutName() const;
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        Xkb xkb;
        humanXkbObject = &xkb;
        xkb_state agent;
        SynaraComputerUsePlugin plugin;
        plugin.m_xkbState = &agent;

        // The human switched to their second layout; the agent's keys are still
        // interpreted on the first, on both the agent seat and the direct path.
        xkb.current = 1;
        check(plugin.keyboardLayout() == "us", "the agent's layout is its own group, not the human's current one");
        check(plugin.keyboardLayoutName() == "English (US)", "the descriptive name follows the same index");

        // The agent pressed a group switch itself.
        agent.group = 1;
        check(plugin.keyboardLayout() == "de", "the agent's own group switch is reported");

        // A compositor the agent owns types through KWin's keyboard: the
        // current layout is the one that counts.
        SynaraComputerUsePlugin owned;
        owned.m_ownsCompositor = true;
        owned.m_xkbState = &agent;
        xkb.current = 0;
        check(owned.keyboardLayout() == "us", "an owned compositor reports KWin's current layout");
        xkb.current = 1;
        check(owned.keyboardLayout() == "de", "an owned compositor follows KWin's layout switch");

        // No layout list on the keymap: the descriptive name stands in rather
        // than an empty string the server could mistake for anything.
        xkb.shortNames.clear();
        agent.group = 0;
        check(plugin.keyboardLayout() == "English (US)", "a keymap without short names reports the descriptive name");

        humanXkbObject = nullptr;
        check(plugin.keyboardLayout().empty(), "no keyboard means no layout");
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "stateJson reports the layout the agent's keys are interpreted with.\n";
}
