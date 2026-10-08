// brief-icon: today's painting, cropped square, with the Meridian mark on top.
//
//   brief-icon <painting.jpg> <outdir>
//
// Writes icon-32.png (tab favicon), icon-180.png (apple-touch-icon, full bleed),
// icon-192.png and icon-512.png (macOS-grid app icons), thumb.jpg (the crop, for
// the SVG favicon), and prints its decisions as JSON on stdout. Compiled by
// brief-icon.js on first use; no dependencies beyond CoreGraphics and ImageIO.
import CoreGraphics
import Foundation
import ImageIO

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
let yellow = (r: 246.0 / 255, g: 201.0 / 255, b: 58.0 / 255) // the command centre's accent, #f6c93a
let ink = (r: 20.0 / 255, g: 20.0 / 255, b: 22.0 / 255) // the brief's ink, #141416, softer than black on paint

// Rowan geometry, in the mark's own 24-unit box (y down), as in the SVG.
let ringR = 8.4, lineTop = 3.6, lineBottom = 20.4, dotY = 4.4, dotR = 2.0
// Large icons keep the original 1.7 stroke. The favicon gets a heavier optical
// stroke and a slightly bigger mark so it survives 16 px.
struct MarkSize { let box: Double; let stroke: Double }
let large = MarkSize(box: 0.72, stroke: 1.7)
let small = MarkSize(box: 0.80, stroke: 2.4)
// Contrast scrim: strongest at the centre, gone by 62% of the side.
let scrimInner = 0.12, scrimOuter = 0.62, scrimMax = 0.46

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func bitmap(_ w: Int, _ h: Int, opaque: Bool = false) -> CGContext {
  let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: srgb, bitmapInfo: info)
  else { fail("could not create a bitmap") }
  ctx.interpolationQuality = .high
  return ctx
}

// Halve first, then one final draw, so a 1400 px painting stays clean at 32 px.
func resized(_ image: CGImage, _ w: Int, _ h: Int) -> CGImage {
  var current = image
  while current.width / 2 >= w * 2 && current.height / 2 >= h * 2 {
    let ctx = bitmap(current.width / 2, current.height / 2, opaque: true)
    ctx.draw(current, in: CGRect(x: 0, y: 0, width: ctx.width, height: ctx.height))
    current = ctx.makeImage()!
  }
  if current.width == w && current.height == h { return current }
  let ctx = bitmap(w, h, opaque: true)
  ctx.draw(current, in: CGRect(x: 0, y: 0, width: w, height: h))
  return ctx.makeImage()!
}

struct Pixels {
  let w: Int, h: Int
  var r: [Double], g: [Double], b: [Double]
  func index(_ x: Int, _ y: Int) -> Int { y * w + x }
}

// Row 0 is the top of the image, as in the bitmap's memory.
func pixels(_ image: CGImage, _ w: Int, _ h: Int) -> Pixels {
  let ctx = bitmap(w, h, opaque: true)
  ctx.draw(resized(image, w, h), in: CGRect(x: 0, y: 0, width: w, height: h))
  let data = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)
  var p = Pixels(w: w, h: h, r: [], g: [], b: [])
  p.r.reserveCapacity(w * h); p.g.reserveCapacity(w * h); p.b.reserveCapacity(w * h)
  for i in 0..<(w * h) {
    p.r.append(Double(data[i * 4]) / 255)
    p.g.append(Double(data[i * 4 + 1]) / 255)
    p.b.append(Double(data[i * 4 + 2]) / 255)
  }
  return p
}

