import SwiftUI

@available(macOS 13.0, *)
enum NotchIslandMotion {
    static let reshape = Animation.spring(response: 0.42, dampingFraction: 0.8)
    static let contents = Animation.easeOut(duration: 0.16)

    static func respectingReduceMotion(_ animation: Animation, _ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : animation
    }
}

/// Fills the panel; the island hangs from its top center. Everything outside
/// the island is transparent and does not take the pointer.
@available(macOS 13.0, *)
struct NotchIslandView: View {
    @ObservedObject var model: NotchIslandModel

    var body: some View {
        let presence = model.presence
        let size = model.islandSize
        let expanded = presence == .expanded
        let shape = NotchIslandShape(
            topRadius: expanded ? 12 : 6,
            bottomRadius: expanded ? 22 : min(10, model.notchSize.height / 2)
        )
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                shape.fill(Color.black)
                content(presence: presence, inset: expanded ? 12 : 6)
            }
            .frame(width: size.width, height: size.height)
            .clipShape(shape)
            .shadow(color: .black.opacity(expanded ? 0.35 : 0), radius: 12, y: 4)
            .opacity(presence == .hidden ? 0 : 1)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(
            NotchIslandMotion.respectingReduceMotion(NotchIslandMotion.reshape, model.reduceMotion),
            value: presence
        )
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private func content(presence: NotchIslandPresence, inset: CGFloat) -> some View {
        VStack(spacing: 0) {
            statusBar(visible: presence == .compact || presence == .expanded)
                .padding(.horizontal, inset)
            if presence == .expanded {
                NotchIslandExpandedContent(model: model)
                    .padding(.horizontal, inset + 6)
                    .padding(.bottom, 10)
                    .transition(.opacity)
            }
        }
    }

    /// The row level with the notch: status icon on the left ear, count on the right.
    private func statusBar(visible: Bool) -> some View {
        HStack(spacing: 0) {
            NotchIslandLeadIcon(lead: model.snapshot.lead, reduceMotion: model.reduceMotion)
                .frame(width: NotchIslandGeometry.earWidth, height: model.notchSize.height)
            Spacer(minLength: 0)
            Text(model.snapshot.count > 0 ? "\(model.snapshot.count)" : "")
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .foregroundStyle(Color.white)
                .frame(width: NotchIslandGeometry.earWidth, height: model.notchSize.height)
        }
        .frame(height: model.notchSize.height)
        .opacity(visible ? 1 : 0)
        .contentShape(Rectangle())
        .onTapGesture { model.onOpenApp() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(model.labels.openApp)
    }
}

@available(macOS 13.0, *)
private struct NotchIslandExpandedContent: View {
    @ObservedObject var model: NotchIslandModel

    var body: some View {
        if model.snapshot.rows.isEmpty {
            VStack(spacing: 10) {
                Spacer(minLength: 0)
                Text(model.labels.empty)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.white.opacity(0.6))
                Button(model.labels.openApp) { model.onOpenApp() }
                    .buttonStyle(NotchIslandRowButtonStyle())
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.white)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 2) {
                ForEach(model.snapshot.rows) { row in
                    Button { model.onOpenThread(row.threadId) } label: {
                        NotchIslandRowLabel(row: row, reduceMotion: model.reduceMotion)
                    }
                    .buttonStyle(NotchIslandRowButtonStyle())
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }
}

@available(macOS 13.0, *)
private struct NotchIslandRowLabel: View {
    let row: NotchIslandSnapshot.Row
    let reduceMotion: Bool

    var body: some View {
        HStack(spacing: 10) {
            NotchIslandStateIcon(state: row.state, reduceMotion: reduceMotion)
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                if let project = row.project, !project.isEmpty {
                    Text(project)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.white.opacity(0.55))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

@available(macOS 13.0, *)
private struct NotchIslandRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.16 : 0.06))
            )
    }
}

@available(macOS 13.0, *)
private struct NotchIslandLeadIcon: View {
    let lead: NotchIslandSnapshot.Lead
    let reduceMotion: Bool

    var body: some View {
        switch lead {
        case .needsYou:
            NotchIslandSymbol(name: "exclamationmark.circle.fill", color: .orange)
        case .working:
            NotchIslandSpinner(reduceMotion: reduceMotion)
        case .finished:
            NotchIslandSymbol(name: "checkmark.circle.fill", color: .green)
        case .failed:
            NotchIslandSymbol(name: "xmark.circle.fill", color: .red)
        case .idle:
            Color.clear
        }
    }
}

@available(macOS 13.0, *)
private struct NotchIslandStateIcon: View {
    let state: NotchIslandSnapshot.RowState
    let reduceMotion: Bool

    var body: some View {
        switch state {
        case .needsApproval, .needsInput:
            NotchIslandSymbol(name: "exclamationmark.circle.fill", color: .orange)
        case .working:
            NotchIslandSpinner(reduceMotion: reduceMotion)
        case .finished:
            NotchIslandSymbol(name: "checkmark.circle.fill", color: .green)
        case .failed:
            NotchIslandSymbol(name: "xmark.circle.fill", color: .red)
        }
    }
}

@available(macOS 13.0, *)
private struct NotchIslandSymbol: View {
    let name: String
    let color: Color

    var body: some View {
        Image(systemName: name)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(color)
    }
}

@available(macOS 13.0, *)
private struct NotchIslandSpinner: View {
    let reduceMotion: Bool
    @State private var spinning = false

    var body: some View {
        Circle()
            .trim(from: 0.2, to: 1)
            .stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .frame(width: 12, height: 12)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .animation(
                reduceMotion ? nil : .linear(duration: 0.9).repeatForever(autoreverses: false),
                value: spinning
            )
            .task(id: reduceMotion) { spinning = !reduceMotion }
    }
}
