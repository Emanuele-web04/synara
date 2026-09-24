// waitForSettle's rule, driven through the production verdict: a commit after
// the baseline, then quiet for the whole quiet period, else unsettled at the
// deadline; and when to look again in between.
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>

using qint64 = int64_t;

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

constexpr qint64 ms = 1000000;

int main() {
    try {
        const qint64 baseline = 100 * ms, quiet = 100 * ms, deadline = 1600 * ms;

        SettleVerdict v = settleVerdict(110 * ms, -1, baseline, quiet, deadline);
        check(!v.done && v.recheckNs == deadline, "nothing committed yet: wait until the deadline (or a commit)");

        v = settleVerdict(110 * ms, 90 * ms, baseline, quiet, deadline);
        check(!v.done && v.recheckNs == deadline, "a commit from before the input is not the reaction to it");

        v = settleVerdict(110 * ms, 100 * ms, baseline, quiet, deadline);
        check(!v.done, "a commit at the very instant of the input does not count either");

        v = settleVerdict(150 * ms, 140 * ms, baseline, quiet, deadline);
        check(!v.done && v.recheckNs == 240 * ms, "committed: look again when the quiet period would end");

        v = settleVerdict(239 * ms, 140 * ms, baseline, quiet, deadline);
        check(!v.done, "not settled a millisecond early");

        v = settleVerdict(240 * ms, 140 * ms, baseline, quiet, deadline);
        check(v.done && v.settled, "settled once quiet for the whole period");

        v = settleVerdict(1550 * ms, 1540 * ms, baseline, quiet, deadline);
        check(!v.done && v.recheckNs == deadline, "a recheck never lands past the deadline");

        v = settleVerdict(1600 * ms, 1540 * ms, baseline, quiet, deadline);
        check(v.done && !v.settled, "still busy at the deadline: unsettled");

        v = settleVerdict(1600 * ms, -1, baseline, quiet, deadline);
        check(v.done && !v.settled, "never committed: unsettled at the deadline");

        v = settleVerdict(100 * ms, 50 * ms, 0, 0, deadline);
        check(v.done && v.settled, "quiet 0: the first commit after the baseline settles it");
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "waitForSettle: settles on quiet after a post-input commit, never early, never past the deadline.\n";
}
