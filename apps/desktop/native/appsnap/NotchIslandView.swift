import AppKit
import SwiftUI

@available(macOS 13.0, *)
enum NotchIslandMotion {
    /// Opening swells with a touch of overshoot; closing settles without any, so
    /// the outline never dips below the camera housing on the way back.
    static let open = Animation.spring(response: 0.42, dampingFraction: 0.82)
    static let close = Animation.spring(response: 0.38, dampingFraction: 1.0)
    /// The closed ears' icon and count: gone at once when opening, back after
    /// the outline has mostly shrunk when closing.
    static let earsOut = Animation.easeOut(duration: 0.1)
    static let earsIn = Animation.easeOut(duration: 0.18).delay(0.16)
    /// Open content blurs out quickly when closing.
    static let contentOut = Animation.easeOut(duration: 0.12)
    /// Open content arrives in order (header, then each block) a beat after the
    /// outline starts to grow, so nothing shows clipped.
    static func stagger(_ index: Int) -> Animation {
        .spring(response: 0.42, dampingFraction: 0.84).delay(0.1 + Double(index) * 0.045)
    }

    static func respectingReduceMotion(_ animation: Animation, _ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : animation
    }
}

/// Synara's dark-theme tokens (`index.css`, the Paper app UI kit) and the
/// sidebar's status colours. The island itself is pure black so it reads as
/// one shape with the camera housing; everything on it uses the app's values.
@available(macOS 13.0, *)
enum NotchIslandPalette {
    static let surface = Color.black
    /// `--secondary` / `--muted`: the app's 4% white wash for quiet surfaces.
    static let wash = Color.white.opacity(0.04)
    /// `--color-appd-card`, for the one raised card.
    static let card = Color(hex: 0x141414)
    /// `--color-appd-line`.
    static let line = Color.white.opacity(0.07)
    /// `--color-appd-hover`.
    static let hover = Color.white.opacity(0.05)
    static let ink = Color(hex: 0xF5F5F5)
    /// `--muted-foreground`.
    static let muted = Color(hex: 0x8A8A8A)
    /// The running spinner's `text-muted-foreground/55`.
    static let spinner = Color(hex: 0x8A8A8A).opacity(0.75)
    static let brand = Color(hex: 0xFE8549)
    /// `--info` / `--color-text-accent`: the sidebar's unread-completion dot.
    static let info = Color(hex: 0x7B8CFF)
    static let success = Color(hex: 0x6EE7B7).opacity(0.9)

