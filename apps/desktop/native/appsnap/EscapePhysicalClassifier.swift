import CoreGraphics

/// The physical Escape key's virtual keycode.
let escapeKeyCode = CGKeyCode(0x35)

/// Modifiers that make an Escape press a chord instead of the plain key.
/// Caps Lock and the secondary-Fn state do not change which physical key was
/// pressed, so they do not disqualify the press.
let escapeDisqualifyingFlags: CGEventFlags = [
    .maskCommand,
    .maskAlternate,
    .maskControl,
    .maskShift,
]

/// Decides whether one observed CGEvent is the human's physical Escape.
///
/// The kill switch exists for the person at the keyboard, so only a
/// hardware-originated press may interrupt computer input. A synthetic key
/// posted by any process — the computer-use driver's own Escape included —
/// must stay an ordinary keystroke. macOS records the difference in the
/// event's source fields, and all three must agree that no process made it:
///
/// - `eventSourceUnixProcessID` is 0 only for events the HID system created.
///   Any process that posts an event (CGEventPost, CGEventPostToPid, or the
///   HID event tap) is stamped with its own pid on every route, so a
///   synthetic Escape can never pass this field.
/// - `eventSourceStateID` is the HID system state (`hidSystemState`, 1) for
///   hardware and system-defined key events. A source a process creates
///   reports its own state table instead (combined session = 0, private =
///   -1), so a key posted through a programmatic source is refused even if
///   its pid were somehow scrubbed.
/// - `eventSourceUserData` is a poster-supplied marker. Hardware leaves it 0,
///   and a future synthetic route that marks its events is refused here.
///
/// The classifier is pure so the rules can be exercised without a live event
/// tap; `EscapeKillSwitchMonitor` passes each event's fields through.
enum EscapePhysicalClassifier {
    /// Only input that can change the human's target state counts as takeover.
    /// Pointer motion is deliberately excluded so background work can coexist
    /// with an idle cursor. No key code, text, or coordinates leave the helper.
    static func isPhysicalInput(
        type: CGEventType,
        sourceProcessID: Int64,
        sourceStateID: Int64,
        sourceUserData: Int64,
        armed: Bool
    ) -> Bool {
        armed && [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(type)
            && sourceProcessID == 0
            && sourceStateID == Int64(CGEventSourceStateID.hidSystemState.rawValue)
            && sourceUserData == 0
    }

    static func isPhysicalEscape(
        type: CGEventType,
        keyCode: CGKeyCode,
        flags: CGEventFlags,
        sourceProcessID: Int64,
        sourceStateID: Int64,
        sourceUserData: Int64,
        armed: Bool
    ) -> Bool {
        guard isPhysicalInput(
                  type: type,
                  sourceProcessID: sourceProcessID,
                  sourceStateID: sourceStateID,
                  sourceUserData: sourceUserData,
                  armed: armed
              ),
              type == .keyDown,
              keyCode == escapeKeyCode,
              flags.intersection(escapeDisqualifyingFlags).isEmpty
        else {
            return false
        }
        return true
    }
}
