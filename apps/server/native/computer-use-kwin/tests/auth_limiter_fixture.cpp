// The per-peer cooldown on failed authenticate() attempts, with an injected
// clock.
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <unordered_map>

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        ComputerUseAuthLimiter limiter;
        check(limiter.permits(":1.7", 0), "an unknown peer is heard");

        limiter.noteFailure(":1.7", 0);
        check(!limiter.permits(":1.7", 1), "a peer that just failed is refused without another attempt");
        check(!limiter.permits(":1.7", ComputerUseAuthLimiter::cooldownMs - 1), "the cooldown holds for its whole length");
        check(limiter.permits(":1.7", ComputerUseAuthLimiter::cooldownMs), "the cooldown lapses");
        check(limiter.permits(":1.8", 1), "another peer is unaffected");

        limiter.noteFailure(":1.7", 5000);
        limiter.noteSuccess(":1.7");
        check(limiter.permits(":1.7", 5001), "a success clears the peer's record");

        // A peer reconnecting under fresh unique names cannot grow the table.
        ComputerUseAuthLimiter crowded;
        for (size_t i = 0; i < ComputerUseAuthLimiter::maxTracked; ++i) {
            crowded.noteFailure(":9." + std::to_string(i), int64_t(i));
        }
        check(crowded.failedAt.size() == ComputerUseAuthLimiter::maxTracked, "the table fills to its bound");
        crowded.noteFailure(":9.new", int64_t(ComputerUseAuthLimiter::maxTracked));
        check(crowded.failedAt.size() == ComputerUseAuthLimiter::maxTracked, "the bound holds when a new peer fails");
        check(!crowded.permits(":9.new", int64_t(ComputerUseAuthLimiter::maxTracked) + 1), "the newest failure is still tracked");
        check(crowded.failedAt.count(":9.0") == 0, "the oldest entry is the one evicted while none has lapsed");

        // Once entries lapse they are the ones dropped, not live ones.
        ComputerUseAuthLimiter lapsed;
        for (size_t i = 0; i < ComputerUseAuthLimiter::maxTracked; ++i) {
            lapsed.noteFailure(":8." + std::to_string(i), 0);
        }
        lapsed.noteFailure(":8.live", ComputerUseAuthLimiter::cooldownMs);
        check(lapsed.failedAt.size() == 1 && lapsed.failedAt.count(":8.live") == 1, "lapsed entries are swept when the table is full");
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "Failed authenticate attempts are throttled per peer within a bounded table.\n";
}
