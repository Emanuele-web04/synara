import AppKit
import CoreGraphics
import Foundation

struct SoftwareCursorGlyphRenderState {
    let rotation: CGFloat
    let cursorBodyOffset: CGVector
    let fogOffset: CGVector
    let fogOpacity: CGFloat
    let fogScale: CGFloat
    let clickProgress: CGFloat

    init(
        rotation: CGFloat,
        cursorBodyOffset: CGVector,
        fogOffset: CGVector,
        fogOpacity: CGFloat,
        fogScale: CGFloat,
        clickProgress: CGFloat
    ) {
        self.rotation = rotation
        self.cursorBodyOffset = cursorBodyOffset
        self.fogOffset = fogOffset
        self.fogOpacity = fogOpacity
        self.fogScale = fogScale
        self.clickProgress = clickProgress
    }

    var appKitDrawingState: SoftwareCursorGlyphRenderState {
        SoftwareCursorGlyphRenderState(
            rotation: -rotation,
            cursorBodyOffset: CGVector(dx: cursorBodyOffset.dx, dy: -cursorBodyOffset.dy),
            fogOffset: CGVector(dx: fogOffset.dx, dy: -fogOffset.dy),
            fogOpacity: fogOpacity,
            fogScale: fogScale,
            clickProgress: clickProgress
        )
    }
}

enum SoftwareCursorGlowPalette {
    static func outerColor(theme: SoftwareCursorGlyphTheme, pulse: CGFloat, opacityMultiplier: CGFloat) -> [CGColor] {
        let accent = theme.glowAccent
        return [
            accent.withAlphaComponent((0.48 + (pulse * 0.04)) * opacityMultiplier).cgColor,
            accent.withAlphaComponent((0.34 + (pulse * 0.03)) * opacityMultiplier).cgColor,
            accent.withAlphaComponent(0.16 * opacityMultiplier).cgColor,
            NSColor(calibratedWhite: 0.60, alpha: 0.0).cgColor,
        ]
    }

    static func coreColor(theme: SoftwareCursorGlyphTheme, pulse: CGFloat, opacityMultiplier: CGFloat) -> [CGColor] {
        let accent = theme.glowAccent
        return [
            accent.withAlphaComponent((0.18 + (pulse * 0.03)) * opacityMultiplier).cgColor,
            accent.withAlphaComponent(0.08 * opacityMultiplier).cgColor,
            NSColor(calibratedWhite: 0.80, alpha: 0.0).cgColor,
        ]
    }
}

enum SoftwareCursorGlyphMetrics {
    static let windowSize = CGSize(width: 126, height: 126)
    static let tipAnchor = CGPoint(x: 60.35, y: 70.3)
    static let sourceAssetName = "cursor-ai.svg"

    static let pointerSize = CGSize(width: 34, height: 34)
    static let pointerOffset = CGPoint(x: 2.6, y: -3.2)
    static let targetNeutralHeading = -(3 * CGFloat.pi / 4)
    static let proceduralContourNeutralHeading = -(3 * CGFloat.pi / 4)
    static let pointerArtworkRotation = -(targetNeutralHeading - proceduralContourNeutralHeading)
}

struct SoftwareCursorGlyphTheme {
    let isDark: Bool
    let pointerColor: NSColor
    let strokeColor: NSColor
    let glowAccent: NSColor
    let shadowColor: NSColor

    static let dark = SoftwareCursorGlyphTheme(
        isDark: true,
        pointerColor: NSColor(calibratedWhite: 1, alpha: 0.98),
        strokeColor: NSColor(calibratedRed: 0.56, green: 1.0, blue: 0.20, alpha: 0.92),
        glowAccent: NSColor(calibratedRed: 0.35, green: 1.0, blue: 0.12, alpha: 1),
        shadowColor: NSColor(calibratedRed: 0.25, green: 1.0, blue: 0.08, alpha: 0.40)
    )

    static let light = SoftwareCursorGlyphTheme(
        isDark: false,
        pointerColor: NSColor(calibratedWhite: 0.02, alpha: 0.98),
        strokeColor: NSColor(calibratedRed: 1.0, green: 0.20, blue: 0.64, alpha: 0.90),
        glowAccent: NSColor(calibratedRed: 1.0, green: 0.16, blue: 0.62, alpha: 1),
        shadowColor: NSColor(calibratedRed: 1.0, green: 0.05, blue: 0.55, alpha: 0.32)
    )

    static func resolved(appearance: NSAppearance? = nil) -> SoftwareCursorGlyphTheme {
        let resolvedAppearance = appearance ?? NSAppearance.currentDrawing()
        let bestMatch = resolvedAppearance.bestMatch(from: [.darkAqua, .aqua])
        return bestMatch == .darkAqua ? .dark : .light
    }
}

