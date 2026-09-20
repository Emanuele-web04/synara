import CoreGraphics
import Foundation

// Standalone unit test for EscapePhysicalClassifier.
//
// Run:
//   xcrun swiftc -O EscapePhysicalClassifier.swift tests/escape-classifier/main.swift \
//     -framework CoreGraphics -framework Foundation -o /tmp/escape-classifier-test && /tmp/escape-classifier-test
//
// Synthetic field values below are the exact values recorded by the live
// probe (checks/l16-synthetic-escape-poster.swift on 2026-09-20): a key
// posted with CGEventPost to the HID tap reports the poster's pid, state 1,
// and flags 0x20000100; the combined-session route reports state 0. Hardware
// events report pid 0, HID state 1, no user data.

var checks = 0
var failures = 0

func expect(_ label: String, _ actual: Bool, _ expected: Bool) {
    checks += 1
    if actual != expected {
        failures += 1
        print("FAIL: \(label) — expected \(expected), got \(actual)")
    }
}

func classify(
    type: CGEventType = .keyDown,
    keyCode: CGKeyCode = escapeKeyCode,
    flags: CGEventFlags = [.maskNonCoalesced],
    sourceProcessID: Int64 = 0,
    sourceStateID: Int64 = Int64(CGEventSourceStateID.hidSystemState.rawValue),
    sourceUserData: Int64 = 0,
    armed: Bool = true
) -> Bool {
    EscapePhysicalClassifier.isPhysicalEscape(
        type: type,
        keyCode: keyCode,
        flags: flags,
        sourceProcessID: sourceProcessID,
        sourceStateID: sourceStateID,
        sourceUserData: sourceUserData,
        armed: armed
    )
}

// The real thing: an unmodified hardware Escape while the monitor is armed.
expect("hardware escape", classify(), true)

// Synthetic routes the computer-use driver uses, with the probe's live values.
expect(
    "driver HID route (CGEventPost to HID tap)",
    classify(flags: CGEventFlags(rawValue: 0x2000_0100), sourceProcessID: 46_335),
    false
)
expect(
    "driver combined-session source",
    classify(flags: CGEventFlags(rawValue: 0x2000_0100), sourceProcessID: 46_335, sourceStateID: 0),
    false
)
expect(
    "driver session-tap route",
    classify(sourceProcessID: 46_335),
    false
)
expect("poster-supplied user-data marker", classify(sourceUserData: 0x5EED_BEEF), false)
expect(
    "non-HID source state with a clean pid",
    classify(sourceStateID: 0),
    false
)
expect(
    "private source state with a clean pid",
    classify(sourceStateID: -1),
    false
)

// Chords belong to the application, never to the kill switch.
for (name, flag): (String, CGEventFlags) in [
    ("command", .maskCommand),
    ("option", .maskAlternate),
    ("control", .maskControl),
    ("shift", .maskShift),
] {
    expect("hardware escape + \(name)", classify(flags: [.maskNonCoalesced, flag]), false)
}

// Non-triggering shapes.
expect("disarmed hardware escape", classify(armed: false), false)
expect("hardware escape key up", classify(type: .keyUp), false)
expect("flags changed on escape", classify(type: .flagsChanged), false)
expect("another hardware key", classify(keyCode: CGKeyCode(0x24)), false)

func classifyInput(
    type: CGEventType,
    sourceProcessID: Int64 = 0,
    sourceStateID: Int64 = Int64(CGEventSourceStateID.hidSystemState.rawValue),
    sourceUserData: Int64 = 0,
    armed: Bool = true
) -> Bool {
    EscapePhysicalClassifier.isPhysicalInput(
        type: type,
        sourceProcessID: sourceProcessID,
        sourceStateID: sourceStateID,
        sourceUserData: sourceUserData,
        armed: armed
    )
}

for type: CGEventType in [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel] {
    expect("physical takeover \(type.rawValue)", classifyInput(type: type), true)
    expect("synthetic takeover \(type.rawValue)", classifyInput(type: type, sourceProcessID: 99), false)
    expect("disarmed takeover \(type.rawValue)", classifyInput(type: type, armed: false), false)
}
for type: CGEventType in [.mouseMoved, .leftMouseDragged, .keyUp, .leftMouseUp] {
    expect("non-triggering input \(type.rawValue)", classifyInput(type: type), false)
}
expect("combined session takeover", classifyInput(type: .keyDown, sourceStateID: 0), false)
expect("marked synthetic pointer", classifyInput(type: .leftMouseDown, sourceUserData: 88), false)

if failures > 0 {
    print("\(failures)/\(checks) escape classifier checks failed")
    exit(1)
}
print("escape classifier: \(checks) checks passed")
