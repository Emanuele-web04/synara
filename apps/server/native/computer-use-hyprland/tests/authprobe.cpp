#include "../sessionauth.h"
#include <iostream>
int main() {
    auto bus = sdbus::createSessionBusConnection(sdbus::ServiceName{"org.synara.ComputerUse"});
    auto object = sdbus::createObject(*bus, sdbus::ObjectPath{"/org/synara/ComputerUse"});
    SynaraSessionAuth auth(*bus, *object, [] {});
    object->addVTable(
        sdbus::registerMethod("authenticate").implementedAs([&](const std::string& token) { return auth.authenticate(token); }),
        sdbus::registerMethod("stateJson").implementedAs([&] { auth.require(); return std::string("authorized"); })
    ).forInterface(sdbus::InterfaceName{"org.synara.ComputerUse1"});
    std::cout << "ready" << std::endl;
    bus->enterEventLoop();
}
