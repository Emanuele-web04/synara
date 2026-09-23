#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

// KWin 6.7.4's InputRedirection, reduced to what the agent's device meets:
// addInputDevice() connects the device's signals to the input pipeline, and
// removeInputDevice() only drops it from the device list, leaving those
// connections in place (input.cpp, addInputDevice/removeInputDevice).
struct QObject;
std::vector<QObject*> deferredDeletes;

struct QObject {
    explicit QObject(QObject* = nullptr) {}
    virtual ~QObject() = default;
    void deleteLater() { deferredDeletes.push_back(this); }
};

int keysDelivered = 0;

struct InputDevice : QObject {
    using QObject::QObject;
    // Destroying a QObject drops every connection it is the sender of.
    std::vector<std::function<void()>> keyChangedSlots;
    void sendKey() {
        for (const auto& slot : keyChangedSlots) slot();
    }
};
using SynaraVirtualInputDevice = InputDevice;

struct InputRedirection {
    std::vector<InputDevice*> devices;
    void addInputDevice(InputDevice* device) {
        device->keyChangedSlots.push_back([] { ++keysDelivered; });
        devices.push_back(device);
    }
    void removeInputDevice(InputDevice* device) { std::erase(devices, device); }
};
InputRedirection redirection;
InputRedirection* input() { return &redirection; }

struct SynaraComputerUsePlugin : QObject {
    std::unique_ptr<SynaraVirtualInputDevice> m_inputDevice;
    bool m_deviceAttached = false;
    void attachInputDevice();
    void detachInputDevice();
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

void runEventLoop() {
    for (QObject* object : std::exchange(deferredDeletes, {})) delete object;
}

int main() {
    SynaraComputerUsePlugin plugin;
    plugin.m_inputDevice = std::make_unique<SynaraVirtualInputDevice>(&plugin);

    for (int cycle = 0; cycle < 3; ++cycle) {
        plugin.attachInputDevice();
        plugin.attachInputDevice();
        check(redirection.devices.size() == 1, "a running session attached its device twice");
        plugin.detachInputDevice();
        plugin.detachInputDevice();
        check(redirection.devices.empty(), "a stopped session left its device attached");
        check(plugin.m_inputDevice != nullptr, "a stopped session has no device for the next start");
    }
    check(deferredDeletes.size() == 3, "every retired device was not scheduled for deletion");
    runEventLoop();

    plugin.attachInputDevice();
    keysDelivered = 0;
    plugin.m_inputDevice->sendKey();
    check(keysDelivered == 1, "a key after three stop/start cycles was delivered more than once");

    // Retired before its deferred delete ran: still no second delivery path.
    InputDevice* retired = plugin.m_inputDevice.get();
    plugin.detachInputDevice();
    plugin.attachInputDevice();
    check(plugin.m_inputDevice.get() != retired, "a restart reused the retired device");
    keysDelivered = 0;
    plugin.m_inputDevice->sendKey();
    check(keysDelivered == 1, "a key right after a restart was delivered more than once");
    runEventLoop();
    plugin.detachInputDevice();
    runEventLoop();

    std::cout << "Every session start attaches a fresh device, so each agent event is delivered once.\n";
}
