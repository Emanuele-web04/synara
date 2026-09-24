// Beta icon generator v7 — square artwork (dock applies the mask), Apple-extracted colors.
// Colors sampled pixel-exact from the installed Xcode 26 icon: vertical #0FC3FD -> #186FFA.
import AppKit
import CoreGraphics
import Foundation

let D: CGFloat = 1024
let SS: CGFloat = 2
let PX = Int(D * SS)

struct Palette {
  let top: UInt32
  let upperMid: UInt32
  let lowerMid: UInt32
  let bottom: UInt32
  let mark: UInt32
}

// Light: exact Xcode 26 stop colors.
let light = Palette(top: 0x0DBDFB, upperMid: 0x1FA8FC, lowerMid: 0x1473E8, bottom: 0x1868F8, mark: 0xFFFFFF)

func cg(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

let markPaths: [String] = [
  "M2.65188 2.1899C-0.630695 5.47248 -0.995426 113.797 2.28715 121.821C3.74607 125.104 35.8423 149.906 74.5038 176.531C148.179 227.958 159.121 237.806 170.428 260.054L177.358 273.914L194.135 252.76C203.254 241.088 212.372 228.323 214.196 224.311C228.055 197.685 220.396 158.659 196.324 132.763C181.735 117.08 23.0768 4.37828 11.4054 1.09571C8.12283 0.366249 4.1108 0.73098 2.65188 2.1899Z",
  "M467.348 1.45943C470.631 4.74201 470.995 113.067 467.713 121.091C466.254 124.374 434.158 149.175 395.496 175.801C321.821 227.228 310.879 237.075 299.572 259.324L292.642 273.184L275.865 252.029C266.746 240.358 257.628 227.592 255.804 223.58C241.945 196.955 249.604 157.929 273.676 132.033C288.265 116.35 446.923 3.64782 458.595 0.365241C461.877 -0.36422 465.889 0.000510871 467.348 1.45943Z",
  "M217.479 291.602C187.396 324.802 187 326.002 187 420.002V494.002C187 499.525 191.477 504.002 197 504.002H234.5H272C277.523 504.002 282 499.525 282 494.002V418.002C282 351.202 280.812 329.602 276.458 322.002C269.729 310.002 239.25 274.002 236.083 274.002C234.5 274.002 226.187 282.002 217.479 291.602Z",
]

func parsePath(_ d: String) -> CGPath {
  let path = CGMutablePath()
  var nums: [CGFloat] = []
  var cmds: [(Character, [CGFloat])] = []
  var current = ""
  func flush() {
    if current.isEmpty { return }
    cmds.append((current.first!, nums))
    current = ""; nums = []
  }
  var token = ""
  func flushToken() {
    if !token.isEmpty { nums.append(CGFloat(Double(token) ?? 0)); token = "" }
  }
  for ch in d {
    if ch.isLetter { flushToken(); flush(); current = String(ch) }
    else if ch == "," || ch == " " { flushToken() }
    else { token.append(ch) }
  }
  flushToken(); flush()

  var last = CGPoint.zero
  var start = CGPoint.zero
  for (cmd, a) in cmds {
    switch cmd {
    case "M": last = CGPoint(x: a[0], y: a[1]); start = last; path.move(to: last)
    case "L": last = CGPoint(x: a[0], y: a[1]); path.addLine(to: last)
    case "H": last = CGPoint(x: a[0], y: last.y); path.addLine(to: last)
    case "V": last = CGPoint(x: last.x, y: a[0]); path.addLine(to: last)
    case "C":
      let c1 = CGPoint(x: a[0], y: a[1]); let c2 = CGPoint(x: a[2], y: a[3]); let to = CGPoint(x: a[4], y: a[5])
      path.addCurve(to: to, control1: c1, control2: c2); last = to
    case "Z": path.closeSubpath(); last = start
    default: break
    }
  }
  return path
}

let markPath: CGPath = {
  let p = CGMutablePath()
  for d in markPaths { p.addPath(parsePath(d)) }
  return p
}()

let markScale: CGFloat = 1.00
let markCenter = CGPoint(x: 235, y: 252)
func addMark(to ctx: CGContext) {
  var t = CGAffineTransform(translationX: 274 + markCenter.x * (1 - markScale), y: 280 + markCenter.y * (1 - markScale)).scaledBy(x: markScale, y: markScale)
  if let moved = markPath.copy(using: &t) { ctx.addPath(moved) }
}

func drawIcon(_ p: Palette, name: String) {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  guard let ctx = CGContext(data: nil, width: PX, height: PX, bitsPerComponent: 8, bytesPerRow: 0,
                            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { print("no ctx"); return }
  ctx.saveGState()
  ctx.translateBy(x: 0, y: CGFloat(PX))
  ctx.scaleBy(x: 1, y: -1)
  ctx.scaleBy(x: SS, y: SS)
  ctx.setShouldAntialias(true)
  ctx.clear(CGRect(x: 0, y: 0, width: D, height: D))

  // Inset rounded tile with transparent margin (macOS does not mask
  // third-party bundle art, so the margin is baked, prod geometry).
  ctx.addPath(CGPath(roundedRect: CGRect(x: 102, y: 102, width: 820, height: 820), cornerWidth: 193, cornerHeight: 193, transform: nil))
  ctx.clip()

  // Tile gradient, clipped to the inset tile by the caller.
  let stops = [cg(p.top), cg(p.upperMid), cg(p.lowerMid), cg(p.bottom)] as CFArray
  if let g = CGGradient(colorsSpace: cs, colors: [cg(p.top), cg(p.upperMid), cg(p.lowerMid), cg(p.bottom)] as CFArray, locations: [0, 0.35, 0.7, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: D), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }

  // Layered translucent depth bands (reference recipe): soft light masses under the linework.
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0xFFFFFF, 0.06), cg(0xFFFFFF, 0)] as CFArray, locations: [0, 1]) {
    ctx.drawRadialGradient(g, startCenter: CGPoint(x: 250, y: 300), startRadius: 0, endCenter: CGPoint(x: 250, y: 300), endRadius: 400, options: [])
  }
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0x7CC4FF, 0.16), cg(0x7CC4FF, 0)] as CFArray, locations: [0, 1]) {
    ctx.drawRadialGradient(g, startCenter: CGPoint(x: 210, y: 790), startRadius: 0, endCenter: CGPoint(x: 210, y: 790), endRadius: 470, options: [])
  }
  // Bottom-edge lift (Xcode brightens its last rows instead of crushing them).
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0x37C8FF, 0.26), cg(0x37C8FF, 0)] as CFArray, locations: [0, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: D), end: CGPoint(x: 0, y: D - 140), options: [])
  }

  // Blueprint shell: clean 5x5 grid (Xcode 26), guide circles and squircle inset (classic beta)
  ctx.setLineWidth(3)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.15))
  for step in 1...4 {
    let v = CGFloat(step) * D / 5
    ctx.move(to: CGPoint(x: v, y: 0)); ctx.addLine(to: CGPoint(x: v, y: D))
    ctx.move(to: CGPoint(x: 0, y: v)); ctx.addLine(to: CGPoint(x: D, y: v))
  }
  ctx.strokePath()

  // Concentric guide circles
  ctx.setLineWidth(3.2)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.22))
  ctx.strokeEllipse(in: CGRect(x: 512 - 385, y: 512 - 385, width: 770, height: 770))
  // Squircle inset guide
  ctx.setLineWidth(3)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.18))
  ctx.addPath(CGPath(roundedRect: CGRect(x: 72, y: 72, width: D - 144, height: D - 144), cornerWidth: 160, cornerHeight: 160, transform: nil))
  ctx.strokePath()

  // Depth layer 3: glass rim on the tile edge
  // Directional glass rim: light from top-left, fading clockwise into a deep base.
  ctx.setLineWidth(3)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.65))
  ctx.move(to: CGPoint(x: 0, y: 1.5)); ctx.addLine(to: CGPoint(x: D, y: 1.5)); ctx.strokePath()
  ctx.setStrokeColor(cg(0xFFFFFF, 0.32))
  ctx.move(to: CGPoint(x: 1.5, y: 0)); ctx.addLine(to: CGPoint(x: 1.5, y: D)); ctx.strokePath()
  ctx.setStrokeColor(cg(0xFFFFFF, 0.14))
  ctx.move(to: CGPoint(x: D - 1.5, y: 0)); ctx.addLine(to: CGPoint(x: D - 1.5, y: D)); ctx.strokePath()
  ctx.setStrokeColor(cg(0x06255C, 0.45))
  ctx.move(to: CGPoint(x: 0, y: D - 1.5)); ctx.addLine(to: CGPoint(x: D, y: D - 1.5)); ctx.strokePath()

  // Glass mark (App Store recipe): tight grounding shadow, icy vertical volume,
  // bright top catchlight. Reads white at dock size, glass up close.
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 8, height: -18), blur: 44, color: cg(0x021233, 0.33))
  addMark(to: ctx)
  ctx.clip()
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0xEFF7FF), cg(0xD5E9FF)] as CFArray, locations: [0, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 260), end: CGPoint(x: 0, y: 805), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0xFFFFFF, 1.0), cg(0xFFFFFF, 0)] as CFArray, locations: [0, 1]) {
    ctx.drawRadialGradient(g, startCenter: CGPoint(x: 400, y: 330), startRadius: 0, endCenter: CGPoint(x: 400, y: 330), endRadius: 480, options: [])
  }
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0xFFFFFF, 0.55), cg(0xFFFFFF, 0)] as CFArray, locations: [0, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 260), end: CGPoint(x: 0, y: 380), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }
  ctx.restoreGState()
  ctx.saveGState()
  addMark(to: ctx)
  ctx.clip()
  ctx.saveGState()
  ctx.clip(to: CGRect(x: 0, y: 0, width: D, height: 440))
  addMark(to: ctx)
  ctx.setStrokeColor(cg(0xFFFFFF, 1.0))
  ctx.setLineWidth(4)
  ctx.strokePath()
  ctx.restoreGState()
  addMark(to: ctx)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.70))
  ctx.setLineWidth(8)
  ctx.strokePath()
  ctx.restoreGState()

  ctx.restoreGState()

  guard let image = ctx.makeImage() else { print("no image"); return }
  let rep = NSBitmapImageRep(cgImage: image)
  let scaled = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(D), pixelsHigh: Int(D),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bitmapFormat: [], bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: scaled)
  let source = NSImage(size: NSSize(width: D, height: D))
  source.addRepresentation(rep)
  source.draw(in: NSRect(x: 0, y: 0, width: D, height: D), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  let png = scaled.representation(using: .png, properties: [:])!
  try! png.write(to: URL(fileURLWithPath: FileManager.default.currentDirectoryPath + "/\(name).png"))
  print("saved \(name).png")
}

drawIcon(light, name: "assets/beta/beta-macos-1024")