    /// `ThreadStatusPill` dark colours: `text-amber-300/90` and friends.
    static func status(_ state: NotchIslandSnapshot.RowState) -> Color {
        switch state {
        case .approval: Color(hex: 0xFCD34D).opacity(0.9)
        case .input: Color(hex: 0xA5B4FC).opacity(0.9)
        case .plan: Color(hex: 0xC4B5FD).opacity(0.9)
        case .working: Color(hex: 0x7DD3FC).opacity(0.8)
        case .done: Color(hex: 0x6EE7B7).opacity(0.9)
        case .failed: Color(hex: 0xF87171)
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
        let reduceMotion = model.reduceMotion
        let shape = NotchIslandShape(
            earRadius: expanded ? NotchIslandGeometry.openEarRadius : NotchIslandGeometry.closedEarRadius,
            bottomRadius: expanded
                ? NotchIslandGeometry.openBottomRadius
                : min(NotchIslandGeometry.closedBottomRadius, model.notchSize.height / 2)
        )
        let compactWidth = NotchIslandGeometry.islandSize(for: .compact, notch: model.notchSize, list: .empty).width
        let openWidth = NotchIslandGeometry.islandSize(for: .expanded, notch: model.notchSize, list: .empty).width
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                shape.fill(NotchIslandPalette.surface)

                NotchIslandClosedEars(model: model)
                    .frame(width: compactWidth)
                    .opacity(presence == .compact ? 1 : 0)
                    .animation(
                        NotchIslandMotion.respectingReduceMotion(
                            expanded ? NotchIslandMotion.earsOut : NotchIslandMotion.earsIn,
                            reduceMotion
                        ),
                        value: presence
                    )

                if expanded {
                    VStack(spacing: 0) {
                        NotchIslandOpenHeader(model: model)
                            .notchStagger(0, reduceMotion: reduceMotion)
                        NotchIslandSidebarContent(model: model)
                            .padding(.top, NotchIslandGeometry.contentTop)
                            .padding(.bottom, NotchIslandGeometry.bottomPadding)
                    }
                    .padding(.horizontal, NotchIslandGeometry.contentInset)
                    // Laid out at the final width from the first frame, so nothing reflows
                    // while the outline grows around it.
                    .frame(width: openWidth)
                    .transition(
                        .asymmetric(
                            insertion: .identity,
                            removal: AnyTransition.notchBlurFade.animation(
                                NotchIslandMotion.respectingReduceMotion(NotchIslandMotion.contentOut, reduceMotion)
                            )
                        )
                    )
                }
            }
            .frame(width: size.width, height: size.height, alignment: .top)
            .clipShape(shape)
            // A tight, dark shadow only when open: a wide soft one reads as a grey
            // haze and makes the black look washed out.
            .shadow(color: .black.opacity(expanded ? 0.45 : 0), radius: 12, y: 4)
            .opacity(presence == .hidden ? 0 : 1)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(
            NotchIslandMotion.respectingReduceMotion(expanded ? NotchIslandMotion.open : NotchIslandMotion.close, reduceMotion),
            value: presence
        )
        .animation(
            NotchIslandMotion.respectingReduceMotion(NotchIslandMotion.open, reduceMotion),
            value: model.snapshot.rows.count
        )
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - Shared pieces

/// The Synara mark, drawn from the app's logo so it takes the island's ink.
@available(macOS 13.0, *)
@MainActor
enum NotchIslandBrand {
    static let logo: NSImage? = {
        let markup = ##"<svg width="470" height="504" viewBox="0 0 470 504" xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="M2.65188 2.1899C-0.630695 5.47248 -0.995426 113.797 2.28715 121.821C3.74607 125.104 35.8423 149.906 74.5038 176.531C148.179 227.958 159.121 237.806 170.428 260.054L177.358 273.914L194.135 252.76C203.254 241.088 212.372 228.323 214.196 224.311C228.055 197.685 220.396 158.659 196.324 132.763C181.735 117.08 23.0768 4.37828 11.4054 1.09571C8.12283 0.366249 4.1108 0.73098 2.65188 2.1899Z"/><path fill="#000" d="M467.348 1.45943C470.631 4.74201 470.995 113.067 467.713 121.091C466.254 124.374 434.158 149.175 395.496 175.801C321.821 227.228 310.879 237.075 299.572 259.324L292.642 273.184L275.865 252.029C266.746 240.358 257.628 227.592 255.804 223.58C241.945 196.955 249.604 157.929 273.676 132.033C288.265 116.35 446.923 3.64782 458.595 0.365241C461.877 -0.36422 465.889 0.000510871 467.348 1.45943Z"/><path fill="#000" d="M217.479 291.602C187.396 324.802 187 326.002 187 420.002V494.002C187 499.525 191.477 504.002 197 504.002H234.5H272C277.523 504.002 282 499.525 282 494.002V418.002C282 351.202 280.812 329.602 276.458 322.002C269.729 310.002 239.25 274.002 236.083 274.002C234.5 274.002 226.187 282.002 217.479 291.602Z"/></svg>"##
        let image = NSImage(data: Data(markup.utf8))
        image?.isTemplate = true
        return image
    }()
}

/// The open island's row level with the notch, like the sidebar's header:
/// the Synara mark and name on the left, a quiet summary on the right.
@available(macOS 13.0, *)
private struct NotchIslandOpenHeader: View {
    @ObservedObject var model: NotchIslandModel

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 7) {
                if let logo = NotchIslandBrand.logo {
                    Image(nsImage: logo)
                        .renderingMode(.template)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(height: 12)
                }
                Text("Synara")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundStyle(NotchIslandPalette.ink)
            .padding(.leading, 10)
            Spacer(minLength: 0)
            summary.padding(.trailing, 10)
        }
        .frame(height: model.notchSize.height)
        .contentShape(Rectangle())
        .onTapGesture { model.onOpenApp() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(model.labels.openApp)
    }

    /// "2 need you", like the Inbox greeting's "2 tasks to do".
    @ViewBuilder
    private var summary: some View {
        let snapshot = model.snapshot
        if snapshot.needsYou > 0 {
            summaryLine(snapshot.needsYou, model.labels.needYou) {
                NotchIslandDot(color: NotchIslandPalette.status(.approval))
            }
        } else if snapshot.working > 0 {
            summaryLine(snapshot.working, model.labels.working) {
                NotchIslandSpinner(size: 11, reduceMotion: model.reduceMotion)
            }
        }
    }

    private func summaryLine<Mark: View>(_ value: Int, _ label: String, @ViewBuilder mark: () -> Mark) -> some View {
        HStack(spacing: 6) {
            mark()
            Text("\(value) \(label)")
                .font(.system(size: 12))
                .foregroundStyle(NotchIslandPalette.muted)
                .contentTransition(.numericText())
                .lineLimit(1)
        }
    }
}

@available(macOS 13.0, *)
struct NotchIslandGlyph: View {
    let icon: NSImage?
    let size: CGFloat

    var body: some View {
        Group {
            if let icon {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Circle()
                    .fill(NotchIslandPalette.muted.opacity(0.6))
                    .padding(size * 0.3)
            }
        }
        .frame(width: size, height: size)
    }
}

/// The sidebar's 6px `StatusDot`.
@available(macOS 13.0, *)
struct NotchIslandDot: View {
    let color: Color
    var size: CGFloat = 6

    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
    }
}

/// `SidebarStatusTrailingGlyph`: the running spinner while working, the blue
/// unread dot when done, otherwise the state's dot.
@available(macOS 13.0, *)
struct NotchIslandTrailingGlyph: View {
    let state: NotchIslandSnapshot.RowState
    let reduceMotion: Bool

