import AppKit
import SwiftUI

@available(macOS 13.0, *)
enum NotchIslandMotion {
    static let reshape = Animation.spring(response: 0.42, dampingFraction: 0.8)

    static func respectingReduceMotion(_ animation: Animation, _ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : animation
    }
}

/// Synara's dark tokens and sidebar status colours ("Pebble" direction).
@available(macOS 13.0, *)
enum NotchIslandPalette {
    static let surface = Color(hex: 0x0E0E0E)
    static let card = Color(hex: 0x141414)
    static let line = Color.white.opacity(0.07)
    static let wash = Color.white.opacity(0.05)
    static let ink = Color(hex: 0xF5F5F5)
    static let muted = Color(hex: 0x8A8A8A)
    static let brand = Color(hex: 0xFE8549)

    /// The sidebar status pills' dark-mode text colours and their tint.
    struct Tone {
        let ink: Color
        let tint: Color
    }

    static let approval = Tone(ink: Color(hex: 0xFCD34D), tint: Color(hex: 0xF59E0B).opacity(0.16))
    static let input = Tone(ink: Color(hex: 0xA5B4FC), tint: Color(hex: 0x6366F1).opacity(0.18))
    static let plan = Tone(ink: Color(hex: 0xC4B5FD), tint: Color(hex: 0x8B5CF6).opacity(0.18))
    static let working = Tone(ink: Color(hex: 0x7DD3FC), tint: Color(hex: 0x0EA5E9).opacity(0.16))
    static let done = Tone(ink: Color(hex: 0x6EE7B7), tint: Color(hex: 0x10B981).opacity(0.16))
    static let failed = Tone(ink: Color(hex: 0xF87171), tint: Color(hex: 0xEF4444).opacity(0.16))

    static func tone(_ state: NotchIslandSnapshot.RowState) -> Tone {
        switch state {
        case .approval: approval
        case .input: input
        case .plan: plan
        case .working: working
        case .done: done
        case .failed: failed
        }
    }

    static func tone(_ lead: NotchIslandSnapshot.Lead) -> Tone? {
        switch lead {
        case .needsYou: approval
        case .working: working
        case .failed: failed
        case .finished: done
        case .idle: nil
        }
    }
}

@available(macOS 13.0, *)
extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
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
            topRadius: expanded ? 10 : 6,
            bottomRadius: expanded ? 28 : min(14, model.notchSize.height / 2)
        )
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                shape.fill(NotchIslandPalette.surface)
                VStack(spacing: 0) {
                    NotchIslandTopRow(model: model, expanded: expanded)
                        .opacity(presence == .compact || expanded ? 1 : 0)
                    if expanded {
                        NotchIslandOpenContent(model: model)
                            .transition(.opacity)
                    }
                }
                .padding(.horizontal, expanded ? 12 : 6)
            }
            .frame(width: size.width, height: size.height, alignment: .top)
            .clipShape(shape)
            .shadow(color: .black.opacity(expanded ? 0.3 : 0), radius: 20, y: 10)
            .opacity(presence == .hidden ? 0 : 1)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(
            NotchIslandMotion.respectingReduceMotion(NotchIslandMotion.reshape, model.reduceMotion),
            value: presence
        )
        .animation(
            NotchIslandMotion.respectingReduceMotion(NotchIslandMotion.reshape, model.reduceMotion),
            value: model.snapshot.rows.count
        )
        .environment(\.colorScheme, .dark)
    }
}

/// The row level with the notch. Closed: the leading state and its count in the
/// ears. Open: Synara on the left, what needs you on the right.
@available(macOS 13.0, *)
private struct NotchIslandTopRow: View {
    @ObservedObject var model: NotchIslandModel
    let expanded: Bool

    var body: some View {
        HStack(spacing: 0) {
            if expanded {
                HStack(spacing: 6) {
                    Circle().fill(NotchIslandPalette.brand).frame(width: 8, height: 8)
                    Text("Synara")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(NotchIslandPalette.ink)
                }
                .padding(.leading, 8)
            } else {
                NotchIslandLeadBadge(lead: model.snapshot.lead, reduceMotion: model.reduceMotion)
                    .frame(width: NotchIslandGeometry.earWidth - 6, alignment: .center)
            }
            Spacer(minLength: 0)
            if let tone = NotchIslandPalette.tone(model.snapshot.lead), model.snapshot.count > 0 {
                NotchIslandCountPill(count: model.snapshot.count, tone: tone)
                    .frame(width: expanded ? nil : NotchIslandGeometry.earWidth - 6)
                    .padding(.trailing, expanded ? 4 : 0)
            }
        }
        .frame(height: model.notchSize.height)
        .contentShape(Rectangle())
        .onTapGesture { model.onOpenApp() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(model.labels.openApp)
    }
}

@available(macOS 13.0, *)
private struct NotchIslandOpenContent: View {
    @ObservedObject var model: NotchIslandModel

