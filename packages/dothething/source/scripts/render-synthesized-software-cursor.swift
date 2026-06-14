#!/usr/bin/env swift

import AppKit
import CoreGraphics
import Foundation

enum CursorScriptError: LocalizedError {
    case invalidArguments(String)
    case bitmapUnavailable
    case pngEncodingFailed

    var errorDescription: String? {
        switch self {
        case let .invalidArguments(message):
            return message
        case .bitmapUnavailable:
            return "Unable to allocate bitmap context for snapshot rendering."
        case .pngEncodingFailed:
            return "Unable to encode snapshot as PNG."
        }
    }
}

struct ScriptOptions {
    var centerX: CGFloat?
    var centerY: CGFloat?
    var seconds: TimeInterval = 12
    var snapshotDelay: TimeInterval = 0.45
    var idleDrift = true
    var pulseLoop = true
    var useReferenceCapture = true
    var savePNGURL: URL?
}

enum CursorMetrics {
    static let windowSize = CGSize(width: 126, height: 126)
    static let fogDiameter: CGFloat = 66
    static let pointerSize = CGSize(width: 21, height: 21)
    static let pointerOffset = CGPoint(x: 2.6, y: -3.2)
}

let options = try parseOptions(arguments: Array(CommandLine.arguments.dropFirst()))

final class CursorWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class CursorView: NSView {
    private let options: ScriptOptions
    private let startedAt = CACurrentMediaTime()
    private var timer: Timer?
    private let referenceImage = loadReferenceCursorWindowImage()

    init(frame frameRect: NSRect, options: ScriptOptions) {
        self.options = options
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var acceptsFirstResponder: Bool {
        true
    }

    override var isOpaque: Bool {
        false
    }

    func startAnimating() {
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.needsDisplay = true
        }
    }

    func stopAnimating() {
        timer?.invalidate()
        timer = nil
    }

    override func keyDown(with event: NSEvent) {
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "q":
            NSApplication.shared.terminate(nil)
        default:
            if event.keyCode == 53 {
                NSApplication.shared.terminate(nil)
            } else {
                super.keyDown(with: event)
            }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        NSColor.clear.setFill()
        dirtyRect.fill()

        guard let context = NSGraphicsContext.current?.cgContext else {
            return
        }

        let elapsed = CACurrentMediaTime() - startedAt

        if options.useReferenceCapture, let referenceImage {
            drawReferenceImage(referenceImage, in: context, elapsed: elapsed)
            return
        }

        let pulse = pulseProgress(at: elapsed)
        let drift = idleOffset(at: elapsed)
        let fogCenter = CGPoint(
            x: bounds.midX + (drift.dx * 0.28),
            y: bounds.midY + (drift.dy * 0.24) - (pulse * 0.8)
        )
        let pointerCenter = CGPoint(
            x: bounds.midX + CursorMetrics.pointerOffset.x + drift.dx,
            y: bounds.midY + CursorMetrics.pointerOffset.y + drift.dy + (pulse * 0.35)
        )

        drawFog(in: context, center: fogCenter, pulse: pulse)
        drawPointer(in: context, center: pointerCenter, elapsed: elapsed, pulse: pulse)
    }

    private func drawReferenceImage(_ image: NSImage, in context: CGContext, elapsed: TimeInterval) {
        let idlePhase = CGFloat(elapsed * 3.0)
        let idleRotationAmplitude: CGFloat = .pi / 12
        let rotation = options.idleDrift
            ? sin(idlePhase * 0.8) * idleRotationAmplitude
            : 0

        context.saveGState()
        context.translateBy(x: bounds.midX, y: bounds.midY)
        context.rotate(by: rotation)
        context.translateBy(x: -bounds.midX, y: -bounds.midY)
        image.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
        context.restoreGState()
    }

    private func pulseProgress(at elapsed: TimeInterval) -> CGFloat {
        guard options.pulseLoop else {
            return 0
        }

        let cycleDuration = 1.65
        let activeDuration = 0.24
        let cycleTime = elapsed.truncatingRemainder(dividingBy: cycleDuration)
        guard cycleTime < activeDuration else {
            return 0
        }

        let normalized = cycleTime / activeDuration
        return CGFloat(sin(normalized * .pi))
    }

