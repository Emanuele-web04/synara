import AppKit

extension NSScreen {
    var displayID: CGDirectDisplayID? {
        guard let number = deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        return number.uint32Value
    }
}

struct IslandGeometry {
    let screen: NSScreen
    let notchRect: NSRect
    let collapsedSize: CGSize

    static let activitySize = CGSize(width: 400, height: 102)
    static let expandedSize = CGSize(width: 400, height: 102)
    static let expandedHeight: CGFloat = 102
    static let approvalSize = CGSize(width: 408, height: 166)

    init(screen: NSScreen) {
        self.screen = screen
        self.notchRect = Self.computeNotchRect(for: screen)
        self.collapsedSize = notchRect.size
    }

    static func computeNotchRect(for screen: NSScreen) -> NSRect {
        let frame = screen.frame
        let topY = frame.maxY

        if #available(macOS 14.0, *) {
            if let left = screen.auxiliaryTopLeftArea,
               let right = screen.auxiliaryTopRightArea,
               left.maxX < right.minX {
                let x = left.maxX
                let width = right.minX - left.maxX
                let height = max(left.height, right.height, screen.safeAreaInsets.top)
                let y = topY - height
                return NSRect(x: x, y: y, width: width, height: height)
            }
        }

        // Fallback for non-notched screens: a small centered pill.
        let width: CGFloat = 120
        let height: CGFloat = 32
        return NSRect(
            x: frame.midX - width / 2,
            y: topY - height,
            width: width,
            height: height
        )
    }

    func size(for presentation: IslandPresentation) -> CGSize {
        switch presentation {
        case .collapsed:
            return collapsedSize
        case .activity:
            return Self.activitySize
        case .expanded:
            return Self.expandedSize
        case .approval:
            return Self.approvalSize
        }
    }

    func islandFrame(for presentation: IslandPresentation) -> NSRect {
        let size = size(for: presentation)
        let topY = screen.frame.maxY

        switch presentation {
        case .collapsed:
            return notchRect
        case .activity, .expanded, .approval:
            return NSRect(
                x: screen.frame.midX - size.width / 2,
                y: topY - size.height,
                width: size.width,
                height: size.height
            )
        }
    }

    var triggerRect: NSRect {
        // Slightly enlarged region around the physical notch for hover detection.
        notchRect.insetBy(dx: -30, dy: -40)
    }

    func containsMouse(_ point: NSPoint) -> Bool {
        triggerRect.contains(point)
    }

    func logOnce() {
        var lines: [String] = []
        lines.append("[island-geometry] screen.frame: \(screen.frame)")
        lines.append("[island-geometry] screen.visibleFrame: \(screen.visibleFrame)")
        lines.append("[island-geometry] safeAreaInsets: \(screen.safeAreaInsets)")
        if #available(macOS 14.0, *) {
            lines.append("[island-geometry] auxiliaryTopLeftArea: \(String(describing: screen.auxiliaryTopLeftArea))")
            lines.append("[island-geometry] auxiliaryTopRightArea: \(String(describing: screen.auxiliaryTopRightArea))")
        } else {
            lines.append("[island-geometry] auxiliaryTopLeftArea: not available")
            lines.append("[island-geometry] auxiliaryTopRightArea: not available")
        }
        lines.append("[island-geometry] derived notchRect: \(notchRect)")
        lines.append("[island-geometry] collapsed islandFrame: \(islandFrame(for: .collapsed))")
        lines.append("[island-geometry] activity islandFrame: \(islandFrame(for: .activity))")
        print(lines.joined(separator: "\n"))
        fflush(stdout)
    }
}
