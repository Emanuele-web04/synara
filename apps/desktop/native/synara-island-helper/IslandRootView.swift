import SwiftUI

struct IslandRootView: View {
    @ObservedObject var model: IslandPreviewModel
    let onOpenSession: (IslandSession) -> Void
    let onDecision: (IslandApprovalDecision) -> Void

    private var headline: IslandSession {
        if let primarySessionID = model.primarySessionID,
           let primary = model.sessions.first(where: { $0.id == primarySessionID }) {
            return primary
        }
        return model.sessions.first ?? IslandFixtures.sessions[0]
    }

    private var islandSize: CGSize {
        model.geometry?.size(for: model.presentation) ?? IslandGeometry.activitySize
    }

    private var notchHeight: CGFloat {
        model.geometry?.notchRect.height ?? 38
    }

    private var islandShape: IslandNotchShape {
        let size = islandSize
        let collapsed = model.presentation == .collapsed
        return IslandNotchShape(
            width: size.width,
            height: size.height,
            shoulderY: 0,
            shoulderControlX: 0,
            bottomRadius: collapsed ? min(size.height / 2, 16) : 46,
            topOvershoot: 1
        )
    }

    var body: some View {
        island
            .frame(width: islandSize.width, height: islandSize.height)
            .padding(.top, IslandTokens.hostTopInset)
            .frame(width: islandSize.width, height: islandSize.height, alignment: .top)
            .ignoresSafeArea(.container, edges: .top)
    }

    private var island: some View {
        IslandSurface(size: islandSize, shape: islandShape, fillOpacity: model.collapsedHidden ? 0 : 1) {
            Group {
                switch model.presentation {
                case .collapsed:
                    EmptyView()
                case .activity:
                    ActivityIslandView(session: headline, notchHeight: notchHeight)
                case .approval:
                    ApprovalIslandView(
                        session: headline,
                        decisionPending: model.approvalDecisionPending,
                        onDecision: onDecision
                    )
                case .expanded:
                    ExpandedIslandView(
                        sessions: model.sessions,
                        onSelect: onOpenSession,
                        notchHeight: notchHeight
                    )
                }
            }
            .transition(
                .asymmetric(
                    insertion: .opacity
                        .combined(with: .scale(scale: 0.965, anchor: .top))
                        .combined(with: .offset(y: -6)),
                    removal: .opacity
                        .combined(with: .scale(scale: 0.985, anchor: .top))
                )
            )
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if (model.presentation == .collapsed || model.presentation == .activity),
               !model.sessions.isEmpty {
                onOpenSession(headline)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(headline.activity), \(headline.title)")
        .accessibilityAddTraits(
            model.presentation == .collapsed || model.presentation == .activity ? .isButton : []
        )
    }
}