func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
func luminance(_ r: Double, _ g: Double, _ b: Double) -> Double { 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) }
func contrast(_ a: Double, _ b: Double) -> Double { (max(a, b) + 0.05) / (min(a, b) + 0.05) }
func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double { let t = min(1, max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
func scrimWeight(_ r: Double) -> Double { 1 - smoothstep(scrimInner, scrimOuter, r) }
func percentile(_ values: [Double], _ q: Double) -> Double {
  if values.isEmpty { return 0 }
  let sorted = values.sorted()
  return sorted[min(sorted.count - 1, max(0, Int((Double(sorted.count - 1) * q).rounded())))]
}
func hex(_ r: Double, _ g: Double, _ b: Double) -> String {
  String(format: "#%02x%02x%02x", Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
}

// ---------------------------------------------------------------- load

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: brief-icon <painting.jpg> <outdir>") }
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let painting = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1400,
      ] as CFDictionary)
else { fail("could not read the painting") }
let W = painting.width, H = painting.height

// ---------------------------------------------------------------- crop

// Pick the square with the most going on (edges plus colour), with a gentle
// pull towards the centre so it rarely strays from the composition.
let longSide = 128
let aw = W >= H ? longSide : max(16, Int((Double(longSide) * Double(W) / Double(H)).rounded()))
let ah = H >= W ? longSide : max(16, Int((Double(longSide) * Double(H) / Double(W)).rounded()))
let overview = pixels(painting, aw, ah)
var luma = [Double](repeating: 0, count: aw * ah), chroma = luma, edges = luma
var meanR = 0.0, meanG = 0.0, meanB = 0.0
for i in 0..<(aw * ah) {
  let r = overview.r[i], g = overview.g[i], b = overview.b[i]
  luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
  chroma[i] = max(r, g, b) - min(r, g, b)
  meanR += r; meanG += g; meanB += b
}
let count = Double(aw * ah)
meanR /= count; meanG /= count; meanB /= count
for y in 1..<(ah - 1) {
  for x in 1..<(aw - 1) {
    let l = { (dx: Int, dy: Int) in luma[(y + dy) * aw + x + dx] }
    let gx = l(1, -1) + 2 * l(1, 0) + l(1, 1) - l(-1, -1) - 2 * l(-1, 0) - l(-1, 1)
    let gy = l(-1, 1) + 2 * l(0, 1) + l(1, 1) - l(-1, -1) - 2 * l(0, -1) - l(1, -1)
    edges[y * aw + x] = (gx * gx + gy * gy).squareRoot()
  }
}
let edgeScale = max(percentile(edges, 0.95), 1e-3), chromaScale = max(percentile(chroma, 0.95), 1e-3)
var integral = [Double](repeating: 0, count: (aw + 1) * (ah + 1))
for y in 0..<ah {
  var row = 0.0
  for x in 0..<aw {
    row += min(1, 0.65 * edges[y * aw + x] / edgeScale + 0.35 * chroma[y * aw + x] / chromaScale)
    integral[(y + 1) * (aw + 1) + x + 1] = integral[y * (aw + 1) + x + 1] + row
  }
}
let windowSide = max(8, Int((0.9 * Double(min(aw, ah))).rounded()))
var best = (x: (aw - windowSide) / 2, y: (ah - windowSide) / 2, score: -1.0)
for y in 0...(ah - windowSide) {
  for x in 0...(aw - windowSide) {
    let s = windowSide
    let sum = integral[(y + s) * (aw + 1) + x + s] - integral[y * (aw + 1) + x + s] - integral[(y + s) * (aw + 1) + x] + integral[y * (aw + 1) + x]
    let dx = (Double(x) + Double(s) / 2 - Double(aw) / 2) / (Double(aw) / 2)
    let dy = (Double(y) + Double(s) / 2 - Double(ah) / 2) / (Double(ah) / 2)
    let score = sum / Double(s * s) * (1 - 0.6 * (dx * dx + dy * dy))
    if score > best.score { best = (x, y, score) }
  }
}
let scale = Double(W) / Double(aw)
let side = min(min(W, H), Int((Double(windowSide) * scale).rounded()))
let cropX = min(W - side, max(0, Int((Double(best.x) * scale).rounded())))
let cropY = min(H - side, max(0, Int((Double(best.y) * Double(H) / Double(ah)).rounded())))
guard let crop = painting.cropping(to: CGRect(x: cropX, y: cropY, width: side, height: side)) else { fail("could not crop") }

// ---------------------------------------------------------------- mark contrast

// Judge the pixels right around the strokes (what the mark is read against),
// then add only as much scrim as it takes to reach 3:1 for most of them.
let n = 128
let detail = pixels(crop, n, n)
struct Sample { let r: Double, g: Double, b: Double, weight: Double }
func strokeDistance(_ x: Double, _ y: Double, _ m: MarkSize) -> (stroke: Double, dot: Double) {
  let u = m.box / 24, o = (1 - m.box) / 2
  let ring = abs(hypot(x - 0.5, y - 0.5) - ringR * u)
  let y0 = o + lineTop * u, y1 = o + lineBottom * u
  let line = y < y0 ? hypot(x - 0.5, y - y0) : y > y1 ? hypot(x - 0.5, y - y1) : abs(x - 0.5)
  return (min(ring, line), hypot(x - 0.5, y - (o + dotY * u)))
}
var halo: [Sample] = [], dotHalo: [Sample] = []
for y in 0..<n {
  for x in 0..<n {
    let fx = (Double(x) + 0.5) / Double(n), fy = (Double(y) + 0.5) / Double(n)
    let i = detail.index(x, y)
    let d = strokeDistance(fx, fy, large)
    let half = large.stroke * large.box / 24 / 2
    let u = large.box / 24
    let sample = Sample(r: detail.r[i], g: detail.g[i], b: detail.b[i], weight: scrimWeight(hypot(fx - 0.5, fy - 0.5)))
    if d.dot <= dotR * u { continue }
    if d.stroke > half && d.stroke <= half + 0.05 { halo.append(sample) }
    if d.dot <= dotR * u + 0.04 && d.stroke > half { dotHalo.append(sample) }
  }
}
func scrimmed(_ s: Sample, white: Bool, _ a: Double) -> (Double, Double, Double) {
  let k = a * s.weight
  return white ? (s.r * (1 - k), s.g * (1 - k), s.b * (1 - k)) : (s.r + k * (1 - s.r), s.g + k * (1 - s.g), s.b + k * (1 - s.b))
}
let inkY = luminance(ink.r, ink.g, ink.b)
func contrasts(white: Bool, scrim a: Double) -> [Double] {
  halo.map { s in let c = scrimmed(s, white: white, a); return contrast(white ? 1 : inkY, luminance(c.0, c.1, c.2)) }
}
func legibility(_ c: [Double]) -> Double { 0.5 * (c.map { min($0, 8) }.reduce(0, +) / Double(max(1, c.count))) + 0.5 * percentile(c, 0.1) }
// A white mark is the house style (the command centre tile), so it wins ties.
let whiteScore = legibility(contrasts(white: true, scrim: 0)) * 1.08
let blackScore = legibility(contrasts(white: false, scrim: 0))
let white = whiteScore >= blackScore
var scrim = 0.0
while scrim < scrimMax && percentile(contrasts(white: white, scrim: scrim), 0.1) < 3 { scrim += 0.02 }
scrim = min(scrimMax, (scrim * 100).rounded() / 100)
let finalContrast = contrasts(white: white, scrim: scrim)

// The yellow dot only when it reads: on a white mark, against a dark enough,
// not-already-yellow patch.
let yellowY = luminance(yellow.r, yellow.g, yellow.b)
var yellowDot = false
if white {
  let around = dotHalo.map { s -> (y: Double, yellowish: Bool) in
    let c = scrimmed(s, white: true, scrim)
    let mx = max(c.0, c.1, c.2), mn = min(c.0, c.1, c.2)
    var hue = 0.0
    if mx - mn > 1e-6 {
      if mx == c.0 { hue = 60 * (((c.1 - c.2) / (mx - mn)).truncatingRemainder(dividingBy: 6)) }
      else if mx == c.1 { hue = 60 * ((c.2 - c.0) / (mx - mn) + 2) }
      else { hue = 60 * ((c.0 - c.1) / (mx - mn) + 4) }
    }
    if hue < 0 { hue += 360 }
    return (luminance(c.0, c.1, c.2), mx - mn > 0.22 && hue >= 28 && hue <= 68 && mx > 0.45)
  }
  let dotContrast = percentile(around.map { contrast(yellowY, $0.y) }, 0.2)
  let yellowish = Double(around.filter { $0.yellowish }.count) / Double(max(1, around.count))
  yellowDot = dotContrast >= 1.9 && yellowish < 0.3
}
let markHex = white ? "#ffffff" : hex(ink.r, ink.g, ink.b)
let dotHex = yellowDot ? hex(yellow.r, yellow.g, yellow.b) : markHex

// ---------------------------------------------------------------- render

enum Shape { case square, rounded, macGrid }

// Continuous-corner rounded square (superellipse), close to Apple's icon shape.
func squircle(_ rect: CGRect) -> CGPath {
  let path = CGMutablePath(), steps = 256, e = 2.0 / 5.0
  for i in 0..<steps {
    let t = Double(i) / Double(steps) * 2 * Double.pi
    let c = cos(t), s = sin(t)
    let x = rect.midX + rect.width / 2 * (c < 0 ? -1 : 1) * pow(abs(c), e)
    let y = rect.midY + rect.height / 2 * (s < 0 ? -1 : 1) * pow(abs(s), e)
    if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
  }
  path.closeSubpath()
  return path
}

func render(size: Int, shape: Shape, mark: MarkSize, shadow: Bool) -> CGImage {
  let S = Double(size)
  let ctx = bitmap(size, size, opaque: shape == .square)
  let body = shape == .macGrid ? CGRect(x: S * 100 / 1024, y: S * 100 / 1024, width: S * 824 / 1024, height: S * 824 / 1024)
                               : CGRect(x: 0, y: 0, width: S, height: S)
  let outline = shape == .square ? CGPath(rect: body, transform: nil) : squircle(body)
  if shape == .macGrid {
    // Apple's grid: 824 of 1024, with a soft drop shadow below.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -S * 10 / 1024), blur: S * 20 / 1024, color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.3))
    ctx.addPath(outline); ctx.setFillColor(CGColor(srgbRed: meanR, green: meanG, blue: meanB, alpha: 1)); ctx.fillPath()
    ctx.restoreGState()
  }
  ctx.saveGState()
  ctx.addPath(outline); ctx.clip()
  let px = Int(body.width.rounded())
  ctx.draw(resized(crop, px, px), in: body)
  if scrim > 0 {
    let tone: CGFloat = white ? 0 : 1
    let stops = stride(from: 0.0, through: 1.0, by: 0.125).map { $0 }
    let colors = stops.map { CGColor(srgbRed: tone, green: tone, blue: tone, alpha: scrim * scrimWeight($0 * scrimOuter)) } as CFArray
    let gradient = CGGradient(colorsSpace: srgb, colors: colors, locations: stops.map { CGFloat($0) })!
    let centre = CGPoint(x: body.midX, y: body.midY)
    ctx.drawRadialGradient(gradient, startCenter: centre, startRadius: 0, endCenter: centre, endRadius: body.width * scrimOuter, options: [])
  }
  // The mark, in its own 24-unit box with y running down, as in the SVG.
  let unit = body.width * mark.box / 24
  ctx.translateBy(x: body.minX + body.width * (1 - mark.box) / 2, y: body.maxY - body.width * (1 - mark.box) / 2)
  ctx.scaleBy(x: unit, y: -unit)
  if shadow && white {
    ctx.setShadow(offset: CGSize(width: 0, height: -S * 0.004), blur: S * 0.022, color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.24))
  }
  ctx.beginTransparencyLayer(auxiliaryInfo: nil)
  let markColor = white ? CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1) : CGColor(srgbRed: ink.r, green: ink.g, blue: ink.b, alpha: 1)
  ctx.setStrokeColor(markColor)
  ctx.setLineWidth(mark.stroke)
  ctx.addEllipse(in: CGRect(x: 12 - ringR, y: 12 - ringR, width: ringR * 2, height: ringR * 2))
  ctx.move(to: CGPoint(x: 12, y: lineTop)); ctx.addLine(to: CGPoint(x: 12, y: lineBottom))
  ctx.strokePath()
  ctx.setFillColor(yellowDot ? CGColor(srgbRed: yellow.r, green: yellow.g, blue: yellow.b, alpha: 1) : markColor)
  ctx.fillEllipse(in: CGRect(x: 12 - dotR, y: dotY - dotR, width: dotR * 2, height: dotR * 2))
  ctx.endTransparencyLayer()
  ctx.restoreGState()
  return ctx.makeImage()!
}