enum SoftwareCursorGlyphRenderer {
    static func draw(
        in bounds: CGRect,
        context: CGContext,
        state: SoftwareCursorGlyphRenderState
    ) {
        let drawingState = state.appKitDrawingState
        let theme = SoftwareCursorGlyphTheme.resolved()

        let pulse = drawingState.clickProgress
        let fogCenter = CGPoint(
            x: bounds.midX + drawingState.fogOffset.dx,
            y: bounds.midY + drawingState.fogOffset.dy
        )
        let pointerCenter = CGPoint(
            x: bounds.midX + SoftwareCursorGlyphMetrics.pointerOffset.x + drawingState.cursorBodyOffset.dx,
            y: bounds.midY + SoftwareCursorGlyphMetrics.pointerOffset.y + drawingState.cursorBodyOffset.dy + (pulse * 0.35)
        )

        drawFog(
            in: context,
            center: fogCenter,
            pulse: pulse,
            fogOpacity: state.fogOpacity,
            fogScale: state.fogScale,
            theme: theme
        )
        drawPointer(
            in: context,
            center: pointerCenter,
            rotation: drawingState.rotation,
            clickProgress: pulse,
            cursorBodyOffset: drawingState.cursorBodyOffset,
            boundsMidpoint: CGPoint(x: bounds.midX, y: bounds.midY),
            theme: theme
        )
    }

    private static func drawFog(
        in context: CGContext,
        center: CGPoint,
        pulse: CGFloat,
        fogOpacity: CGFloat,
        fogScale: CGFloat,
        theme: SoftwareCursorGlyphTheme
    ) {
        let radius = ((66 * fogScale) / 2) + (pulse * 1.2)
        let glowRadius = radius * (0.30 + (pulse * 0.025))
        let opacityMultiplier = max(0.28, min(fogOpacity / 0.12, 2.2))
        let colors = SoftwareCursorGlowPalette.outerColor(
            theme: theme,
            pulse: pulse,
            opacityMultiplier: opacityMultiplier
        ) as CFArray
        let locations: [CGFloat] = [0, 0.50, 0.82, 1]
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        guard let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: locations) else {
            return
        }