    private func idleOffset(at elapsed: TimeInterval) -> CGVector {
        guard options.idleDrift else {
            return .zero
        }

        return CGVector(
            dx: sin(elapsed * 1.35) * 1.6,
            dy: cos(elapsed * 0.92) * 1.15
        )
    }

    private func drawFog(in context: CGContext, center: CGPoint, pulse: CGFloat) {
        let radius = (CursorMetrics.fogDiameter / 2) + (pulse * 1.2)
        let glowRadius = radius * (0.30 + (pulse * 0.025))
        let colors = [
            NSColor(calibratedRed: 0.38, green: 0.36, blue: 0.35, alpha: 0.40 + (pulse * 0.02)).cgColor,
            NSColor(calibratedRed: 0.43, green: 0.41, blue: 0.40, alpha: 0.28 + (pulse * 0.015)).cgColor,
            NSColor(calibratedRed: 0.46, green: 0.44, blue: 0.43, alpha: 0.11).cgColor,
            NSColor(calibratedWhite: 0.60, alpha: 0.0).cgColor,
        ] as CFArray
        let locations: [CGFloat] = [0, 0.50, 0.82, 1]
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        guard let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: locations) else {
            return
        }

        context.saveGState()
        context.drawRadialGradient(
            gradient,
            startCenter: center,
            startRadius: 0,
            endCenter: center,
            endRadius: radius,
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
        context.restoreGState()

        let coreColors = [
            NSColor(calibratedRed: 0.41, green: 0.39, blue: 0.38, alpha: 0.020 + (pulse * 0.006)).cgColor,
            NSColor(calibratedRed: 0.44, green: 0.41, blue: 0.40, alpha: 0.008).cgColor,
            NSColor(calibratedWhite: 0.80, alpha: 0.0).cgColor,
        ] as CFArray
        let coreLocations: [CGFloat] = [0, 0.62, 1]
        guard let coreGradient = CGGradient(colorsSpace: colorSpace, colors: coreColors, locations: coreLocations) else {
            return
        }

        context.saveGState()
        context.drawRadialGradient(
            coreGradient,
            startCenter: center,
            startRadius: 0,
            endCenter: center,
            endRadius: glowRadius,
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
        context.restoreGState()

        let ringRect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        let ring = NSBezierPath(ovalIn: ringRect)
        NSColor.white.withAlphaComponent(0.003 + (pulse * 0.002)).setStroke()
        ring.lineWidth = 0.6
        ring.stroke()
    }

    private func drawPointer(in context: CGContext, center: CGPoint, elapsed: TimeInterval, pulse: CGFloat) {
        let wobble = options.idleDrift ? sin(elapsed * 1.45) * 0.03 : 0
        let pointerRect = CGRect(
            x: center.x - (CursorMetrics.pointerSize.width / 2),
            y: center.y - (CursorMetrics.pointerSize.height / 2),
            width: CursorMetrics.pointerSize.width,
            height: CursorMetrics.pointerSize.height
        )
        let outerPath = pointerPath(in: pointerRect)

        context.saveGState()
        context.translateBy(x: center.x, y: center.y)
        context.rotate(by: wobble + (pulse * 0.03))
        context.scaleBy(x: 1 - (pulse * 0.04), y: 1 + (pulse * 0.02))
        context.translateBy(x: -center.x, y: -center.y)

        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowBlurRadius = 3.2 + (pulse * 1.4)
        shadow.shadowOffset = CGSize(width: 0, height: -0.35)
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.11)
        shadow.set()
        NSColor.black.withAlphaComponent(0.05).setFill()
        outerPath.fill()
        NSGraphicsContext.restoreGraphicsState()

        NSColor(calibratedRed: 0.38, green: 0.36, blue: 0.35, alpha: 0.98).setFill()
        outerPath.fill()

        NSColor(calibratedWhite: 0.90, alpha: 0.92).setStroke()
        outerPath.lineWidth = 1.55
        outerPath.lineJoinStyle = .round
        outerPath.lineCapStyle = .round
        outerPath.stroke()

        context.restoreGState()
    }

