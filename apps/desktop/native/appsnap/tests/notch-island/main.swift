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
        panel.width >= NotchIslandGeometry.expandedWidth
            && panel.height >= 32 + NotchIslandGeometry.expandedContentHeight(rows: NotchIslandGeometry.maxRows),
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
expect("resting is the notch", NotchIslandGeometry.islandSize(for: .resting, notch: notchSize, rows: 0), notchSize)
expect(
    "compact adds an ear each side",
    NotchIslandGeometry.islandSize(for: .compact, notch: notchSize, rows: 3),
    CGSize(width: 185 + NotchIslandGeometry.earWidth * 2, height: 32)
)
expect(
    "open island grows with its rows",
    NotchIslandGeometry.islandSize(for: .expanded, notch: notchSize, rows: 1).height
        < NotchIslandGeometry.islandSize(for: .expanded, notch: notchSize, rows: 4).height,
    true
)
expect(
    "rows beyond the cap do not grow it",
    NotchIslandGeometry.expandedContentHeight(rows: 9),
    NotchIslandGeometry.expandedContentHeight(rows: NotchIslandGeometry.maxRows)
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
        NotchIslandSnapshot.Row(threadId: "a", title: "Add the notch island", project: "synara", provider: "claudeAgent", state: .approval),
        NotchIslandSnapshot.Row(threadId: "b", title: "Which badge color?", project: "website", provider: "codex", state: .input),
        NotchIslandSnapshot.Row(threadId: "c", title: "Fix reconnect race in session resume", project: "synara", provider: "codex", state: .working),
        NotchIslandSnapshot.Row(threadId: "d", title: "Release notes for 1.2", project: "website", provider: "claudeAgent", state: .done),
    ]
    func snap(_ lead: NotchIslandSnapshot.Lead, _ count: Int, rows: [NotchIslandSnapshot.Row]) -> NotchIslandSnapshot {
        NotchIslandSnapshot(lead: lead, count: count, needsYou: 2, working: 3, done: 4, failed: 0, rows: rows)
    }
    let cases: [(String, NotchIslandSnapshot, Bool, NotchIslandPlacementKind)] = [
        ("resting-notch", .idle, false, .notch),
        ("compact-working", snap(.working, 3, rows: rows), false, .notch),
        ("compact-needs-you", snap(.needsYou, 2, rows: rows), false, .notch),
        ("compact-pill-done", snap(.finished, 4, rows: rows), false, .pill),
        ("expanded-rows", snap(.needsYou, 2, rows: rows), true, .notch),
        ("expanded-two-rows", snap(.working, 3, rows: Array(rows.suffix(2))), true, .notch),
        ("expanded-empty", .idle, true, .notch),
    ]
    let iconSVG = ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="9" fill="#D97757"/></svg>"##
    MainActor.assumeIsolated {
        for (name, snapshot, expanded, kind) in cases {
            let model = NotchIslandModel()
            model.snapshot = snapshot
            model.isExpanded = expanded
            model.placementKind = kind
            model.notchSize = kind == .notch ? notchSize : CGSize(width: NotchIslandGeometry.pillBodyWidth, height: 25)
            model.reduceMotion = true
            model.icons = ["claudeAgent": NSImage(data: Data(iconSVG.utf8))!]
            let view = NotchIslandView(model: model)
                .frame(width: 500, height: 360)
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
