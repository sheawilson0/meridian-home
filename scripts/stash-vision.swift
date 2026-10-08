// Stash's eyes. One image in, one JSON line out: size, a JPEG thumbnail,
// the main colours, Apple Vision text (OCR), labels and a visual fingerprint
// for "same vibe". Everything runs on this Mac. Compiled by stash.js on first use.
//
//   stash-vision <image> <thumb.jpg>
import Foundation
import Vision
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

struct Swatch: Encodable { let hex: String; let weight: Double }
struct Label: Encodable { let id: String; let c: Double }
struct Out: Encodable {
    var ok = true
    var w = 0, h = 0
    var thumb = false
    var palette: [Swatch] = []
    var text = ""
    var labels: [Label] = []
    var featurePrint: String? = nil
    var error: String? = nil
}

func emit(_ o: Out) {
    let enc = JSONEncoder()
    if let d = try? enc.encode(o) { FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data([0x0A])) }
}

let args = CommandLine.arguments
guard args.count >= 3 else { var o = Out(); o.ok = false; o.error = "usage: stash-vision <image> <thumb.jpg>"; emit(o); exit(2) }
let input = URL(fileURLWithPath: args[1]), thumbURL = URL(fileURLWithPath: args[2])
var out = Out()

guard let src = CGImageSourceCreateWithURL(input as CFURL, nil), CGImageSourceGetCount(src) > 0 else {
    out.ok = false; out.error = "not an image"; emit(out); exit(1)
}
if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] {
    let pw = props[kCGImagePropertyPixelWidth] as? Int ?? 0, ph = props[kCGImagePropertyPixelHeight] as? Int ?? 0
    let orient = props[kCGImagePropertyOrientation] as? Int ?? 1
    (out.w, out.h) = orient >= 5 ? (ph, pw) : (pw, ph)       // 5–8 are rotated a quarter turn
}

func thumbnail(_ max: Int) -> CGImage? {
    CGImageSourceCreateThumbnailAtIndex(src, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max,
    ] as CFDictionary)
}

// Thumbnail: 900 px on the long side is plenty for a two-up grid on a Retina screen.
if let t = thumbnail(900), let dest = CGImageDestinationCreateWithURL(thumbURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) {
    // JPEG has no alpha: flatten transparent screenshots onto the page colour, not black.
    let w = t.width, h = t.height
    if let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                           bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
        ctx.setFillColor(CGColor(srgbRed: 0.11, green: 0.11, blue: 0.118, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(t, in: CGRect(x: 0, y: 0, width: w, height: h))
        if let flat = ctx.makeImage() {
            CGImageDestinationAddImage(dest, flat, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
            out.thumb = CGImageDestinationFinalize(dest)
        }
    }
}

// Palette: 64 px copy, 4 bits per channel buckets, then merge near neighbours.
if let small = thumbnail(64) {
    let w = small.width, h = small.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    if let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                           bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
        ctx.draw(small, in: CGRect(x: 0, y: 0, width: w, height: h))
        var bins: [Int: (n: Int, r: Int, g: Int, b: Int)] = [:]
        var total = 0
        for i in stride(from: 0, to: px.count, by: 4) where px[i + 3] > 200 {
            let r = Int(px[i]), g = Int(px[i + 1]), b = Int(px[i + 2])
            let k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
            let e = bins[k] ?? (0, 0, 0, 0)
            bins[k] = (e.n + 1, e.r + r, e.g + g, e.b + b)
            total += 1
        }
        var picked: [(n: Int, r: Double, g: Double, b: Double)] = []
        for (_, v) in bins.sorted(by: { $0.value.n > $1.value.n }) {
            let c = (r: Double(v.r) / Double(v.n), g: Double(v.g) / Double(v.n), b: Double(v.b) / Double(v.n))
            if let j = picked.firstIndex(where: { p in
                let dr = p.r - c.r, dg = p.g - c.g, db = p.b - c.b
                return (dr * dr + dg * dg + db * db).squareRoot() < 48
            }) {
                let p = picked[j], n = p.n + v.n
                picked[j] = (n, (p.r * Double(p.n) + c.r * Double(v.n)) / Double(n), (p.g * Double(p.n) + c.g * Double(v.n)) / Double(n), (p.b * Double(p.n) + c.b * Double(v.n)) / Double(n))
            } else if picked.count < 12 {
                picked.append((v.n, c.r, c.g, c.b))
            }
        }
        out.palette = picked.sorted { $0.n > $1.n }.prefix(6).filter { total > 0 && Double($0.n) / Double(total) >= 0.02 }.map {
            Swatch(hex: String(format: "#%02x%02x%02x", Int($0.r.rounded()), Int($0.g.rounded()), Int($0.b.rounded())),
                   weight: (Double($0.n) / Double(max(total, 1)) * 1000).rounded() / 1000)
        }
    }
}

// Vision: text, labels and the fingerprint, from a 1600 px copy so huge screenshots stay quick.
if let img = thumbnail(1600) {
    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .accurate
    text.usesLanguageCorrection = true
    let classify = VNClassifyImageRequest()
    let print = VNGenerateImageFeaturePrintRequest()
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do {
        try handler.perform([text, classify, print])
        let lines = (text.results ?? []).sorted { a, b in
            let A = a.boundingBox, B = b.boundingBox
            return A.minY <= B.maxY && B.minY <= A.maxY ? A.minX < B.minX : A.maxY > B.maxY
        }.compactMap { $0.topCandidates(1).first?.string }
        out.text = String(lines.joined(separator: "\n").prefix(20000))
        out.labels = (classify.results ?? []).filter { $0.confidence >= 0.25 }.sorted { $0.confidence > $1.confidence }.prefix(12)
            .map { Label(id: $0.identifier, c: (Double($0.confidence) * 100).rounded() / 100) }
        if let fp = print.results?.first, fp.elementCount > 0 {
            var floats = [Float](repeating: 0, count: fp.elementCount)
            fp.data.withUnsafeBytes { raw in
                for i in 0..<fp.elementCount {
                    floats[i] = fp.elementType == .double ? Float(raw.loadUnaligned(fromByteOffset: i * 8, as: Double.self))
                                                          : raw.loadUnaligned(fromByteOffset: i * 4, as: Float.self)
                }
            }
            out.featurePrint = floats.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
        }
    } catch {
        out.error = "vision: \(error.localizedDescription)"
    }
}
emit(out)