    private func pointerPath(in rect: CGRect) -> NSBezierPath {
        let contourRows: [(y: CGFloat, minX: CGFloat, maxX: CGFloat)] = [
            (39, 17, 21),
            (38, 16, 22),
            (37, 15, 22),
            (36, 15, 23),
            (35, 15, 24),
            (34, 15, 24),
            (33, 14, 25),
            (32, 14, 25),
            (31, 14, 26),
            (30, 14, 27),
            (29, 13, 29),
            (28, 13, 31),
            (27, 13, 34),
            (26, 13, 36),
            (25, 13, 37),
            (24, 12, 37),
            (23, 12, 37),
            (22, 12, 37),
            (21, 12, 37),
            (20, 12, 36),
            (19, 11, 36),
            (18, 11, 34),
            (17, 11, 32),
            (16, 11, 30),
            (15, 10, 27),
            (14, 10, 25),
            (13, 10, 23),
            (12, 11, 21),
            (11, 11, 19),
            (10, 13, 16),
        ]
        let sourceMinX: CGFloat = 10
        let sourceMaxX: CGFloat = 38
        let sourceMinY: CGFloat = 10
        let sourceMaxY: CGFloat = 39

        func mappedPoint(x: CGFloat, y: CGFloat) -> CGPoint {
            CGPoint(
                x: rect.minX + ((x - sourceMinX) / (sourceMaxX - sourceMinX) * rect.width),
                y: rect.minY + ((y - sourceMinY) / (sourceMaxY - sourceMinY) * rect.height)
            )
        }

        let leftBoundary = contourRows.map { mappedPoint(x: $0.minX, y: $0.y) }
        let rightBoundary = contourRows.reversed().map { mappedPoint(x: $0.maxX, y: $0.y) }

        let path = NSBezierPath()
        path.move(to: leftBoundary[0])
        leftBoundary.dropFirst().forEach { path.line(to: $0) }
        rightBoundary.forEach { path.line(to: $0) }
        path.close()
        path.lineJoinStyle = .round
        return path
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let options: ScriptOptions
    private var window: CursorWindow?
    private var cursorView: CursorView?

    init(options: ScriptOptions) {
        self.options = options
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = resolvedWindowFrame()
        let window = CursorWindow(
            contentRect: frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.level = .statusBar
        window.ignoresMouseEvents = false
        window.isMovableByWindowBackground = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.title = "Synthesized Software Cursor"

        let cursorView = CursorView(
            frame: CGRect(origin: .zero, size: CursorMetrics.windowSize),
            options: options
        )
        window.contentView = cursorView
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(cursorView)
        cursorView.startAnimating()

        self.window = window
        self.cursorView = cursorView

        NSApp.activate(ignoringOtherApps: true)

        if let savePNGURL = options.savePNGURL {
            Timer.scheduledTimer(withTimeInterval: options.snapshotDelay, repeats: false) { [weak self] _ in
                guard let self, let cursorView = self.cursorView else {
                    return
                }

                do {
                    try saveSnapshot(of: cursorView, to: savePNGURL)
                    print("Saved snapshot to \(savePNGURL.path)")
                } catch {
                    fputs("Snapshot failed: \(error.localizedDescription)\n", stderr)
                }
            }
        }

        if options.seconds > 0 {
            Timer.scheduledTimer(withTimeInterval: options.seconds, repeats: false) { _ in
                NSApplication.shared.terminate(nil)
            }
        }

        print(startupMessage(frame: frame))
    }

    func applicationWillTerminate(_ notification: Notification) {
        cursorView?.stopAnimating()
    }

    private func resolvedWindowFrame() -> CGRect {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let visibleFrame = screen?.visibleFrame ?? CGRect(x: 200, y: 200, width: 900, height: 700)
        let centerX = options.centerX ?? visibleFrame.midX
        let centerY = options.centerY ?? visibleFrame.midY

        return CGRect(
            x: centerX - (CursorMetrics.windowSize.width / 2),
            y: centerY - (CursorMetrics.windowSize.height / 2),
            width: CursorMetrics.windowSize.width,
            height: CursorMetrics.windowSize.height
        )
    }

    private func startupMessage(frame: CGRect) -> String {
        let durationDescription = options.seconds > 0
            ? String(format: "%.1f seconds", options.seconds)
            : "until you press q or Esc"
        let snapshot = options.savePNGURL?.path ?? "disabled"

        return """
        Synthesized software cursor overlay running.
        Window frame: \(NSStringFromRect(frame))
        Auto-exit: \(durationDescription)
        Snapshot: \(snapshot)
        """
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let delegate = AppDelegate(options: options)
app.delegate = delegate
app.run()

func parseOptions(arguments: [String]) throws -> ScriptOptions {
    var options = ScriptOptions()
    var index = 0

    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--help", "-h":
            printUsage()
            Foundation.exit(EXIT_SUCCESS)
        case "--x":
            index += 1
            options.centerX = try parseCGFloat(arguments, index: index, flag: argument)
        case "--y":
            index += 1
            options.centerY = try parseCGFloat(arguments, index: index, flag: argument)
        case "--seconds":
            index += 1
            let rawValue = try parseString(arguments, index: index, flag: argument)
            guard let seconds = TimeInterval(rawValue), seconds >= 0 else {
                throw CursorScriptError.invalidArguments("Invalid value for --seconds: \(rawValue)")
            }
            options.seconds = seconds
        case "--snapshot-delay":
            index += 1
            let rawValue = try parseString(arguments, index: index, flag: argument)
            guard let snapshotDelay = TimeInterval(rawValue), snapshotDelay >= 0 else {
                throw CursorScriptError.invalidArguments("Invalid value for --snapshot-delay: \(rawValue)")
            }
            options.snapshotDelay = snapshotDelay
        case "--save-png":
            index += 1
            let path = try parseString(arguments, index: index, flag: argument)
            options.savePNGURL = URL(fileURLWithPath: path)
        case "--procedural":
            options.useReferenceCapture = false
        case "--no-idle":
            options.idleDrift = false
        case "--no-pulse":
            options.pulseLoop = false
        default:
            throw CursorScriptError.invalidArguments("Unknown argument: \(argument)")
        }

        index += 1
    }

    return options
}

func parseString(_ arguments: [String], index: Int, flag: String) throws -> String {
    guard arguments.indices.contains(index) else {
        throw CursorScriptError.invalidArguments("Missing value for \(flag)")
    }

    return arguments[index]
}

func parseCGFloat(_ arguments: [String], index: Int, flag: String) throws -> CGFloat {
    let rawValue = try parseString(arguments, index: index, flag: flag)
    guard let value = Double(rawValue) else {
        throw CursorScriptError.invalidArguments("Invalid value for \(flag): \(rawValue)")
    }

    return CGFloat(value)
}

func saveSnapshot(of view: NSView, to url: URL) throws {
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    let pixelWidth = Int(CursorMetrics.windowSize.width * scale)
    let pixelHeight = Int(CursorMetrics.windowSize.height * scale)

    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixelWidth,
        pixelsHigh: pixelHeight,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw CursorScriptError.bitmapUnavailable
    }

    bitmap.size = NSSize(width: pixelWidth, height: pixelHeight)
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw CursorScriptError.bitmapUnavailable
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: scale, y: scale)
    view.displayIgnoringOpacity(view.bounds, in: context)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
        throw CursorScriptError.pngEncodingFailed
    }

    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try pngData.write(to: url)
}

func printUsage() {
    let usage = """
    Usage:
      swift scripts/render-synthesized-software-cursor.swift [options]

    Options:
      --x <value>          Overlay center x position in screen coordinates
      --y <value>          Overlay center y position in screen coordinates
      --seconds <value>    Auto-exit after N seconds; use 0 to keep it open
      --snapshot-delay <value>
                           Delay before writing --save-png, useful for sampling wobble phases
      --save-png <path>    Save a 2x transparent PNG snapshot of the synthesized overlay
      --procedural         Render the current code-generated fallback instead of the captured official baseline
      --no-idle            Disable idle drift
      --no-pulse           Disable periodic click pulse
      --help               Show this message
    """

    print(usage)
}

func loadReferenceCursorWindowImage() -> NSImage? {
    let scriptURL = URL(fileURLWithPath: #filePath).standardizedFileURL
    let repoRoot = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
    let referenceURL = repoRoot
        .appendingPathComponent("docs/references/codex-computer-use-reverse-engineering/assets/extracted-2026-04-19/official-software-cursor-window-252.png")

    return NSImage(contentsOf: referenceURL)
}
