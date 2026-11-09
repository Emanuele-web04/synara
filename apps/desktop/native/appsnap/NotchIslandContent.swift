import AppKit
import SwiftUI

// What the island shows: the closed ears and the open list, laid out like the
// app's sidebar. Shared pieces (rows, glyphs, buttons, motion) live in
// NotchIslandView.swift.

// MARK: - Closed ears

/// The closed island's ears: the leading chat's provider glyph on the left,
/// its status glyph and the count on the right.
@available(macOS 13.0, *)
struct NotchIslandClosedEars: View {
    @ObservedObject var model: NotchIslandModel

    var body: some View {
        let snapshot = model.snapshot
        let lead = snapshot.rows.first
        HStack(spacing: 0) {
            if let lead {
                NotchIslandGlyph(icon: model.icon(for: lead), size: 15)
                    .frame(width: NotchIslandGeometry.earWidth - 8)
            }
            Spacer(minLength: 0)
            if snapshot.count > 0 {
                HStack(spacing: 5) {
                    leadGlyph(snapshot.lead)
                    Text("\(snapshot.count)")
                        .font(.system(size: 12, weight: .medium).monospacedDigit())
                        .foregroundStyle(NotchIslandPalette.ink)
                        .contentTransition(.numericText())
                }
                .frame(width: NotchIslandGeometry.earWidth - 4)
            }
        }
        .padding(.horizontal, 4)
        .frame(height: model.notchSize.height)
        .contentShape(Rectangle())
        .onTapGesture { model.onOpenApp() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(model.labels.openApp)
    }

    @ViewBuilder
    private func leadGlyph(_ lead: NotchIslandSnapshot.Lead) -> some View {
        switch lead {
        case .needsYou: NotchIslandTrailingGlyph(state: .approval, reduceMotion: model.reduceMotion)
        case .working: NotchIslandTrailingGlyph(state: .working, reduceMotion: model.reduceMotion)
        case .finished: NotchIslandTrailingGlyph(state: .done, reduceMotion: model.reduceMotion)
        case .failed: NotchIslandTrailingGlyph(state: .failed, reduceMotion: model.reduceMotion)
        case .idle: EmptyView()
        }
    }
}

// MARK: - Sidebar

/// The sidebar: chats grouped under muted section labels, like "Recent" and
/// "Today" there.
@available(macOS 13.0, *)
struct NotchIslandSidebarContent: View {
    @ObservedObject var model: NotchIslandModel

    var body: some View {
        let rows = model.snapshot.rows
        let reduceMotion = model.reduceMotion
        if rows.isEmpty {
            NotchIslandEmptyRow(model: model)
                .notchStagger(1, reduceMotion: reduceMotion)
        } else {
            let groups = Dictionary(grouping: rows.enumerated(), by: { $0.element.state.group })
            VStack(spacing: 0) {
                ForEach(groups.keys.sorted(), id: \.self) { group in
                    let entries = groups[group] ?? []
                    let first = entries.first?.offset ?? 0
                    Text(sectionTitle(group))
                        .font(.system(size: 12))
                        .foregroundStyle(NotchIslandPalette.muted)
                        .padding(.leading, 10)
                        .padding(.bottom, 4)
                        .frame(maxWidth: .infinity, alignment: .bottomLeading)
                        .frame(height: NotchIslandGeometry.sectionLabelHeight)
                        .notchStagger(1 + first + group, reduceMotion: reduceMotion)
                    ForEach(entries, id: \.element.id) { index, row in
                        NotchIslandChatRow(
                            row: row,
                            icon: model.icon(for: row),
                            labels: model.labels,
                            reduceMotion: reduceMotion,
                            open: { model.onOpenThread(row.threadId) }
                        )
                        .notchStagger(2 + index + group, reduceMotion: reduceMotion)
                    }
                }
            }
        }
    }

    private func sectionTitle(_ group: Int) -> String {
        switch group {
        case 0: model.labels.needsYouTitle
        case 1: model.labels.stateWorking
        case 2: model.labels.stateFailed
        default: model.labels.readyForReview
        }
    }
}
