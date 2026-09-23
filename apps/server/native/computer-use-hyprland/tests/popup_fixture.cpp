// The popup rule against modelled xdg-shell objects, no compositor: a grab
// quoting a serial of the agent's (or asked for by a submenu of an agent
// popup) never reaches Hyprland's handler, every other grab does, a human
// press outside the agent's popups closes them and one on them does not, an
// agent press into another application closes them, and unloading puts
// Hyprland's handler back on every popup.
#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

template <typename T> using SP = std::shared_ptr<T>;
template <typename T> using WP = std::weak_ptr<T>;
void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

struct Vector2D { double x = 0, y = 0; };
struct CBox {
    double x = 0, y = 0, w = 0, h = 0;
    bool containsPoint(const Vector2D& p) const { return p.x >= x && p.x < x + w && p.y >= y && p.y < y + h; }
};
struct wl_client {};
struct wl_resource {};
struct CXdgPopup {
    struct { std::function<void(CXdgPopup*, wl_resource*, uint32_t)> grab; } requests;
};
enum eSurfaceRole { SURFACE_ROLE_UNASSIGNED, SURFACE_ROLE_XDG_SHELL };
struct ISurfaceRole { virtual ~ISurfaceRole() = default; virtual eSurfaceRole role() = 0; };
struct CXDGSurfaceResource;
struct CXDGSurfaceRole : ISurfaceRole {
    WP<CXDGSurfaceResource> m_xdgSurface;
    eSurfaceRole role() override { return SURFACE_ROLE_XDG_SHELL; }
};
struct CWLSurfaceResource {
    wl_client* owner = nullptr;
    CBox box;
    SP<ISurfaceRole> m_role;
    wl_client* client() const { return owner; }
};
struct CXDGPopupResource;
struct CXDGSurfaceResource {
    WP<CWLSurfaceResource> m_surface;
    WP<CXDGPopupResource> m_popup;
};
std::vector<std::string> dismissed;
struct CXDGPopupResource {
    std::string name;
    WP<CXDGSurfaceResource> m_surface;
    WP<CXDGSurfaceResource> m_parent;
    CXdgPopup protocol;
    void done() { dismissed.push_back(name); }
};
namespace Desktop::View {
enum eViewType { VIEW_TYPE_WINDOW, VIEW_TYPE_POPUP };
struct IView {
    eViewType kind = VIEW_TYPE_POPUP;
    SP<CWLSurfaceResource> surface;
    eViewType type() const { return kind; }
    SP<CWLSurfaceResource> resource() const { return surface; }
};
struct CWLSurface {
    SP<CWLSurfaceResource> surface;
    std::optional<CBox> getSurfaceBoxGlobal() const { return surface->box; }
    static SP<CWLSurface> fromResource(const SP<CWLSurfaceResource>& s) { return s ? std::make_shared<CWLSurface>(CWLSurface{s}) : nullptr; }
};
}
using PHLVIEW = SP<Desktop::View::IView>;
struct InputManager {
    Vector2D mouse;
    Vector2D getMouseCoordsInternal() const { return mouse; }
} inputManager;
InputManager* g_pInputManager = &inputManager;
std::function<void(CXdgPopup*, wl_resource*, uint32_t)>* popupGrabHandler(const SP<CXDGPopupResource>& popup) {
    return popup ? &popup->protocol.requests.grab : nullptr;
}

// PRODUCTION_STRUCTS

struct {
    std::array<SSerialBurst, 512> agentBursts{};
    size_t agentBurstNext = 0;
    size_t agentBurstCount = 0;
    std::vector<SWatchedPopup> watchedPopups;
    std::vector<WP<CXDGPopupResource>> agentPopups;
    uint64_t popupsDismissed = 0;
} g;

// PRODUCTION_DEFINITIONS

// One xdg surface of `client`, with a popup role when `popup` is given.
struct Made {
    SP<CWLSurfaceResource> surface;
    SP<CXDGSurfaceResource> xdg;
    SP<CXDGPopupResource> popup;
    PHLVIEW view;
};
Made make(wl_client* client, const std::string& name, CBox box, const SP<CXDGSurfaceResource>& parent, int* hyprlandGrabs) {
    Made m;
    m.surface = std::make_shared<CWLSurfaceResource>(CWLSurfaceResource{client, box, nullptr});
    m.xdg = std::make_shared<CXDGSurfaceResource>();
    m.xdg->m_surface = m.surface;
    auto role = std::make_shared<CXDGSurfaceRole>();
    role->m_xdgSurface = m.xdg;
    m.surface->m_role = role;
    if (hyprlandGrabs) {
        m.popup = std::make_shared<CXDGPopupResource>();
        m.popup->name = name;
        m.popup->m_surface = m.xdg;
        m.popup->m_parent = parent;
        m.xdg->m_popup = m.popup;
        m.popup->protocol.requests.grab = [hyprlandGrabs](CXdgPopup*, wl_resource*, uint32_t) { ++*hyprlandGrabs; };
        m.view = std::make_shared<Desktop::View::IView>(Desktop::View::IView{Desktop::View::VIEW_TYPE_POPUP, m.surface});
    }
    return m;
}
void grab(const Made& m, uint32_t serial) {
    m.popup->protocol.requests.grab(&m.popup->protocol, nullptr, serial);
}