        context.saveGState()
        context.drawRadialGradient(
            gradient,
            startCenter: center,
            startRadius: 0,
            endCenter: center,
            endRadius: radius,
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
        context.restoreGState()

        let coreColors = SoftwareCursorGlowPalette.coreColor(
            theme: theme,
            pulse: pulse,
            opacityMultiplier: opacityMultiplier
        ) as CFArray
        let coreLocations: [CGFloat] = [0, 0.62, 1]
        guard let coreGradient = CGGradient(colorsSpace: colorSpace, colors: coreColors, locations: coreLocations) else {
            return
        }

        context.saveGState()
        context.drawRadialGradient(
            coreGradient,
            startCenter: center,
            startRadius: 0,
            endCenter: center,
            endRadius: glowRadius,
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
        context.restoreGState()
    }

    private static func drawPointer(
        in context: CGContext,
        center: CGPoint,
        rotation: CGFloat,
        clickProgress: CGFloat,
        cursorBodyOffset: CGVector,
        boundsMidpoint: CGPoint,
        theme: SoftwareCursorGlyphTheme
    ) {
        let pointerRect = CGRect(
            x: center.x - (SoftwareCursorGlyphMetrics.pointerSize.width / 2),
            y: center.y - (SoftwareCursorGlyphMetrics.pointerSize.height / 2),
            width: SoftwareCursorGlyphMetrics.pointerSize.width,
            height: SoftwareCursorGlyphMetrics.pointerSize.height
        )
        let iconPaths = cursorAIIconPaths(in: pointerRect)

        context.saveGState()
        context.translateBy(
            x: boundsMidpoint.x + cursorBodyOffset.dx,
            y: boundsMidpoint.y + cursorBodyOffset.dy
        )
        context.rotate(by: rotation)
        context.scaleBy(x: 1 - (clickProgress * 0.04), y: 1 + (clickProgress * 0.02))
        context.translateBy(
            x: -(boundsMidpoint.x + cursorBodyOffset.dx),
            y: -(boundsMidpoint.y + cursorBodyOffset.dy)
        )
        context.translateBy(x: center.x, y: center.y)
        context.rotate(by: SoftwareCursorGlyphMetrics.pointerArtworkRotation)
        context.translateBy(x: -center.x, y: -center.y)

        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowBlurRadius = 8 + (clickProgress * 2.5)
        shadow.shadowOffset = CGSize(width: 0, height: -0.35)
        shadow.shadowColor = theme.shadowColor
        shadow.set()
        theme.glowAccent.withAlphaComponent(theme.isDark ? 0.22 : 0.18).setStroke()
        iconPaths.cursor.lineWidth = 3.4
        iconPaths.cursor.lineJoinStyle = .round
        iconPaths.cursor.lineCapStyle = .round
        iconPaths.cursor.stroke()
        iconPaths.sparkle.fill()
        NSGraphicsContext.restoreGraphicsState()

        theme.pointerColor.setFill()
        iconPaths.sparkle.fill()

        theme.pointerColor.setStroke()
        iconPaths.cursor.lineWidth = 1.9
        iconPaths.cursor.lineJoinStyle = .round
        iconPaths.cursor.lineCapStyle = .round
        iconPaths.cursor.stroke()

        theme.strokeColor.setStroke()
        iconPaths.cursor.lineWidth = 0.85
        iconPaths.cursor.stroke()

        context.restoreGState()
    }

    private static func cursorAIIconPaths(in rect: CGRect) -> (sparkle: NSBezierPath, cursor: NSBezierPath) {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(
                x: rect.minX + (x / 24 * rect.width),
                y: rect.maxY - (y / 24 * rect.height)
            )
        }

        let sparkle = NSBezierPath()
        sparkle.move(to: point(14.2405, 4.18518))
        sparkle.line(to: point(13.5436, 2.37334))
        sparkle.curve(to: point(13, 2), controlPoint1: point(13.4571, 2.14842), controlPoint2: point(13.241, 2))
        sparkle.curve(to: point(12.4564, 2.37334), controlPoint1: point(12.759, 2), controlPoint2: point(12.5429, 2.14842))
        sparkle.line(to: point(11.7595, 4.18518))
        sparkle.curve(to: point(11.1852, 4.75955), controlPoint1: point(11.658, 4.44927), controlPoint2: point(11.4493, 4.65797))
        sparkle.line(to: point(9.37334, 5.45641))
        sparkle.curve(to: point(9, 6), controlPoint1: point(9.14842, 5.54292), controlPoint2: point(9, 5.75901))
        sparkle.curve(to: point(9.37334, 6.54359), controlPoint1: point(9, 6.24099), controlPoint2: point(9.14842, 6.45708))
        sparkle.line(to: point(11.1852, 7.24045))
        sparkle.curve(to: point(11.7595, 7.81482), controlPoint1: point(11.4493, 7.34203), controlPoint2: point(11.658, 7.55073))
        sparkle.line(to: point(12.4564, 9.62666))
        sparkle.curve(to: point(13, 10), controlPoint1: point(12.5429, 9.85158), controlPoint2: point(12.759, 10))
        sparkle.curve(to: point(13.5436, 9.62666), controlPoint1: point(13.241, 10), controlPoint2: point(13.4571, 9.85158))
        sparkle.line(to: point(14.2405, 7.81482))
        sparkle.curve(to: point(14.8148, 7.24045), controlPoint1: point(14.342, 7.55073), controlPoint2: point(14.5507, 7.34203))
        sparkle.line(to: point(16.6267, 6.54359))
        sparkle.curve(to: point(17, 6), controlPoint1: point(16.8516, 6.45708), controlPoint2: point(17, 6.24099))
        sparkle.curve(to: point(16.6267, 5.45641), controlPoint1: point(17, 5.75901), controlPoint2: point(16.8516, 5.54292))
        sparkle.line(to: point(14.8148, 4.75955))
        sparkle.curve(to: point(14.2405, 4.18518), controlPoint1: point(14.5507, 4.65797), controlPoint2: point(14.342, 4.44927))
        sparkle.close()

        let cursor = NSBezierPath()
        cursor.move(to: point(7.74383, 3.8951))
        cursor.line(to: point(6.05286, 3.26532))
        cursor.curve(to: point(3.47165, 5.81892), controlPoint1: point(4.45568, 2.66811), controlPoint2: point(2.89165, 4.2154))
        cursor.line(to: point(8.53369, 19.814))
        cursor.curve(to: point(12.294, 19.8172), controlPoint1: point(9.16957, 21.572), controlPoint2: point(11.6551, 21.5741))
        cursor.line(to: point(14.2074, 14.5554))
        cursor.curve(to: point(14.8054, 13.9574), controlPoint1: point(14.3085, 14.2774), controlPoint2: point(14.5275, 14.0585))
        cursor.line(to: point(19.7979, 12.142))
        cursor.curve(to: point(19.7344, 8.36091), controlPoint1: point(21.5847, 11.4922), controlPoint2: point(21.5421, 8.95037))
        cursor.line(to: point(18.3422, 7.84237))

        return (sparkle: sparkle, cursor: cursor)
    }
}
