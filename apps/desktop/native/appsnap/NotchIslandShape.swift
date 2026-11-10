import SwiftUI

/// The island outline. It hangs from the top edge of the screen; its top
/// corners flare *outward* past the body into the bezel, the way the camera
/// housing meets the screen, and its bottom corners use continuous curvature.
/// `rect` is the body: the ears are drawn `earRadius` beyond each side, so the
/// view hosting this shape needs that much room around it.
///
/// Technique (outward ears drawn outside the frame, cubic corners, animatable
/// radii in a fixed window) follows the open-source notch apps CodeIsland and
/// t3-notch.
@available(macOS 13.0, *)
struct NotchIslandShape: Shape {
    var earRadius: CGFloat
    var bottomRadius: CGFloat

    /// Pulls the bottom corners' control points in past a circle (0.552) for a
    /// softer, squircle-like corner.
    private static let cornerTension: CGFloat = 0.62
    /// How far along each ear its control points sit; small values keep the ear
    /// tight against the bezel.
    private static let earTension: CGFloat = 0.35

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(earRadius, bottomRadius) }
        set {
            earRadius = newValue.first
            bottomRadius = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        let ear = max(0, min(earRadius, rect.height))
        let bottom = max(0, min(bottomRadius, rect.width / 2, rect.height / 2))
        let corner = bottom * (1 - Self.cornerTension)
        let earPull = ear * Self.earTension

        var path = Path()
        path.move(to: CGPoint(x: rect.minX - ear, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX + ear, y: rect.minY))
        // Right ear, curving from the bezel down into the right side.
        path.addCurve(
            to: CGPoint(x: rect.maxX, y: rect.minY + ear),
            control1: CGPoint(x: rect.maxX + earPull, y: rect.minY),
            control2: CGPoint(x: rect.maxX, y: rect.minY + earPull)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottom))
        path.addCurve(
            to: CGPoint(x: rect.maxX - bottom, y: rect.maxY),
            control1: CGPoint(x: rect.maxX, y: rect.maxY - corner),
            control2: CGPoint(x: rect.maxX - corner, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + bottom, y: rect.maxY))
        path.addCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - bottom),
            control1: CGPoint(x: rect.minX + corner, y: rect.maxY),
            control2: CGPoint(x: rect.minX, y: rect.maxY - corner)
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + ear))
        // Left ear, back out to the bezel.
        path.addCurve(
            to: CGPoint(x: rect.minX - ear, y: rect.minY),
            control1: CGPoint(x: rect.minX, y: rect.minY + earPull),
            control2: CGPoint(x: rect.minX - earPull, y: rect.minY)
        )
        path.closeSubpath()
        return path
    }
}
