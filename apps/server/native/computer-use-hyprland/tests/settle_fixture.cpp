// waitForSettle's bookkeeping with a hand-driven clock and timer loop, no
// compositor: which commits count, when a wait settles or times out, and that
// every wait is answered exactly once.
#include <algorithm>
#include <cstdint>
#include <format>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

template <typename T> using SP = std::shared_ptr<T>;
template <typename T> using WP = std::weak_ptr<T>;
template <typename T> using UP = std::unique_ptr<T>;
template <typename T, typename... A> UP<T> makeUnique(A&&... a) { return std::make_unique<T>(std::forward<A>(a)...); }
void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

namespace sdbus {
struct Error : std::runtime_error {
    struct Name { std::string value; };
    std::string name;
    Error(Name name, const std::string& message) : std::runtime_error(message), name(name.value) {}
};
// Records the one reply every call must get.
struct Replies { int count = 0; bool settled = false; uint32_t elapsed = 0; std::string error; };
template <typename... R> struct Result {
    SP<Replies> replies = std::make_shared<Replies>();
    void returnError(const Error& error) const {
        check(replies->count == 0, "a wait was answered twice");
        ++replies->count;
        replies->error = error.name;
    }
    void returnResults(bool settled, uint32_t elapsed) const {
        check(replies->count == 0, "a wait was answered twice");
        ++replies->count;
        replies->settled = settled;
        replies->elapsed = elapsed;
    }
};
}
namespace Log { constexpr int ERR = 0; struct Logger { template <typename... A> void log(int, A&&...) {} } instance; Logger* logger = &instance; }
constexpr const char* ERR_CAPTURE = "org.synara.ComputerUse.Error.CaptureFailed";
constexpr const char* ERR_SESSION_LOCKED = "org.synara.ComputerUse.Error.SessionLocked";

int64_t clockMs = 1000;
int64_t nowMs() { return clockMs; }

// A timer loop: the plugin arms timers, the test advances the clock and
// fires whatever has come due.
struct wl_event_source { int64_t dueMs = -1; std::function<int(void*)> fire; bool removed = false; };
struct wl_event_loop {};
std::vector<SP<wl_event_source>> timers;
wl_event_source* wl_event_loop_add_timer(wl_event_loop*, int (*fire)(void*), void*) {
    timers.push_back(std::make_shared<wl_event_source>(wl_event_source{-1, fire}));
    return timers.back().get();
}
void wl_event_source_timer_update(wl_event_source* source, int ms) { source->dueMs = ms > 0 ? clockMs + ms : -1; }
void wl_event_source_remove(wl_event_source* source) { source->removed = true; }
struct Compositor { wl_event_loop* m_wlEventLoop = nullptr; } compositor;
Compositor* g_pCompositor = &compositor;
int liveTimers() { return int(std::ranges::count_if(timers, [](const auto& t) { return !t->removed; })); }
void advance(int64_t ms) {
    const int64_t until = clockMs + ms;
    while (true) {
        wl_event_source* next = nullptr;
        for (const auto& timer : timers)
            if (!timer->removed && timer->dueMs >= 0 && timer->dueMs <= until && (!next || timer->dueMs < next->dueMs)) next = timer.get();
        if (!next) break;
        clockMs     = next->dueMs;
        next->dueMs = -1;
        next->fire(nullptr);
    }
    clockMs = until;
}

struct CWindow {};
using PHLWINDOW    = SP<CWindow>;
using PHLWINDOWREF = WP<CWindow>;
struct CRegion {
    bool dirty = false;
    bool empty() const { return !dirty; }
};
struct SSurfaceState { CRegion damage, bufferDamage; };
struct CWLSurfaceResource { PHLWINDOW owner; SSurfaceState m_current; };
using CHyprSignalListener = SP<void>;
bool locked = false;
void requireUnlockedSession() { if (locked) throw sdbus::Error(sdbus::Error::Name{ERR_SESSION_LOCKED}, "locked"); }
int drives = 0;
void driveDbus() { ++drives; }
struct { bool running = true; int64_t lastAgentInputMs = -1; } g;
PHLWINDOW editor = std::make_shared<CWindow>(), other = std::make_shared<CWindow>();
PHLWINDOW findWindowById(const std::string& id) { return id == "editor" ? editor : id == "other" ? other : nullptr; }
bool usableWindow(const PHLWINDOW& w) { return bool(w); }
PHLWINDOW windowOfSurface(SP<CWLSurfaceResource> surface) { return surface ? surface->owner : nullptr; }

// PRODUCTION_DEFINITIONS

