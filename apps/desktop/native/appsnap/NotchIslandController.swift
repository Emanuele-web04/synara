import AppKit
import CoreGraphics
import SwiftUI

/// Owns the island panel for the `--island` mode: picks the display, keeps the
/// panel on the notch (or the top-center pill) through display, Space and
/// sleep changes, opens on hover, and reports clicks to the host.
@available(macOS 13.0, *)
@MainActor
final class NotchIslandController {
    private static let openDelay: TimeInterval = 0.08
    private static let closeDelay: TimeInterval = 0.3
    private static let relayoutDelay: TimeInterval = 0.5
    private static let expandedPollInterval: TimeInterval = 0.25

    private let emitter: NDJSONEmitter
    private let model = NotchIslandModel()
    private var panel: NotchIslandPanel?
    private var hostingView: NotchIslandHostingView<NotchIslandView>?
    private var placement: NotchIslandPlacement?
    private var placementDisplayID: CGDirectDisplayID?
    private var notificationTokens: [(NotificationCenter, NSObjectProtocol)] = []
    private var eventMonitors: [Any] = []
    private var expandedPoll: Timer?
    private var openWork: DispatchWorkItem?
    private var closeWork: DispatchWorkItem?
    private var relayoutWork: DispatchWorkItem?
    private var lastPlacementEvent: [String: Any]?

    init(emitter: NDJSONEmitter) {
        self.emitter = emitter
        model.onOpenThread = { [weak self] threadId in
            self?.emitter.emit(["type": "island-open-thread", "threadId": threadId])
            self?.collapse()
        }
        model.onOpenApp = { [weak self] in
            self?.emitter.emit(["type": "island-open-app"])
            self?.collapse()
        }
    }