    var body: some View {
        let snapshot = model.snapshot
        VStack(spacing: NotchIslandGeometry.sectionSpacing) {
            HStack(spacing: 6) {
                NotchIslandCounter(value: snapshot.needsYou, label: model.labels.needYou, tone: NotchIslandPalette.approval)
                NotchIslandCounter(value: snapshot.working, label: model.labels.working, tone: NotchIslandPalette.working)
                NotchIslandCounter(value: snapshot.done, label: model.labels.done, tone: NotchIslandPalette.done)
            }
            .frame(height: NotchIslandGeometry.countersHeight)
            .contentShape(Rectangle())
            .onTapGesture { model.onOpenApp() }

            if snapshot.rows.isEmpty {
                HStack {
                    Text(model.labels.empty)
                        .font(.system(size: 13))
                        .foregroundStyle(NotchIslandPalette.muted)
                    Spacer(minLength: 8)
                    Button(model.labels.openApp) { model.onOpenApp() }
                        .buttonStyle(NotchIslandPillButtonStyle())
                }
                .padding(.horizontal, 10)
                .frame(height: NotchIslandGeometry.emptyHeight)
            } else {
                VStack(spacing: NotchIslandGeometry.rowSpacing) {
                    ForEach(snapshot.rows) { row in
                        NotchIslandChatRow(
                            row: row,
                            icon: row.provider.flatMap { model.icons[$0] },
                            labels: model.labels,
                            reduceMotion: model.reduceMotion,
                            open: { model.onOpenThread(row.threadId) }
                        )
                    }
                }
            }
        }
        .padding(.top, NotchIslandGeometry.sectionSpacing)
        .padding(.bottom, NotchIslandGeometry.bottomPadding)
    }
}

/// One rounded, tinted count: the number large, its meaning beside it.
@available(macOS 13.0, *)
private struct NotchIslandCounter: View {
    let value: Int
    let label: String
    let tone: NotchIslandPalette.Tone

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("\(value)")
                .font(.system(size: 22, weight: .semibold).monospacedDigit())
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .foregroundStyle(tone.ink)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(tone.tint))
    }
}

/// A chat as the sidebar shows it: provider glyph, title, project and status.
/// Chats that need you sit on a card; the whole row opens the chat.
@available(macOS 13.0, *)
private struct NotchIslandChatRow: View {
    let row: NotchIslandSnapshot.Row
    let icon: NSImage?
    let labels: NotchIslandLabels
    let reduceMotion: Bool
    let open: () -> Void

    var body: some View {
        let tone = NotchIslandPalette.tone(row.state)
        Button(action: open) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(NotchIslandPalette.wash)
                    if let icon {
                        Image(nsImage: icon)
                            .resizable()
                            .interpolation(.high)
                            .frame(width: 16, height: 16)
                    } else {
                        Circle().fill(NotchIslandPalette.muted).frame(width: 6, height: 6)
                    }
                }
                .frame(width: 32, height: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(NotchIslandPalette.ink)
                        .lineLimit(1)
                    Text(
                        "\(Text(verbatim: row.project.map { "\($0) · " } ?? "").foregroundColor(NotchIslandPalette.muted))\(Text(verbatim: labels.status(row.state)).foregroundColor(tone.ink))"
                    )
                    .font(.system(size: 12))
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                trailing(tone: tone)
            }
            .padding(.leading, 10)
            .padding(.trailing, 8)
            .frame(height: NotchIslandGeometry.rowHeight)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(row.state.needsYou ? NotchIslandPalette.card : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(row.state.needsYou ? NotchIslandPalette.line : Color.clear)
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func trailing(tone: NotchIslandPalette.Tone) -> some View {
        if row.state.needsYou {
            Text(labels.review)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(NotchIslandPalette.surface)
                .padding(.horizontal, 12)
                .frame(height: 28)
                .background(Capsule().fill(NotchIslandPalette.ink))
        } else if row.state == .working {
            NotchIslandSpinner(color: tone.ink, size: 16, reduceMotion: reduceMotion)
                .padding(.trailing, 8)
        } else {
            Text(labels.open)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(NotchIslandPalette.ink)
                .padding(.trailing, 8)
        }
    }
}

@available(macOS 13.0, *)
private struct NotchIslandPillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(NotchIslandPalette.surface)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background(Capsule().fill(NotchIslandPalette.ink.opacity(configuration.isPressed ? 0.8 : 1)))
    }
}

/// The closed island's left ear: the leading state in a tinted circle.
@available(macOS 13.0, *)
private struct NotchIslandLeadBadge: View {
    let lead: NotchIslandSnapshot.Lead
    let reduceMotion: Bool

    var body: some View {
        if let tone = NotchIslandPalette.tone(lead) {
            ZStack {
                Circle().fill(tone.tint)
                switch lead {
                case .needsYou:
                    Image(systemName: "exclamationmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(tone.ink)
                case .working:
                    NotchIslandSpinner(color: tone.ink, size: 11, reduceMotion: reduceMotion)
                case .finished:
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(tone.ink)
                case .failed:
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(tone.ink)
                case .idle:
                    EmptyView()
                }
            }
            .frame(width: 20, height: 20)
        }
    }
}

@available(macOS 13.0, *)
private struct NotchIslandCountPill: View {
    let count: Int
    let tone: NotchIslandPalette.Tone

    var body: some View {
        Text("\(count)")
            .font(.system(size: 12, weight: .semibold).monospacedDigit())
            .foregroundStyle(tone.ink)
            .padding(.horizontal, 7)
            .frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(tone.tint))
    }
}

@available(macOS 13.0, *)
private struct NotchIslandSpinner: View {
    let color: Color
    let size: CGFloat
    let reduceMotion: Bool
    @State private var spinning = false

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.25), lineWidth: 2)
            Circle()
                .trim(from: 0, to: 0.28)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(
                    reduceMotion ? nil : .linear(duration: 0.9).repeatForever(autoreverses: false),
                    value: spinning
                )
        }
        .frame(width: size, height: size)
        .task(id: reduceMotion) { spinning = !reduceMotion }
    }
}