SP<sdbus::Replies> call(const std::string& id, uint32_t quiet, uint32_t timeout) {
    sdbus::Result<bool, uint32_t> result;
    auto replies = result.replies;
    waitForSettle(std::move(result), id, quiet, timeout);
    return replies;
}
// A commit that damaged the window, or (frameOnly) one that only asked for the
// next frame callback.
void commit(const PHLWINDOW& window, bool frameOnly = false) {
    auto surface = std::make_shared<CWLSurfaceResource>(CWLSurfaceResource{window, {}});
    surface->m_current.bufferDamage.dirty = !frameOnly;
    onSurfaceCommit(surface);
}

int main() {
    commitTracking.active = true;

    // An input, the app reacts twice, then goes quiet: settled once 100 ms
    // have passed since its last commit.
    g.lastAgentInputMs = clockMs;
    advance(5);
    commit(editor); // between the input and the call: still counts
    auto a = call("editor", 100, 1500);
    check(a->count == 0, "settled before the quiet period");
    advance(50);
    commit(editor);
    advance(99);
    check(a->count == 0, "quiet period not restarted by a later commit");
    advance(1);
    check(a->count == 1 && a->settled && a->elapsed == 150, "did not settle after the quiet period");
    check(liveTimers() == 0, "settled wait left its timer armed");

    // That input is covered now: the next wait watches from the call on, and
    // a commit of another window does not count for this one.
    auto b = call("editor", 50, 300);
    commit(other);
    advance(300);
    check(b->count == 1 && !b->settled && b->elapsed == 300, "timed out wrongly or counted another window's commit");

    // "Any window" counts every window's commits.
    g.lastAgentInputMs = clockMs;
    advance(1);
    auto c = call("", 20, 1000);
    advance(10);
    commit(other);
    advance(20);
    check(c->count == 1 && c->settled, "any-window wait ignored a commit");

    // A commit from before the input does not count.
    commit(editor);
    advance(5);
    g.lastAgentInputMs = clockMs;
    auto d = call("editor", 10, 100);
    advance(100);
    check(d->count == 1 && !d->settled, "a commit from before the input counted");

    // Answered at once: no session, an unknown window; refused while locked.
    g.running = false;
    auto e    = call("editor", 10, 100);
    g.running = true;
    auto f    = call("nope", 10, 100);
    check(e->count == 1 && !e->settled && f->count == 1 && !f->settled, "unanswerable wait not answered at once");
    locked       = true;
    bool refused = false;
    try { call("editor", 10, 100); } catch (const sdbus::Error& error) { refused = error.name == ERR_SESSION_LOCKED; }
    check(refused, "wait admitted on a locked session");
    locked = false;

    // A client that commits every frame without damage settles anyway, as on
    // KWin: only damaged commits count.
    g.lastAgentInputMs = clockMs;
    advance(1);
    auto k = call("editor", 30, 1000);
    advance(5);
    commit(editor);
    for (int frame = 0; frame < 10; ++frame) {
        advance(10);
        commit(editor, true);
    }
    check(k->count == 1 && k->settled && k->elapsed == 35, "a commit without damage kept a wait from settling");

    // The limit is the KWin plugin's.
    std::vector<SP<sdbus::Replies>> many;
    for (size_t n = 0; n < MAX_SETTLE_WAITS; ++n) many.push_back(call("", 10, 1000));
    bool limited = false;
    try { call("", 10, 1000); } catch (const sdbus::Error& error) { limited = error.name == "org.freedesktop.DBus.Error.LimitsExceeded"; }
    check(MAX_SETTLE_WAITS == 16 && limited, "the pending-wait limit differs from KWin's 16");
    stopCommitTracking();
    commitTracking.active = true;

    // Locking answers every pending wait SessionLocked, once.
    auto l = call("editor", 10, 1000);
    auto m = call("", 10, 1000);
    failSettleWaits(ERR_SESSION_LOCKED, "session locked");
    stopCommitTracking();
    check(l->count == 1 && m->count == 1 && l->error == ERR_SESSION_LOCKED && m->error == ERR_SESSION_LOCKED, "a lock did not answer pending waits SessionLocked");
    commitTracking.active = true;

    // The session stopping answers every wait still pending, once.
    auto h = call("editor", 10, 1000);
    auto i = call("", 10, 1000);
    stopCommitTracking();
    check(h->count == 1 && i->count == 1 && !h->settled && !i->settled, "pending waits not answered at stop");
    advance(2000);
    check(liveTimers() == 0, "timers left armed after stop");
    std::cout << "waitForSettle settles after quiet, times out, scopes to its window and answers every call once.\n";
}