int main() {
    // The agent's serials: exact ranges, wrap-safe, adjacent bursts merged.
    noteAgentBurst(100, 100);
    check(g.agentBurstCount == 0, "a burst that minted nothing records nothing");
    noteAgentBurst(100, 104);
    noteAgentBurst(104, 106);
    check(g.agentBurstCount == 1, "a burst right after another extends it");
    check(!agentMintedSerial(100) && agentMintedSerial(101) && agentMintedSerial(106) && !agentMintedSerial(107), "a burst owns exactly the serials it minted");
    noteAgentBurst(0xfffffffeu, 2);
    check(agentMintedSerial(0xffffffffu) && agentMintedSerial(0) && agentMintedSerial(2) && !agentMintedSerial(3), "a burst across the wrap is one range");

    wl_client browser, editor;
    int hyprlandGrabs = 0;
    const Made page = make(&browser, "page", {0, 0, 800, 600}, nullptr, nullptr);
    const Made kate = make(&editor, "kate", {900, 0, 800, 600}, nullptr, nullptr);

    // The agent's click opened a menu: its grab never reaches Hyprland.
    const Made menu = make(&browser, "menu", {100, 100, 200, 150}, page.xdg, &hyprlandGrabs);
    watchPopup(menu.view);
    check(g.watchedPopups.size() == 1, "a new popup's grab is answered here");
    grab(menu, 102);
    check(hyprlandGrabs == 0 && agentPopupCount() == 1, "an agent grab is withheld and the popup recorded as the agent's");
    // Its submenu quotes an older serial, but belongs to the agent's menu.
    const Made submenu = make(&browser, "submenu", {300, 120, 200, 150}, menu.xdg, &hyprlandGrabs);
    watchPopup(submenu.view);
    grab(submenu, 50);
    check(hyprlandGrabs == 0 && agentPopupCount() == 2, "a submenu of the agent's menu is the agent's");

    // The human's own menu keeps Hyprland's grab.
    const Made humanMenu = make(&editor, "human-menu", {1000, 100, 200, 150}, kate.xdg, &hyprlandGrabs);
    watchPopup(humanMenu.view);
    grab(humanMenu, 90);
    check(hyprlandGrabs == 1 && agentPopupCount() == 2, "a human grab goes to Hyprland's own handler, unchanged");

    // A popup that never asks for a grab is nobody's.
    const Made tooltip = make(&browser, "tooltip", {50, 50, 100, 30}, page.xdg, &hyprlandGrabs);
    watchPopup(tooltip.view);
    check(agentPopupCount() == 2, "a grab-less popup is not the agent's to dismiss");

    // A human press on the agent's menu is theirs to make; one elsewhere
    // closes the agent's popups, submenu first, and goes on.
    inputManager.mouse = {150, 150};
    handleHumanPointerPress();
    check(dismissed.empty(), "a press on the agent's menu closed it");
    inputManager.mouse = {1200, 500};
    handleHumanPointerPress();
    check(dismissed == std::vector<std::string>{"submenu", "menu"}, "a press elsewhere closes the agent's popups, newest first");
    check(g.popupsDismissed == 2 && agentPopupCount() == 0, "every dismissal is counted");

    // An agent press into another application closes its popups there, and
    // one into the same application leaves them.
    const Made menu2 = make(&browser, "menu2", {100, 100, 200, 150}, page.xdg, &hyprlandGrabs);
    watchPopup(menu2.view);
    grab(menu2, 103);
    dismissed.clear();
    handleAgentPress(&browser);
    check(dismissed.empty(), "an agent press in the menu's own application closed it");
    handleAgentPress(&editor);
    check(dismissed == std::vector<std::string>{"menu2"}, "an agent press into another application left its menu open");

    // A toplevel view, or a surface of no xdg role, is not watched.
    const auto before = g.watchedPopups.size();
    auto window = std::make_shared<Desktop::View::IView>(Desktop::View::IView{Desktop::View::VIEW_TYPE_WINDOW, page.surface});
    watchPopup(window);
    watchPopup(nullptr);
    check(g.watchedPopups.size() == before, "only popups are watched");

    // Unload: Hyprland's handler goes back on every popup still alive.
    const Made late = make(&browser, "late", {0, 0, 10, 10}, page.xdg, &hyprlandGrabs);
    watchPopup(late.view);
    unwatchPopups();
    check(g.watchedPopups.empty(), "watches outlived the unload");
    const int grabsBefore = hyprlandGrabs;
    grab(late, 104);
    check(hyprlandGrabs == grabsBefore + 1, "after unload the grab is Hyprland's again, even quoting an agent serial");
}
