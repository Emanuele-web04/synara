# Native computer-use tests

Run these commands from the repository root on macOS with the Xcode Command Line Tools installed. Test executables and the helper are built into a temporary directory.

## Capture geometry

These assertions cover mixed display scales, negative origins, gaps between displays, and host-window masking. They use synthetic images and do not capture or control the desktop.

```sh
helper_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/synara-computer-tests.XXXXXX")
swiftc \
  apps/server/native/computer-use-macos/Sources/CaptureCanvas.swift \
  apps/server/native/computer-use-macos/Tests/CaptureCanvasTests.swift \
  -o "$helper_test_dir/capture-canvas-tests" -framework AppKit
"$helper_test_dir/capture-canvas-tests"
```

## Helper perception and input

The fallback-history checks run without desktop permissions. They verify that a failed click does not force keyboard input or other windows onto the foreground path, and that old fallback decisions expire:

```sh
helper_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/synara-computer-tests.XXXXXX")
swiftc \
  apps/server/native/computer-use-macos/Sources/InputDeliveryHistory.swift \
  apps/server/native/computer-use-macos/Tests/InputDeliveryHistoryTests.swift \
  -o "$helper_test_dir/input-delivery-history-tests"
"$helper_test_dir/input-delivery-history-tests"
```

The input suite creates and closes its own AppKit fixture applications. It verifies ownership of target windows before sending input. It exercises hover, routing between overlapping windows, cancellation of a long drag with button release, menu actions, interruption when another fixture app becomes active, and clearing keyboard aim. It temporarily changes foreground application and window focus, so run it on a desktop available for testing.

The test process needs the macOS Accessibility and Screen Recording grants required by the helper. A development run does not validate permission handling in an installed, signed Synara build.

```sh
helper_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/synara-computer-tests.XXXXXX")
bash apps/server/native/computer-use-macos/build.sh "$helper_test_dir"
swiftc apps/server/native/computer-use-macos/Tests/InputFixture.swift \
  -o "$helper_test_dir/input-fixture" -framework AppKit

SYNARA_MAC_INPUT_TEST=1 \
SYNARA_MAC_HELPER_TEST=1 \
SYNARA_MAC_HELPER_BINARY="$helper_test_dir/synara-computer-helper" \
SYNARA_MAC_INPUT_FIXTURE="$helper_test_dir/input-fixture" \
  bun run --cwd apps/server test \
    src/computer/macComputerInput.integration.test.ts \
    src/computer/macComputerHelper.integration.test.ts
```

To run perception alone, omit `SYNARA_MAC_INPUT_TEST`, `SYNARA_MAC_INPUT_FIXTURE` and the input test file. The perception suite never sends input; unavailable platform capabilities or grants may skip individual checks. The input suite is opt-in and excluded from ordinary runs unless explicitly enabled.

These checks complement the normal server, gateway, provider and web tests. They do not replace installed-build tests for TCC denial/revocation, signed helper updates, real multi-display hot-plugging, multiple Spaces, or end-to-end tasks with actual vision models.