    var body: some View {
        Group {
            switch state {
            case .working:
                NotchIslandSpinner(size: 12, reduceMotion: reduceMotion)
            case .done:
                NotchIslandDot(color: NotchIslandPalette.info, size: 7)
            default:
                NotchIslandDot(color: NotchIslandPalette.status(state))
            }
        }
        .frame(width: 12, height: 12)
    }
}

/// `ThreadRunningSpinner`: a faint track and a rounded arc from 0.16 to 0.72.
@available(macOS 13.0, *)
struct NotchIslandSpinner: View {
    let size: CGFloat
    let reduceMotion: Bool
    var color: Color = NotchIslandPalette.spinner
    @State private var spinning = false

    var body: some View {
        let lineWidth = size * 2 / 15
        ZStack {
            Circle().stroke(color.opacity(0.22), lineWidth: lineWidth * 0.7)
            Circle()
                .trim(from: 0.16, to: 0.72)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(
                    reduceMotion ? nil : .linear(duration: 1.1).repeatForever(autoreverses: false),
                    value: spinning
                )
        }
        .padding(lineWidth / 2)
        .frame(width: size, height: size)
        .task(id: reduceMotion) { spinning = !reduceMotion }
    }
}

/// A chat as the sidebar draws it: provider glyph, title, and a muted meta
/// line whose status is in the state's colour. What needs you gets the app's
/// small Review button; everything else its trailing status glyph.
@available(macOS 13.0, *)
struct NotchIslandChatRow: View {
    let row: NotchIslandSnapshot.Row
    let icon: NSImage?
    let labels: NotchIslandLabels
    let reduceMotion: Bool
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 9) {
                NotchIslandGlyph(icon: icon, size: 15)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title)
                        .font(.system(size: 13))
                        .foregroundStyle(NotchIslandPalette.ink)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        if let project = row.project {
                            Text(project)
                            Text("·")
                        }
                        Text(labels.status(row.state))
                            .foregroundStyle(NotchIslandPalette.status(row.state))
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(NotchIslandPalette.muted)
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                Group {
                    if row.state.needsYou {
                        Text(labels.review).notchIslandSecondaryButton()
                    } else {
                        NotchIslandTrailingGlyph(state: row.state, reduceMotion: reduceMotion)
                            .padding(.trailing, 4)
                    }
                }
                .frame(height: 30)
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .frame(height: NotchIslandGeometry.rowHeight, alignment: .top)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(hovering ? NotchIslandPalette.hover : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(NotchIslandPressStyle())
        .onHover { hovering = $0 }
    }
}

/// What the open island shows with no chats.
@available(macOS 13.0, *)
struct NotchIslandEmptyRow: View {
    @ObservedObject var model: NotchIslandModel

    var body: some View {
        HStack(spacing: 8) {
            Text(model.labels.empty)
                .font(.system(size: 13))
                .foregroundStyle(NotchIslandPalette.muted)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button(model.labels.openApp) { model.onOpenApp() }
                .buttonStyle(NotchIslandSecondaryButtonStyle())
        }
        .padding(.horizontal, 10)
        .frame(height: NotchIslandGeometry.emptyHeight)
    }
}

/// The app's small secondary button ("Review", "Turn on"): a faint fill and
/// hairline, 8pt corners.
@available(macOS 13.0, *)
struct NotchIslandSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .notchIslandSecondaryButton(pressed: configuration.isPressed)
    }
}

@available(macOS 13.0, *)
extension View {
    func notchIslandSecondaryButton(pressed: Bool = false) -> some View {
        font(.system(size: 12, weight: .medium))
            .foregroundStyle(NotchIslandPalette.ink)
            .padding(.horizontal, 10)
            .frame(height: 24)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.white.opacity(pressed ? 0.11 : 0.07))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08))
                    )
            )
    }
}

/// Rows dim a touch while pressed, like the app's list items.
@available(macOS 13.0, *)
struct NotchIslandPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Open content arrives in order, each block settling down from the notch.
@available(macOS 13.0, *)
private struct NotchIslandStagger: ViewModifier {
    let index: Int
    let reduceMotion: Bool
    @State private var shown: Bool

    init(index: Int, reduceMotion: Bool) {
        self.index = index
        self.reduceMotion = reduceMotion
        _shown = State(initialValue: reduceMotion)
    }

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .blur(radius: shown ? 0 : 3)
            .offset(y: shown ? 0 : -5)
            .onAppear {
                guard !shown else { return }
                withAnimation(NotchIslandMotion.stagger(index)) { shown = true }
            }
    }
}

@available(macOS 13.0, *)
extension View {
    func notchStagger(_ index: Int, reduceMotion: Bool) -> some View {
        modifier(NotchIslandStagger(index: index, reduceMotion: reduceMotion))
    }
}

/// Content that blurs while it fades, so it never pops in or out sharply.
@available(macOS 13.0, *)
private struct NotchBlurFade: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        content.blur(radius: active ? 5 : 0).opacity(active ? 0 : 1)
    }
}

@available(macOS 13.0, *)
extension AnyTransition {
    static var notchBlurFade: AnyTransition {
        .modifier(active: NotchBlurFade(active: true), identity: NotchBlurFade(active: false))
    }
}