    func start() {
        model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        observe(NotificationCenter.default, NSApplication.didChangeScreenParametersNotification) { controller in
            controller.scheduleRelayout()
        }
        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.didWakeNotification) { controller in
            controller.scheduleRelayout()
        }
        observe(workspace, NSWorkspace.activeSpaceDidChangeNotification) { controller in
            controller.refreshSuppression()
            // The new Space's windows settle a beat after the notification.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak controller] in
                controller?.refreshSuppression()
            }
        }
        observe(workspace, NSWorkspace.didActivateApplicationNotification) { controller in
            controller.refreshSuppression()
        }
        observe(workspace, NSWorkspace.accessibilityDisplayOptionsDidChangeNotification) { controller in
            controller.model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        }

        // Pointer position only; global mouse monitors need no permission.
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.pointerMoved() }
        }) {
            eventMonitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.pointerMoved() }
            return event
        }) {
            eventMonitors.append(local)
        }

        relayout()
    }

    func stop() {
        openWork?.cancel()
        closeWork?.cancel()
        relayoutWork?.cancel()
        expandedPoll?.invalidate()
        expandedPoll = nil
        eventMonitors.forEach(NSEvent.removeMonitor)
        eventMonitors.removeAll()
        for (center, token) in notificationTokens {
            center.removeObserver(token)
        }
        notificationTokens.removeAll()
        panel?.orderOut(nil)
    }

    func apply(snapshot: NotchIslandSnapshot) {
        guard snapshot != model.snapshot else { return }
        model.snapshot = snapshot
        refreshInteraction()
    }

    func apply(labels: NotchIslandLabels) {
        model.labels = labels
    }

    /// Provider glyphs arrive as the app's own SVG markup. macOS draws SVG data
    /// natively; where it cannot, the row falls back to a plain dot.
    func apply(iconMarkup: [String: String]) {
        var icons = model.icons
        for (provider, markup) in iconMarkup {
            icons[provider] = NSImage(data: Data(markup.utf8))
        }
        model.icons = icons
    }

    // MARK: - Placement

    private func observe(
        _ center: NotificationCenter,
        _ name: Notification.Name,
        _ handler: @escaping @MainActor (NotchIslandController) -> Void
    ) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                handler(self)
            }
        }
        notificationTokens.append((center, token))
    }

    private func scheduleRelayout() {
        relayoutWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.relayout() }
        }
        relayoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.relayoutDelay, execute: work)
    }

    private func relayout() {
        let screens = NSScreen.screens
        guard let placement = NotchIslandGeometry.placement(for: screens.map(Self.metrics(for:))) else {
            self.placement = nil
            placementDisplayID = nil
            panel?.orderOut(nil)
            return
        }
        self.placement = placement
        placementDisplayID = Self.displayID(for: screens[placement.screenIndex])
        model.placementKind = placement.kind
        model.notchSize = placement.notch.size

        let frame = NotchIslandGeometry.panelFrame(for: placement)
        let panel = ensurePanel(frame: frame)
        if panel.frame != frame {
            panel.setFrame(frame, display: true)
        }
        panel.orderFrontRegardless()
        refreshSuppression()
        refreshInteraction()

        let event: [String: Any] = [
            "type": "island-placement",
            "kind": placement.kind.rawValue,
            "notchWidth": Double(placement.notch.width),
            "notchHeight": Double(placement.notch.height),
        ]
        if let last = lastPlacementEvent, NSDictionary(dictionary: last).isEqual(to: event) { return }
        lastPlacementEvent = event
        emitter.emit(event)
    }

    private func ensurePanel(frame: CGRect) -> NotchIslandPanel {
        if let panel { return panel }
        let panel = NotchIslandPanel(frame: frame)
        let hostingView = NotchIslandHostingView(rootView: NotchIslandView(model: model))
        hostingView.frame = CGRect(origin: .zero, size: frame.size)
        hostingView.autoresizingMask = [.width, .height]
        panel.contentView = hostingView
        self.panel = panel
        self.hostingView = hostingView
        return panel
    }

    /// A pill would cover a fullscreen app's content, so it steps aside while
    /// one fills its display. The notch never needs to: fullscreen apps stop
    /// below the camera housing.
    private func refreshSuppression() {
        guard let placement, placement.kind == .pill, let displayID = placementDisplayID else {
            setSuppressed(false)
            return
        }
        let displayBounds = CGDisplayBounds(displayID)
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        let covered = windows.contains { window in
            guard (window[kCGWindowLayer as String] as? Int) == 0,
                  (window[kCGWindowOwnerPID as String] as? pid_t) != ownPID,
                  let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
            else { return false }
            return NotchIslandGeometry.coversDisplay(windowBounds: bounds, displayBounds: displayBounds)
        }
        setSuppressed(covered)
    }

    private func setSuppressed(_ suppressed: Bool) {
        guard model.isSuppressed != suppressed else { return }
        model.isSuppressed = suppressed
        if suppressed { collapse() }
        refreshInteraction()
    }

    // MARK: - Pointer

    private var islandScreenRect: CGRect {
        guard let panel else { return .null }
        let size = model.islandSize
        return CGRect(
            x: panel.frame.midX - size.width / 2,
            y: panel.frame.maxY - size.height,
            width: size.width,
            height: size.height
        )
    }

    private func pointerMoved() {
        guard panel?.isVisible == true else { return }
        let point = NSEvent.mouseLocation
        let zone = NotchIslandGeometry.hoverZone(presence: model.presence, island: islandScreenRect)
        if zone.contains(point) {
            closeWork?.cancel()
            closeWork = nil
            if !model.isExpanded, openWork == nil {
                let work = DispatchWorkItem { [weak self] in
                    MainActor.assumeIsolated { self?.expand() }
                }
                openWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.openDelay, execute: work)
            }
        } else {
            openWork?.cancel()
            openWork = nil
            if model.isExpanded, closeWork == nil {
                let work = DispatchWorkItem { [weak self] in
                    MainActor.assumeIsolated { self?.collapse() }
                }
                closeWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.closeDelay, execute: work)
            }
        }
        routePointer(at: point)
    }

    private func expand() {
        openWork = nil
        // Re-check: the pointer may have left, or the island hidden, meanwhile.
        let zone = NotchIslandGeometry.hoverZone(presence: model.presence, island: islandScreenRect)
        guard !model.isSuppressed, zone.contains(NSEvent.mouseLocation) else { return }
        model.isExpanded = true
        refreshInteraction()
        // Pointer events stop when it rests; poll so a quick exit still closes.
        expandedPoll?.invalidate()
        let timer = Timer(timeInterval: Self.expandedPollInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pointerMoved() }
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        expandedPoll = timer
    }

    private func collapse() {
        openWork?.cancel()
        openWork = nil
        closeWork = nil
        expandedPoll?.invalidate()
        expandedPoll = nil
        guard model.isExpanded else { return }
        model.isExpanded = false
        refreshInteraction()
    }

    /// Keeps the hit area on the island's current shape, and the panel
    /// click-through unless the pointer is on it.
    private func refreshInteraction() {
        guard let hostingView else { return }
        let size = model.islandSize
        let bounds = hostingView.bounds
        let originY = hostingView.isFlipped ? 0 : bounds.height - size.height
        hostingView.interactiveRect = model.presence == .hidden
            ? .zero
            : CGRect(x: (bounds.width - size.width) / 2, y: originY, width: size.width, height: size.height)
        routePointer(at: NSEvent.mouseLocation)
    }

    private func routePointer(at point: CGPoint) {
        guard let panel else { return }
        let takesPointer = model.presence != .hidden && islandScreenRect.contains(point)
        if panel.ignoresMouseEvents == takesPointer {
            panel.ignoresMouseEvents = !takesPointer
        }
    }

    // MARK: - Screens

    private static func displayID(for screen: NSScreen) -> CGDirectDisplayID? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    private static func metrics(for screen: NSScreen) -> NotchIslandScreenMetrics {
        NotchIslandScreenMetrics(
            frame: screen.frame,
            visibleFrame: screen.visibleFrame,
            safeAreaTop: screen.safeAreaInsets.top,
            auxiliaryTopLeftWidth: screen.auxiliaryTopLeftArea?.width,
            auxiliaryTopRightWidth: screen.auxiliaryTopRightArea?.width,
            isBuiltIn: displayID(for: screen).map { CGDisplayIsBuiltin($0) != 0 } ?? false,
            statusBarThickness: NSStatusBar.system.thickness
        )
    }
}
