import AppKit
import CoreGraphics
import Foundation
import QuartzCore

private let flashInDuration = 0.035
private let flashOutDuration = 0.17
private let flashPeakOpacity: CGFloat = 0.34

private func displayID(for screen: NSScreen) -> CGDirectDisplayID? {
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    return (screen.deviceDescription[key] as? NSNumber)?.uint32Value
}

private func appKitFrame(for windowBounds: CGRect) -> CGRect? {
    let screenMatch = NSScreen.screens.compactMap { screen -> (NSScreen, CGRect, CGFloat)? in
        guard let displayID = displayID(for: screen) else { return nil }
        let displayBounds = CGDisplayBounds(displayID)
        let intersection = displayBounds.intersection(windowBounds)
        let area = max(0, intersection.width) * max(0, intersection.height)
        return (screen, displayBounds, area)
    }.max { left, right in
        left.2 < right.2
    }

    guard let (screen, displayBounds, intersectionArea) = screenMatch,
          intersectionArea > 0,
          displayBounds.width > 0,
          displayBounds.height > 0
    else {
        return nil
    }

    let horizontalScale = screen.frame.width / displayBounds.width
    let verticalScale = screen.frame.height / displayBounds.height
    return CGRect(
        x: screen.frame.minX + (windowBounds.minX - displayBounds.minX) * horizontalScale,
        y: screen.frame.maxY - (windowBounds.maxY - displayBounds.minY) * verticalScale,
        width: windowBounds.width * horizontalScale,
        height: windowBounds.height * verticalScale
    )
}

final class AppSnapCaptureFeedback {
    private var flashPanel: NSPanel?

    // Visual flash only. The shutter sound is owned by the renderer, where the
    // user's capture-sound preference gates it; playing audio here too would
    // double the cue and ignore that setting.
    func play(for windowBounds: CGRect, completion: @escaping () -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
              let frame = appKitFrame(for: windowBounds)
        else {
            completion()
            return
        }

        flashPanel?.orderOut(nil)

        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .screenSaver
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.sharingType = .none
        panel.alphaValue = 0

        let flashView = NSView(frame: CGRect(origin: .zero, size: frame.size))
        flashView.wantsLayer = true
        flashView.layer?.backgroundColor = NSColor.white.cgColor
        flashView.layer?.cornerRadius = 10
        flashView.layer?.masksToBounds = true
        panel.contentView = flashView

        flashPanel = panel
        panel.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = flashInDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = flashPeakOpacity
        } completionHandler: { [weak self, weak panel] in
            guard let panel else {
                completion()
                return
            }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = flashOutDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeIn)
                panel.animator().alphaValue = 0
            } completionHandler: {
                panel.orderOut(nil)
                if self?.flashPanel === panel {
                    self?.flashPanel = nil
                }
                completion()
            }
        }
    }
}
