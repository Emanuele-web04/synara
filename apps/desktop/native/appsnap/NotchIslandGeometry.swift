import CoreGraphics

/// The facts about one display the island needs, read from `NSScreen` by the
/// controller and kept as plain values so the placement math stays testable
/// without AppKit. Rects are Cocoa global coordinates (bottom-left origin).
struct NotchIslandScreenMetrics: Equatable {
    let frame: CGRect
    let visibleFrame: CGRect
    /// `NSScreen.safeAreaInsets.top`; non-zero only on a display with a camera housing.
    let safeAreaTop: CGFloat
    /// Widths of `auxiliaryTopLeftArea` / `auxiliaryTopRightArea`, the menu-bar
    /// strips either side of the notch. Nil on displays without one.
    let auxiliaryTopLeftWidth: CGFloat?
    let auxiliaryTopRightWidth: CGFloat?
    let isBuiltIn: Bool
    /// `NSStatusBar.system.thickness`, used when the menu bar auto-hides and
    /// the visible frame no longer reserves its height.
    let statusBarThickness: CGFloat
}

enum NotchIslandPlacementKind: String {
    /// Sits on the hardware notch; the closed island is the notch itself.
    case notch
    /// No notch: a black pill drawn at the top center of the menu bar.
    case pill
}

/// What the island shows right now; each one has a fixed size.
enum NotchIslandPresence: Equatable {
    /// Nothing drawn: a pill with no activity, or a pill over a fullscreen Space.
    case hidden
    /// Exactly the notch, so it disappears into the camera housing.
    case resting
    /// The notch plus an ear either side for the status icon and count.
    case compact
    /// Open under the pointer.
    case expanded
}

struct NotchIslandPlacement: Equatable {
    let kind: NotchIslandPlacementKind
    /// Index into the screen list the placement was chosen from.
    let screenIndex: Int
    let screenFrame: CGRect
    /// The hardware notch, or the pill's resting body, in global coordinates.
    let notch: CGRect
}

enum NotchIslandGeometry {
    /// Width of the pill's resting body; the ears grow either side of it.
    static let pillBodyWidth: CGFloat = 96
    static let minimumPillHeight: CGFloat = 22
    /// Room either side of the notch for the closed island's icon and count.
    static let earWidth: CGFloat = 40
    static let expandedWidth: CGFloat = 440
    /// Open island layout (points): counters, then up to `maxRows` chat rows.
    static let maxRows = 4
    static let sectionSpacing: CGFloat = 10
    static let countersHeight: CGFloat = 46
    static let rowHeight: CGFloat = 48
    static let rowSpacing: CGFloat = 4
    static let emptyHeight: CGFloat = 32
    static let bottomPadding: CGFloat = 12
    /// Spare room around the island inside the panel so spring overshoot and
    /// the shadow never clip against the window edge.
    static let panelMargin: CGFloat = 24

    /// The hardware notch on this display, or nil when it has none.
    static func notchRect(for screen: NotchIslandScreenMetrics) -> CGRect? {
        guard screen.safeAreaTop > 0,
              let left = screen.auxiliaryTopLeftWidth,
              let right = screen.auxiliaryTopRightWidth
        else { return nil }
        let width = screen.frame.width - left - right
        guard width > 0 else { return nil }
        return CGRect(
            x: screen.frame.minX + left,
            y: screen.frame.maxY - screen.safeAreaTop,
            width: width,
            height: screen.safeAreaTop
        )
    }

    /// Height of the menu bar on a display without a notch.
    static func menuBarHeight(for screen: NotchIslandScreenMetrics) -> CGFloat {
        let reserved = screen.frame.maxY - screen.visibleFrame.maxY
        let height = reserved > 0 ? reserved : screen.statusBarThickness
        return max(minimumPillHeight, height)
    }

    /// The built-in notched display wins, then any notched display, then the
    /// menu-bar display (`NSScreen.screens.first`) as a pill.
    static func placement(for screens: [NotchIslandScreenMetrics]) -> NotchIslandPlacement? {
        let notched = screens.indices.compactMap { index -> (Int, CGRect)? in
            notchRect(for: screens[index]).map { (index, $0) }
        }
        if let (index, notch) = notched.first(where: { screens[$0.0].isBuiltIn }) ?? notched.first {
            return NotchIslandPlacement(
                kind: .notch,
                screenIndex: index,
                screenFrame: screens[index].frame,
                notch: notch
            )
        }
        guard let screen = screens.first else { return nil }
        let height = menuBarHeight(for: screen)
        return NotchIslandPlacement(
            kind: .pill,
            screenIndex: 0,
            screenFrame: screen.frame,
            notch: CGRect(
                x: screen.frame.midX - pillBodyWidth / 2,
                y: screen.frame.maxY - height,
                width: pillBodyWidth,
                height: height
            )
        )
    }

    /// A fixed panel, top-centered on the notch, big enough for the expanded
    /// island. Its top edge is the top of the screen.
    static func panelFrame(for placement: NotchIslandPlacement) -> CGRect {
        let width = max(expandedWidth, placement.notch.width + earWidth * 2) + panelMargin * 2
        let height = placement.notch.height + expandedContentHeight(rows: maxRows) + panelMargin
        return CGRect(
            x: (placement.notch.midX - width / 2).rounded(),
            y: placement.screenFrame.maxY - height,
            width: width.rounded(),
            height: height.rounded()
        )
    }

    static func presence(
        kind: NotchIslandPlacementKind,
        hasActivity: Bool,
        isExpanded: Bool,
        isSuppressed: Bool
    ) -> NotchIslandPresence {
        if isSuppressed { return .hidden }
        if isExpanded { return .expanded }
        if hasActivity { return .compact }
        return kind == .notch ? .resting : .hidden
    }

    /// Height below the notch row of the open island for this many chat rows.
    static func expandedContentHeight(rows: Int) -> CGFloat {
        let count = max(0, min(rows, maxRows))
        let list = count == 0
            ? emptyHeight
            : CGFloat(count) * rowHeight + CGFloat(count - 1) * rowSpacing
        return sectionSpacing + countersHeight + sectionSpacing + list + bottomPadding
    }

    static func islandSize(for presence: NotchIslandPresence, notch: CGSize, rows: Int) -> CGSize {
        switch presence {
        case .hidden, .resting:
            return notch
        case .compact:
            return CGSize(width: notch.width + earWidth * 2, height: notch.height)
        case .expanded:
            return CGSize(
                width: max(expandedWidth, notch.width + earWidth * 2),
                height: notch.height + expandedContentHeight(rows: rows)
            )
        }
    }

    /// Where the pointer opens (or keeps open) the island. A hidden island
    /// has none, so an idle pill never opens on its own.
    static func hoverZone(presence: NotchIslandPresence, island: CGRect) -> CGRect {
        switch presence {
        case .hidden:
            return .null
        case .resting, .compact:
            return island.insetBy(dx: -6, dy: -4)
        case .expanded:
            return island.insetBy(dx: -10, dy: -10)
        }
    }

    /// Whether a window's CG bounds (top-left origin) cover a whole display,
    /// which is how a fullscreen Space looks from `CGWindowListCopyWindowInfo`.
    static func coversDisplay(windowBounds: CGRect, displayBounds: CGRect) -> Bool {
        abs(windowBounds.minX - displayBounds.minX) < 1
            && abs(windowBounds.minY - displayBounds.minY) < 1
            && abs(windowBounds.width - displayBounds.width) < 1
            && abs(windowBounds.height - displayBounds.height) < 1
    }
}
