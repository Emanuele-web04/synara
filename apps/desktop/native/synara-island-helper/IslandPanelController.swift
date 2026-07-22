import AppKit
import SwiftUI

private final class IslandPanel: NSPanel {
    override var canBecomeMain: Bool { false }
    override var canBecomeKey: Bool { false }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}

private final class IslandHostingView: NSHostingView<IslandRootView> {
    override var isOpaque: Bool { false }
}

@MainActor
final class IslandPanelController: NSObject {
    private let panel: IslandPanel
    private let viewModel: IslandPreviewModel
    private let liveMode: Bool
    private let selectedDisplayID: CGDirectDisplayID?
    private var hostingView: NSHostingView<IslandRootView>!
    private var hoverTimer: Timer?
    private var collapseTask: DispatchWorkItem?
    private var collapseHideTask: DispatchWorkItem?
    private var activityTimeoutTask: DispatchWorkItem?
    private var hasLoggedGeometry = false
    var onAction: ((IslandUserAction) -> Void)?

    init(
        initialPresentation: IslandPresentation,
        sessions: [IslandSession] = IslandFixtures.sessions,
        liveMode: Bool = false
    ) {
        viewModel = IslandPreviewModel(
            presentation: initialPresentation,
            sessions: sessions,
            collapsedHidden: initialPresentation == .collapsed
        )
        self.liveMode = liveMode
        selectedDisplayID = Self.findBuiltInScreen()?.displayID
        panel = IslandPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.isMovable = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .canJoinAllApplications,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        panel.animationBehavior = .none

        let rootView = IslandRootView(
            model: viewModel,
            onOpenSession: { [weak self] session in
                self?.handleOpenSession(session)
            },
            onDecision: { [weak self] decision in
                self?.handleDecision(decision)
            }
        )
        let hosting = IslandHostingView(rootView: rootView)
        hosting.sizingOptions = [.intrinsicContentSize]
        hosting.autoresizingMask = [.width, .height]
        hostingView = hosting
        panel.contentView = hostingView

        if let screen = preferredScreen() {
            updateGeometry(for: screen, log: true)
        }
    }

    func show() {
        if viewModel.geometry == nil, let screen = preferredScreen() {
            updateGeometry(for: screen, log: true)
        }
        applyFrame(for: viewModel.presentation, animate: false, label: "show")
        panel.orderFrontRegardless()
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.displayIfNeeded()
        logFrame(label: "after orderFront")
        DispatchQueue.main.async { [weak self] in
            self?.logFrame(label: "next runloop")
        }
        startHoverTracking()
    }

    func applyLiveSnapshot(
        sessions: [IslandSession],
        primarySessionID: String?,
        presentation: IslandPresentation?,
        approval: IslandApprovalContext?,
        revision: Int,
        completion: @escaping @MainActor @Sendable () -> Void
    ) {
        viewModel.sessions = sessions
        viewModel.primarySessionID = primarySessionID
        viewModel.approval = approval
        viewModel.approvalDecisionPending = false
        viewModel.liveRevision = revision

        guard let presentation else {
            panel.orderOut(nil)
            DispatchQueue.main.async(execute: completion)
            return
        }

        if presentation != .collapsed, sessions.isEmpty {
            panel.orderOut(nil)
            DispatchQueue.main.async(execute: completion)
            return
        }

        if let screen = preferredScreen() {
            if viewModel.geometry?.screen.displayID != screen.displayID {
                updateGeometry(for: screen, log: true)
            }
        }

        if presentation == .activity {
            startActivityTimeout()
        } else {
            activityTimeoutTask?.cancel()
            activityTimeoutTask = nil
        }

        if presentation == .approval {
            cancelCollapse()
        }

        if presentation == viewModel.presentation {
            applyFrame(for: presentation, animate: false, label: "snapshot-same")
        } else {
            transition(to: presentation)
        }
        panel.orderFrontRegardless()
        logFrame(label: "after orderFront")
        DispatchQueue.main.async { [weak self] in
            self?.logFrame(label: "next runloop")
        }
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.displayIfNeeded()
        DispatchQueue.main.async(execute: completion)
    }

    private func handleOpenSession(_ session: IslandSession) {
        if liveMode {
            onAction?(.openThread(threadID: session.id))
            return
        }
        transition(to: .expanded)
    }

    private func handleDecision(_ decision: IslandApprovalDecision) {
        if liveMode,
           let approval = viewModel.approval {
            guard !viewModel.approvalDecisionPending else { return }
            viewModel.approvalDecisionPending = true
            onAction?(
                .respondToApproval(
                    threadID: approval.threadID,
                    requestID: approval.requestID,
                    decision: decision
                )
            )
            return
        }
        transition(to: .expanded)
    }

