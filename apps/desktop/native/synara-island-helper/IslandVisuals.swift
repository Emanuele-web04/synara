import SwiftUI

enum IslandTokens {
    static let hostTopInset: CGFloat = 0

    static let islandSpring = Animation.interpolatingSpring(
        mass: 0.8,
        stiffness: 390,
        damping: 32,
        initialVelocity: 0
    )
}

struct IslandNotchShape: Shape {
    let width: CGFloat
    let height: CGFloat
    let shoulderY: CGFloat
    let shoulderControlX: CGFloat
    let bottomRadius: CGFloat
    let topOvershoot: CGFloat

    init(
        width: CGFloat,
        height: CGFloat,
        shoulderY: CGFloat = 20,
        shoulderControlX: CGFloat = 34,
        bottomRadius: CGFloat = 36,
        topOvershoot: CGFloat = 1
    ) {
        self.width = width
        self.height = height
        self.shoulderY = shoulderY
        self.shoulderControlX = shoulderControlX
        self.bottomRadius = bottomRadius
        self.topOvershoot = topOvershoot
    }

    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        let r = min(bottomRadius, h / 2, w / 4)
        let sy = min(shoulderY, h * 0.35)
        let sc = min(shoulderControlX, w / 4)
        let topY = -topOvershoot

        var p = Path()
        p.move(to: CGPoint(x: 0, y: topY))
        p.addLine(to: CGPoint(x: w, y: topY))

        // right shoulder: concave curve inward (kept tiny or zero)
        p.addCurve(
            to: CGPoint(x: w, y: topY + sy),
            control1: CGPoint(x: w - sc, y: topY),
            control2: CGPoint(x: w - sc, y: topY + sy)
        )

        p.addLine(to: CGPoint(x: w, y: h - r))
        p.addCurve(
            to: CGPoint(x: w - r, y: h),
            control1: CGPoint(x: w, y: h),
            control2: CGPoint(x: w, y: h)
        )

        p.addLine(to: CGPoint(x: r, y: h))
        p.addCurve(
            to: CGPoint(x: 0, y: h - r),
            control1: CGPoint(x: 0, y: h),
            control2: CGPoint(x: 0, y: h)
        )

        p.addLine(to: CGPoint(x: 0, y: topY + sy))

        // left shoulder: concave curve inward
        p.addCurve(
            to: CGPoint(x: 0, y: topY),
            control1: CGPoint(x: sc, y: topY + sy),
            control2: CGPoint(x: sc, y: topY)
        )

        p.closeSubpath()
        return p
    }
}

struct IslandSurface<Content: View>: View {
    let size: CGSize
    let shape: IslandNotchShape
    let fillOpacity: Double
    @ViewBuilder let content: Content

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        if reduceTransparency {
            reduceTransparencySurface
        } else {
            solidSurface
        }
    }

    private var solidSurface: some View {
        ZStack {
            shape.fill(Color(white: 0.04).opacity(fillOpacity))
                .animation(.none, value: fillOpacity)
            content
        }
        .frame(width: size.width, height: size.height)
        .clipShape(shape)
    }

    private var reduceTransparencySurface: some View {
        ZStack {
            content
        }
        .frame(width: size.width, height: size.height)
        .background(shape.fill(Color(white: 0.03).opacity(fillOpacity)))
        .clipShape(shape)
    }
}

struct ActivityMark: View {
    let status: IslandStatus
    let size: CGFloat = 15

    var body: some View {
        ZStack {
            Circle()
                .fill(status.color.opacity(0.12))
                .frame(width: size * 1.5, height: size * 1.5)
                .blur(radius: size * 0.18)

            RoundedRectangle(cornerRadius: size * 0.18, style: .continuous)
                .fill(status.color)
                .frame(width: size * 0.48, height: size * 0.48)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct CompactActiveContent: View {
    let session: IslandSession
    let notchHeight: CGFloat

    private var extensionHeight: CGFloat {
        IslandGeometry.expandedHeight - notchHeight
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer().frame(height: notchHeight)

            VStack(alignment: .center, spacing: 7) {
                Text(session.detail)
                    .font(.system(size: 15.5, weight: .regular))
                    .foregroundStyle(Color.white.opacity(0.62))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .multilineTextAlignment(.center)

                HStack(spacing: 10) {
                    ActivityMark(status: session.status)
                    Text(session.activity)
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(Color.white.opacity(0.96))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .fixedSize()
            }
            .frame(maxWidth: .infinity, maxHeight: extensionHeight, alignment: .center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ActivityIslandView: View {
    let session: IslandSession
    let notchHeight: CGFloat

    var body: some View {
        CompactActiveContent(session: session, notchHeight: notchHeight)
    }
}

struct ExpandedIslandView: View {
    let sessions: [IslandSession]
    let onSelect: (IslandSession) -> Void
    let notchHeight: CGFloat

    private var session: IslandSession {
        sessions.first ?? IslandFixtures.sessions[0]
    }

    var body: some View {
        CompactActiveContent(session: session, notchHeight: notchHeight)
            .contentShape(Rectangle())
            .onTapGesture { onSelect(session) }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(session.activity), \(session.title)")
            .accessibilityAddTraits(.isButton)
    }
}

struct ApprovalIslandView: View {
    let session: IslandSession
    let decisionPending: Bool
    let onDecision: (IslandApprovalDecision) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                ActivityMark(status: .approval)

                VStack(alignment: .leading, spacing: 2) {
                    Text(session.activity)
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Color.white.opacity(0.97))
                    Text(session.title)
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(Color.white.opacity(0.62))
                        .lineLimit(1)
                }

                Spacer()

                Text(session.elapsed)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(Color.white.opacity(0.52))
            }
            .padding(.horizontal, 24)
            .padding(.top, 17)

            HStack(spacing: 8) {
                Image(systemName: "pencil.line")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.45))
                Text(session.detail)
                    .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                    .foregroundStyle(Color.white.opacity(0.76))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 12)

            Spacer(minLength: 11)

            HStack(spacing: 7) {
                Spacer(minLength: 0)
                DecisionButton(label: "Deny", disabled: decisionPending) { onDecision(.deny) }
                DecisionButton(label: "Always allow", disabled: decisionPending) {
                    onDecision(.alwaysAllow)
                }
                DecisionButton(label: "Allow once", isPrimary: true, disabled: decisionPending) {
                    onDecision(.allowOnce)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 16)
        }
    }
}

private struct DecisionButton: View {
    let label: String
    var isPrimary = false
    var disabled = false
    let action: () -> Void

    @ViewBuilder
    var body: some View {
        #if SYNARA_HAS_LIQUID_GLASS
        if #available(macOS 26.0, *) {
            if isPrimary {
                decisionButton
                    .buttonStyle(.glassProminent)
                    .tint(Color.white.opacity(0.82))
            } else {
                decisionButton.buttonStyle(.glass)
            }
        } else {
            fallbackDecisionButton
        }
        #else
        fallbackDecisionButton
        #endif
    }

    private var decisionButton: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .frame(minWidth: isPrimary ? 70 : 62)
        }
        .controlSize(.small)
        .foregroundStyle(isPrimary ? Color.black.opacity(0.86) : Color.white.opacity(0.82))
        .disabled(disabled)
        .opacity(disabled ? 0.58 : 1)
    }

    @ViewBuilder
    private var fallbackDecisionButton: some View {
        if isPrimary {
            decisionButton
                .buttonStyle(.borderedProminent)
                .tint(Color.white.opacity(0.82))
        } else {
            decisionButton.buttonStyle(.bordered)
        }
    }
}