func write(_ image: CGImage, _ name: String, type: String, quality: Double? = nil) {
  let url = outDir.appendingPathComponent(name)
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil) else { fail("could not write \(name)") }
  let options = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
  CGImageDestinationAddImage(dest, image, options)
  guard CGImageDestinationFinalize(dest) else { fail("could not write \(name)") }
}

try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
write(render(size: 32, shape: .rounded, mark: small, shadow: false), "icon-32.png", type: "public.png")
write(render(size: 180, shape: .square, mark: large, shadow: true), "icon-180.png", type: "public.png") // iOS rounds it
write(render(size: 192, shape: .macGrid, mark: large, shadow: true), "icon-192.png", type: "public.png")
write(render(size: 512, shape: .macGrid, mark: large, shadow: true), "icon-512.png", type: "public.png")
write(resized(crop, 128, 128), "thumb.jpg", type: "public.jpeg", quality: 0.8)

let report: [String: Any] = [
  "version": 1,
  "source": ["width": W, "height": H],
  "crop": ["x": Double(cropX) / Double(W), "y": Double(cropY) / Double(H), "side": Double(side) / Double(min(W, H))],
  "mark": white ? "white" : "black",
  "markColor": markHex,
  "dotColor": dotHex,
  "scrim": scrim,
  "scrimColor": white ? "#000000" : "#ffffff",
  "contrast": ["white": whiteScore / 1.08, "black": blackScore, "p10": percentile(finalContrast, 0.1), "median": percentile(finalContrast, 0.5)],
  "average": hex(meanR, meanG, meanB),
  "geometry": ["scrimInner": scrimInner, "scrimOuter": scrimOuter, "small": ["box": small.box, "stroke": small.stroke], "large": ["box": large.box, "stroke": large.stroke]],
]
let json = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write(Data("\n".utf8))