    private func transition(to presentation: IslandPresentation) {
        guard presentation != viewModel.presentation else { return }

        collapseHideTask?.cancel()
        collapseHideTask = nil
        viewModel.collapsedHidden = false

        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if reduceMotion {
            viewModel.presentation = presentation
        } else {
            withAnimation(IslandTokens.islandSpring) {
                viewModel.presentation = presentation
            }
        }
        applyFrame(for: presentation, animate: !reduceMotion, label: "transition")

        if presentation == .collapsed {
            let task = DispatchWorkItem { [weak self] in
                self?.viewModel.collapsedHidden = true
                self?.collapseHideTask = nil
            }
            collapseHideTask = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: task)
        }
    }

    private func applyFrame(for presentation: IslandPresentation, animate: Bool, label: String) {
        guard let screen = preferredScreen(), let geometry = viewModel.geometry else { return }

        if geometry.screen.displayID != screen.displayID {
            updateGeometry(for: screen, log: false)
        }

        let target = viewModel.geometry!.islandFrame(for: presentation)
        let screenMaxY = screen.frame.maxY

        print("[island-applyFrame] [\(label)] target=\(target) screen.maxY=\(screenMaxY)")

        panel.setFrame(target, display: true, animate: animate)

        print("[island-applyFrame] [\(label)] after setFrame panel.frame=\(panel.frame)")
        assert(
            abs(panel.frame.maxY - screenMaxY) <= 0.5,
            "panel.frame.maxY \(panel.frame.maxY) != screen.frame.maxY \(screenMaxY)"
        )
    }

    private func logFrame(label: String) {
        guard let screen = preferredScreen() else { return }
        print("[island-frame] [\(label)] panel.frame=\(panel.frame)")
        print("[island-frame] [\(label)] contentView.frame=\(panel.contentView?.frame ?? .zero)")
        print("[island-frame] [\(label)] contentView.bounds=\(panel.contentView?.bounds ?? .zero)")
        print("[island-frame] [\(label)] hostingView.safeAreaInsets=\(hostingView.safeAreaInsets)")
        print("[island-frame] [\(label)] hostingView.additionalSafeAreaInsets=\(hostingView.additionalSafeAreaInsets)")
        print("[island-frame] [\(label)] screen.frame=\(screen.frame) screen.maxY=\(screen.frame.maxY)")
        print("[island-frame] [\(label)] mismatch=\(panel.frame.maxY - screen.frame.maxY)")
        fflush(stdout)
    }

    private static func findBuiltInScreen() -> NSScreen? {
        if #available(macOS 14.0, *) {
            if let notched = NSScreen.screens.first(where: { $0.auxiliaryTopLeftArea != nil }) {
                return notched
            }
        }
        return NSScreen.screens.first(where: {
            $0.localizedName.localizedCaseInsensitiveContains("built-in")
        })
    }

    private func preferredScreen() -> NSScreen? {
        guard let selectedDisplayID else { return nil }
        return NSScreen.screens.first(where: { screen in
            screen.displayID == selectedDisplayID
        })
    }

    private func updateGeometry(for screen: NSScreen, log: Bool) {
        let geometry = IslandGeometry(screen: screen)
        viewModel.geometry = geometry
        if log, !hasLoggedGeometry {
            geometry.logOnce()
            hasLoggedGeometry = true
        }
    }

    private func startHoverTracking() {
        guard hoverTimer == nil else { return }
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updateHover()
            }
        }
    }

    private func stopHoverTracking() {
        hoverTimer?.invalidate()
        hoverTimer = nil
    }

    private func updateHover() {
        guard let geometry = viewModel.geometry else { return }
        let mouse = NSEvent.mouseLocation
        let state = viewModel.presentation

        if state == .approval {
            return
        }

        let insideIsland = geometry.islandFrame(for: state).contains(mouse)
        let insideTrigger = geometry.triggerRect.contains(mouse)

        if insideIsland || insideTrigger {
            cancelCollapse()
            if state == .collapsed {
                transition(to: .activity)
            }
        } else {
            if state == .activity || state == .expanded {
                if collapseTask == nil {
                    let task = DispatchWorkItem { [weak self] in
                        guard let self else { return }
                        if self.viewModel.presentation == .activity || self.viewModel.presentation == .expanded {
                            self.transition(to: .collapsed)
                        }
                        self.collapseTask = nil
                    }
                    collapseTask = task
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: task)
                }
            }
        }
    }

    private func startActivityTimeout() {
        activityTimeoutTask?.cancel()
        let task = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.activityTimeoutTask = nil
            self.updateHover()
        }
        activityTimeoutTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: task)
    }

    private func cancelCollapse() {
        collapseTask?.cancel()
        collapseTask = nil
        activityTimeoutTask?.cancel()
        activityTimeoutTask = nil
    }
}

@MainActor
final class IslandPreviewModel: ObservableObject {
    @Published var presentation: IslandPresentation
    @Published var sessions: [IslandSession]
    @Published var primarySessionID: String?
    @Published var approval: IslandApprovalContext?
    @Published var approvalDecisionPending: Bool
    @Published var liveRevision: Int?
    @Published var geometry: IslandGeometry?
    @Published var collapsedHidden: Bool

    init(
        presentation: IslandPresentation,
        sessions: [IslandSession],
        collapsedHidden: Bool = false
    ) {
        self.presentation = presentation
        self.sessions = sessions
        self.collapsedHidden = collapsedHidden
        primarySessionID = sessions.first?.id
        approval = nil
        approvalDecisionPending = false
        liveRevision = nil
        geometry = nil
    }
}
