import AppKit
import SwiftUI

/// A borderless, never-key panel above the menu bar on every Space, including
/// beside fullscreen apps. It starts click-through; the controller lets the
/// pointer in only while it is over the island itself.
final class NotchIslandPanel: NSPanel {
    init(frame: CGRect) {
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        // Above the menu bar (and the notch's own menu-bar strip), the same
        // band the notch utilities use. Set after anything that resets the
        // level: `isFloatingPanel = true` would drop it to the floating level.
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 3)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isMovable = false
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        acceptsMouseMovedEvents = true
        ignoresMouseEvents = true
        becomesKeyOnlyIfNeeded = true
        animationBehavior = .none
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// AppKit otherwise pushes a window that overlaps the menu bar back below
    /// it (after wake or a display change). The island lives there on purpose.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}

/// Hosts the SwiftUI island and refuses every point outside it, so the
/// transparent rest of the panel never swallows a click meant for the menu
/// bar or the app underneath.
@available(macOS 13.0, *)
final class NotchIslandHostingView<Content: View>: NSHostingView<Content> {
    /// The island's current rect in this view's coordinates.
    var interactiveRect: CGRect = .zero

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var needsPanelToBecomeKey: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard interactiveRect.contains(local) else { return nil }
        return super.hitTest(point)
    }
}
