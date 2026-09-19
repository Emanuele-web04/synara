// Window ids must survive address reuse: a new window at the address of a
// closed one must get a different id, and the closed one's id must never
// resolve again. The desktop is modelled as the list of currently existing
// windows.
#include <cstdint>
#include <format>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

struct Window { int payload = 0; };
using PHLWINDOW = std::shared_ptr<Window>;
using PHLWINDOWREF = std::weak_ptr<Window>;
std::vector<PHLWINDOW> desktop;
struct WindowState { const std::vector<PHLWINDOW>& windows() { return desktop; } };
namespace Desktop { WindowState* windowState() { static WindowState s; return &s; } }
void check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

// Object memory is recycled through one slot, separately from the shared
// pointer's control block, the way Hyprland's CSharedPointer frees the object
// while weak references still hold the block: the window allocated right
// after another is closed lands at the closed one's address, which is the
// reuse the ids must survive - deterministic here instead of left to the
// system allocator.
void* recycledSlot = nullptr;
PHLWINDOW newWindow() {
    void* memory = recycledSlot ? std::exchange(recycledSlot, nullptr) : ::operator new(sizeof(Window));
    return PHLWINDOW(new (memory) Window, [](Window* w) {
        w->~Window();
        if (!recycledSlot) recycledSlot = w; else ::operator delete(w);
    });
}

// PRODUCTION_DEFINITIONS

int main() {
    auto first = newWindow();
    desktop.push_back(first);
    const std::string firstId = windowId(first);
    check(windowId(first) == firstId, "id not stable while the window lives");
    check(findWindowById(firstId) == first, "live id did not resolve");
    check(findWindowById("0x" + firstId) == first, "0x-prefixed id did not resolve");
    for (const char* bad : {"", "-", "zz-1", "12ab", "12ab-", "-3", "12ab-x", "12ab-99"})
        check(findWindowById(bad) == nullptr, "malformed or unknown id resolved");

    // Closed: alive as an object no longer, and out of the desktop list.
    const auto* firstAddress = first.get();
    desktop.clear();
    first.reset();
    check(findWindowById(firstId) == nullptr, "closed window's id resolved");

    auto second = newWindow();
    check(second.get() == firstAddress, "fixture: the recycled block was not reused");
    desktop.push_back(second);
    const std::string secondId = windowId(second);
    check(secondId != firstId, "reused address kept the closed window's id");
    check(findWindowById(firstId) == nullptr, "closed window's id resolved to the new window at its address");
    check(findWindowById(secondId) == second, "new window's id did not resolve");

    // A window that is alive but no longer listed is not a target.
    desktop.clear();
    check(findWindowById(secondId) == nullptr, "unlisted window resolved");
    desktop.push_back(second);
    check(findWindowById(secondId) == second, "relisted window did not resolve");

    // Pruning keeps entries for live windows only.
    auto third = newWindow();
    desktop.push_back(third);
    const std::string thirdId = windowId(third);
    desktop.erase(desktop.begin());
    second.reset();
    forgetDeadWindowIds();
    check(windowIdentities.size() == 1, "pruning kept a dead window's entry");
    check(findWindowById(thirdId) == third, "pruning dropped a live window's entry");
    std::cout << "window ids survive address reuse, unlisting and pruning.\n";
}
