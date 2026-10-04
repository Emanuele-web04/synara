import CoreGraphics
import Foundation

/// Releases synthetic input the OS may still believe is held.
///
/// A computer-use driver killed mid-gesture (crash or SIGKILL) never posts its
/// release: macOS keeps the synthetic button or modifier "down" forever, and
/// the user's real clicks and keystrokes feel dead until reboot. The desktop
/// host calls this helper when it detects a driver died while input was in
/// flight — posting an up for every mouse button and clearing the modifier
/// flags restores the shared event state.
///
/// Releases are idempotent by nature: a mouse-up or flags-clear posted while
/// nothing is held is a no-op, so the helper can run unconditionally once the
/// need is known without risking new input.
func releaseHeldInputEvents() -> [String: Any] {
    // The current pointer is the right anchor for the releases: a leaked
    // button was pressed wherever the dead driver left the cursor, and
    // CoreGraphics delivers button events positionally.
    let location = CGEvent(source: nil)?.location ?? .zero

    // Events are created before any post so a creation failure cannot leave a
    // half-cleared state — either all releases go out or none does.
    var releases: [CGEvent] = []
    for (mouseType, button) in [
        (CGEventType.leftMouseUp, CGMouseButton.left),
        (CGEventType.rightMouseUp, CGMouseButton.right),
        (CGEventType.otherMouseUp, CGMouseButton.center),
    ] {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: mouseType,
            mouseCursorPosition: location,
            mouseButton: button
        ) else {
            return [
                "type": "release-held-input",
                "released": false,
                "reason": "mouse_event_create_failed",
            ]
        }
        releases.append(event)
    }

    // A FlagsChanged carrying empty flags lifts every held modifier — the
    // event's flag state *is* the modifier state the system now believes.
    guard let flagsClear = CGEvent(source: nil) else {
        return [
            "type": "release-held-input",
            "released": false,
            "reason": "flags_event_create_failed",
        ]
    }
    flagsClear.type = .flagsChanged
    flagsClear.flags = []

    for event in releases {
        event.post(tap: .cghidEventTap)
    }
    flagsClear.post(tap: .cghidEventTap)

    return [
        "type": "release-held-input",
        "released": true,
        "details": ["left_mouse_up", "right_mouse_up", "other_mouse_up", "modifier_flags"],
    ]
}
