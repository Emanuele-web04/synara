import AppKit
import CoreGraphics
import Foundation
import SwiftUI

// Standalone test for the notch island's placement math and SwiftUI states.
//
// Run from apps/desktop/native/appsnap:
//   xcrun swiftc -O NotchIslandGeometry.swift NotchIslandModel.swift NotchIslandShape.swift \
//     NotchIslandView.swift tests/notch-island/main.swift \
//     -framework AppKit -framework SwiftUI -o /tmp/notch-island-test && /tmp/notch-island-test [png-dir]
//
// With a directory argument it also renders each island state to PNG there,
// which is how the shapes are reviewed without Screen Recording access.

var checks = 0
var failures = 0

func expect<T: Equatable>(_ label: String, _ actual: T, _ expected: T) {
    checks += 1
    if actual != expected {
        failures += 1
        print("FAIL: \(label) — expected \(expected), got \(actual)")
    }
}

// A 16-inch MacBook Pro at its default resolution, as NSScreen reports it.
let builtInNotched = NotchIslandScreenMetrics(
    frame: CGRect(x: 0, y: 0, width: 1728, height: 1117),
    visibleFrame: CGRect(x: 0, y: 0, width: 1728, height: 1085),
    safeAreaTop: 32,
    auxiliaryTopLeftWidth: 771.5,
    auxiliaryTopRightWidth: 771.5,
    isBuiltIn: true,
    statusBarThickness: 24
)
let external = NotchIslandScreenMetrics(
    frame: CGRect(x: 1728, y: 0, width: 2560, height: 1440),
    visibleFrame: CGRect(x: 1728, y: 0, width: 2560, height: 1415),
    safeAreaTop: 0,
    auxiliaryTopLeftWidth: nil,
    auxiliaryTopRightWidth: nil,
    isBuiltIn: false,
    statusBarThickness: 24
)
let autoHidingExternal = NotchIslandScreenMetrics(
    frame: external.frame,
    visibleFrame: external.frame,
    safeAreaTop: 0,
    auxiliaryTopLeftWidth: nil,
    auxiliaryTopRightWidth: nil,
    isBuiltIn: false,
    statusBarThickness: 24
)

// Notch rect
expect(
    "notch rect on the built-in display",
    NotchIslandGeometry.notchRect(for: builtInNotched),
    CGRect(x: 771.5, y: 1085, width: 185, height: 32)
)
expect("no notch on an external display", NotchIslandGeometry.notchRect(for: external), nil)

// Screen choice
let notchedSecond = NotchIslandGeometry.placement(for: [external, builtInNotched])
expect("notched built-in display wins over the menu-bar display", notchedSecond?.kind, .notch)
expect("notched display index", notchedSecond?.screenIndex, 1)

let pill = NotchIslandGeometry.placement(for: [external])
expect("no notch anywhere falls back to a pill", pill?.kind, .pill)
expect("pill sits on the menu-bar display", pill?.screenIndex, 0)
expect("pill height is the reserved menu bar", pill?.notch.height, 25)
expect("pill is centered", pill?.notch.midX, external.frame.midX)
expect("pill touches the top edge", pill?.notch.maxY, external.frame.maxY)
expect(
    "auto-hiding menu bar uses the status bar thickness",
    NotchIslandGeometry.placement(for: [autoHidingExternal])?.notch.height,
    24
)
expect("no screens, no placement", NotchIslandGeometry.placement(for: []), nil)

// Panel
if let notch = notchedSecond {
    let panel = NotchIslandGeometry.panelFrame(for: notch)
    expect("panel top is the screen top", panel.maxY, builtInNotched.frame.maxY)
    expect("panel is centered on the notch", panel.midX, notch.notch.midX)
    expect(
        "panel fits the expanded island",
        panel.width >= NotchIslandGeometry.expandedWidth && panel.height >= 32 + NotchIslandGeometry.expandedContentHeight,
        true
    )
}

// Presence
expect("idle notch rests", NotchIslandGeometry.presence(kind: .notch, hasActivity: false, isExpanded: false, isSuppressed: false), .resting)
expect("idle pill hides", NotchIslandGeometry.presence(kind: .pill, hasActivity: false, isExpanded: false, isSuppressed: false), .hidden)
expect("activity shows ears", NotchIslandGeometry.presence(kind: .pill, hasActivity: true, isExpanded: false, isSuppressed: false), .compact)
expect("hover expands", NotchIslandGeometry.presence(kind: .notch, hasActivity: false, isExpanded: true, isSuppressed: false), .expanded)
expect("fullscreen suppression wins", NotchIslandGeometry.presence(kind: .pill, hasActivity: true, isExpanded: true, isSuppressed: true), .hidden)

// Sizes and hover zones
let notchSize = CGSize(width: 185, height: 32)
expect("resting is the notch", NotchIslandGeometry.islandSize(for: .resting, notch: notchSize), notchSize)
expect(
    "compact adds an ear each side",
    NotchIslandGeometry.islandSize(for: .compact, notch: notchSize),
    CGSize(width: 185 + NotchIslandGeometry.earWidth * 2, height: 32)
)
expect(
    "hidden has no hover zone",
    NotchIslandGeometry.hoverZone(presence: .hidden, island: CGRect(x: 0, y: 0, width: 10, height: 10)).isNull,
    true
)

// Fullscreen detection
let display = CGRect(x: 0, y: 0, width: 2560, height: 1440)
expect("a window covering the display is fullscreen", NotchIslandGeometry.coversDisplay(windowBounds: display, displayBounds: display), true)
expect(
    "a zoomed window below the menu bar is not",
    NotchIslandGeometry.coversDisplay(windowBounds: CGRect(x: 0, y: 25, width: 2560, height: 1415), displayBounds: display),
    false
)

// Rendering
if CommandLine.arguments.count > 1 {
    let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let rows = [
        NotchIslandSnapshot.Row(threadId: "a", title: "Fix reconnect race in session resume", project: "synara", state: .working),
        NotchIslandSnapshot.Row(threadId: "b", title: "Add the notch island", project: "synara", state: .needsApproval),
        NotchIslandSnapshot.Row(threadId: "c", title: "Release notes", project: "website", state: .finished),
    ]
    let cases: [(String, NotchIslandSnapshot, Bool, NotchIslandPlacementKind)] = [
        ("resting-notch", .idle, false, .notch),
        ("compact-working", NotchIslandSnapshot(lead: .working, count: 2, rows: rows), false, .notch),
        ("compact-needs-you", NotchIslandSnapshot(lead: .needsYou, count: 1, rows: rows), false, .notch),
        ("compact-pill", NotchIslandSnapshot(lead: .finished, count: 1, rows: rows), false, .pill),
        ("expanded-rows", NotchIslandSnapshot(lead: .needsYou, count: 1, rows: rows), true, .notch),
        ("expanded-empty", .idle, true, .notch),
    ]
    MainActor.assumeIsolated {
        for (name, snapshot, expanded, kind) in cases {
            let model = NotchIslandModel()
            model.snapshot = snapshot
            model.isExpanded = expanded
            model.placementKind = kind
            model.notchSize = kind == .notch ? notchSize : CGSize(width: NotchIslandGeometry.pillBodyWidth, height: 25)
            model.reduceMotion = true
            let view = NotchIslandView(model: model)
                .frame(width: 460, height: 240)
                .background(Color(white: 0.85))
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            guard let image = renderer.nsImage,
                  let tiff = image.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
            else {
                failures += 1
                print("FAIL: could not render \(name)")
                continue
            }
            try? png.write(to: directory.appendingPathComponent("\(name).png"))
        }
    }
}

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
