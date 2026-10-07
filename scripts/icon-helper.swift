// icon-helper: renders macOS icons to PNG for scan-mac.mjs.
//
//   icon-helper icon   <px> <path> <out.png> [<path> <out.png> ...]
//       NSWorkspace.shared.icon(forFile:) rendered at <px> x <px> (works for .app bundles
//       with Assets.car icons, folders, volumes, documents).
//   icon-helper thumb  <px> <path> <out.png> [<path> <out.png> ...]
//       Finder-style icon: QuickLook thumbnail in icon mode (image/pdf/html previews with the
//       document frame), falling back to the NSWorkspace icon when QuickLook has nothing.
//   icon-helper symbol <px> <name> <pointSize> <weight> <out.png> [...]
//       SF Symbol rendered white on transparent, <px> tall canvas (menu bar glyphs).
//
// Compiled once by scan-mac.mjs with `swiftc -O` into scripts/.bin/.

import AppKit
import QuickLookThumbnailing
import UniformTypeIdentifiers

NSApplication.shared.setActivationPolicy(.prohibited)

func writePNG(_ image: NSImage, size: Int, to out: String, pad: CGFloat = 0) {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high
    let s = CGFloat(size)
    image.draw(in: NSRect(x: pad, y: pad, width: s - 2 * pad, height: s - 2 * pad),
               from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: out))
    }
}

func workspaceIcon(_ path: String, _ size: Int) -> NSImage {
    let icon = NSWorkspace.shared.icon(forFile: path)
    icon.size = NSSize(width: size, height: size)
    return icon
}

func quickLookIcon(_ path: String, _ size: Int) -> NSImage? {
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else { return nil }
    let url = URL(fileURLWithPath: path)
    // Finder shows real thumbnails for media (images, PDFs, movies) and the decorated generic
    // document icon (page + type badge) for text-like documents such as .html.
    var isMedia = false
    if let type = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType {
        isMedia = type.conforms(to: .image) || type.conforms(to: .pdf) || type.conforms(to: .audiovisualContent)
    }
    let req = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: size, height: size),
                                           scale: 1, representationTypes: isMedia ? .thumbnail : .icon)
    req.iconMode = true
    let sem = DispatchSemaphore(value: 0)
    var result: NSImage? = nil
    QLThumbnailGenerator.shared.generateBestRepresentation(for: req) { rep, _ in
        if let rep = rep, rep.type == (isMedia ? .thumbnail : .icon) { result = rep.nsImage }
        sem.signal()
    }
    // QuickLook needs the main run loop for XPC callbacks.
    while sem.wait(timeout: .now()) == .timedOut {
        RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
    }
    return result
}

func symbolImage(_ name: String, pointSize: CGFloat, weight: String) -> NSImage? {
    let w: NSFont.Weight
    switch weight {
    case "bold": w = .bold
    case "semibold": w = .semibold
    case "medium": w = .medium
    case "light": w = .light
    default: w = .regular
    }
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
    let cfg = NSImage.SymbolConfiguration(pointSize: pointSize, weight: w)
        .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
    return base.withSymbolConfiguration(cfg)
}

// MARK: - wallpaper: HEIC/any image -> JPEG, choosing the dark/light variant of a multi-image HEIC.
func convertWallpaper(_ input: String, _ out: String, maxPx: Int, dark: Bool) -> Bool {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil) else { return false }
    let count = CGImageSourceGetCount(src)
    var index = 0
    if count >= 2 {
        // Apple's appearance-aware wallpapers carry XMP "apr" metadata: {"l": lightIdx, "d": darkIdx}.
        // Decoding it needs base64 plist parsing; the shipped files use l=0, d=1, so fall back to that.
        index = dark ? 1 : 0
        if let meta = CGImageSourceCopyMetadataAtIndex(src, 0, nil),
           let tags = CGImageMetadataCopyTags(meta) as? [CGImageMetadataTag] {
            for tag in tags {
                guard let name = CGImageMetadataTagCopyName(tag) as String?, name == "apr",
                      let val = CGImageMetadataTagCopyValue(tag) as? String,
                      let data = Data(base64Encoded: val),
                      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { continue }
                if let v = plist[dark ? "d" : "l"] as? Int { index = v }
            }
        }
    }
    guard let img = CGImageSourceCreateImageAtIndex(src, min(index, count - 1), nil) else { return false }
    let w = img.width, h = img.height
    let scale = min(1.0, Double(maxPx) / Double(max(w, h)))
    let tw = Int(Double(w) * scale), th = Int(Double(h) * scale)
    // Keep the wallpaper's wide-gamut colours: render in Display P3 and embed that profile so the
    // browser colour-manages it exactly like WallpaperAgent does.
    guard let ctx = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.displayP3)!,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: tw, height: th))
    guard let outImg = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.jpeg" as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, outImg, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
    return CGImageDestinationFinalize(dest)
}

// MARK: - strip: lift the status-item glyphs out of a menu bar screenshot as white-on-transparent.
// Input: PNG of the top of the main display (retina). Output: PNG strip + JSON on stdout
// describing, in screen points, where the strip and the clock sit relative to the right edge.
func fail(_ m: String) -> Bool { FileHandle.standardError.write(("strip: " + m + "\n").data(using: .utf8)!); return false }
func stripStatusItems(_ input: String, _ out: String, scale: Double, textIsDark: Bool) -> Bool {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return fail("guard 1") }
    let w = img.width, h = img.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return fail("guard 2") }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let buf = ctx.data else { return fail("guard 3") }
    let p = buf.bindMemory(to: UInt8.self, capacity: w * h * 4)
    @inline(__always) func px(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let o = (y * w + x) * 4; return (Int(p[o]), Int(p[o + 1]), Int(p[o + 2]))
    }
    // Columns containing near-white glyph pixels (status glyphs are white in both appearances for
    // dark menu bars; in light menu bars they are black -> invert detection).
    // Glyph colour: white on dark menu bars (dark mode), black on light ones; caller decides.
    let darkText = textIsDark
    func isGlyph(_ x: Int, _ y: Int) -> Bool {
        let (r, g, b) = px(x, y)
        return darkText ? max(r, g, b) < 45 : min(r, g, b) > 205
    }
    var glyphCol = [Bool](repeating: false, count: w)
    for x in 0..<w { var n = 0; for y in 2..<(h - 2) where isGlyph(x, y) { n += 1 }; glyphCol[x] = n >= 1 }
    // Group columns into glyphs (gap <= 6px) then items (gap <= 24px @2x).
    var glyphs: [(Int, Int)] = []
    var s = -1, last = -1
    for x in 0..<w where glyphCol[x] {
        if s < 0 { s = x } else if x - last > Int(3 * scale) { glyphs.append((s, last)); s = x }
        last = x
    }
    if s >= 0 { glyphs.append((s, last)) }
    var items: [(Int, Int)] = []
    for g in glyphs {
        if let l = items.last, g.0 - l.1 <= Int(12 * scale) { items[items.count - 1].1 = g.1 } else { items.append(g) }
    }
    // Status items are the run of items on the right separated by gaps < 60pt; the big gap to
    // the app menus ends the run. The rightmost item is the clock.
    var statusItems: [(Int, Int)] = []
    for it in items.reversed() {
        if let l = statusItems.last, l.0 - it.1 > Int(60 * scale) { break }
        statusItems.append(it)
    }
    statusItems.reverse()
    guard statusItems.count >= 2 else { return fail("guard 4") }
    let clock = statusItems.removeLast()
    let x0 = max(0, statusItems.first!.0 - Int(4 * scale)), x1 = min(w, statusItems.last!.1 + Int(4 * scale))
    let sw = x1 - x0
    // Glyph band: rows that contain glyph pixels inside the status items (+ margin).
    var ymin = h, ymax = 0
    for it in statusItems { for x in it.0...it.1 { for y in 0..<h where isGlyph(x, y) { ymin = min(ymin, y); ymax = max(ymax, y) } } }
    let m = Int(2 * scale)
    ymin = max(0, ymin - m); ymax = min(h - 1, ymax + m)
    // Only pixels inside an item's box can be glyph; everything else is transparent.
    var inItem = [Bool](repeating: false, count: w)
    for it in statusItems { for x in max(0, it.0 - m)...min(w - 1, it.1 + m) { inItem[x] = true } }
    guard let octx = CGContext(data: nil, width: sw, height: h, bitsPerComponent: 8, bytesPerRow: sw * 4,
                               space: CGColorSpace(name: CGColorSpace.sRGB)!,
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let ob = octx.data else { return fail("guard 5") }
    let q = ob.bindMemory(to: UInt8.self, capacity: sw * h * 4)
    func median(_ v: [Int]) -> Double { if v.isEmpty { return 0 }; let s = v.sorted(); return Double(s[s.count / 2]) }
    for x in x0..<x1 {
        // Background per column: medians of the rows above and below the glyph band, interpolated
        // linearly through the band (the wallpaper varies smoothly over 37 pt).
        var top: [[Int]] = [[], [], []], bot: [[Int]] = [[], [], []]
        for y in 0..<ymin { let (r, g, b) = px(x, y); top[0].append(r); top[1].append(g); top[2].append(b) }
        for y in (ymax + 1)..<h { let (r, g, b) = px(x, y); bot[0].append(r); bot[1].append(g); bot[2].append(b) }
        var bt = [median(top[0]), median(top[1]), median(top[2])], bb = [median(bot[0]), median(bot[1]), median(bot[2])]
        if top[0].isEmpty { bt = bb }; if bot[0].isEmpty { bb = bt }
        for y in 0..<h {
            let o = (y * sw + (x - x0)) * 4
            if !inItem[x] || y < ymin || y > ymax { q[o] = 0; q[o + 1] = 0; q[o + 2] = 0; q[o + 3] = 0; continue }
            let t = Double(y - ymin + m) / Double(max(1, ymax - ymin + 2 * m))
            let bg = [bt[0] + (bb[0] - bt[0]) * t, bt[1] + (bb[1] - bt[1]) * t, bt[2] + (bb[2] - bt[2]) * t]
            let (r, g, b) = px(x, y); let pix = [Double(r), Double(g), Double(b)]
            var a = 0.0
            var c = [0.0, 0.0, 0.0]
            if darkText {
                for k in 0..<3 { a = max(a, (bg[k] - pix[k]) / max(bg[k], 1)) }
                a = min(max(a, 0), 1); if a < 0.15 { a = 0 }
            } else {
                for k in 0..<3 { a = max(a, (pix[k] - bg[k]) / max(255 - bg[k], 1)) }
                a = min(max(a, 0), 1); if a < 0.15 { a = 0 }
                // Wallpaper highlights are chromatic; glyph pixels are neutral (white blended with the
                // background) or a saturated badge colour (red dot). Reject purple-ish highlights.
                let chroma = pix.max()! - pix.min()!
                let reddish = pix[0] - max(pix[1], pix[2]) > 60
                let strongWhite = pix.min()! > 215
                if !(chroma < 60 || reddish || strongWhite) { a = 0 }
                if a > 0 {
                    // Un-premultiply against the background to recover the glyph colour; neutral
                    // results snap to pure white (menu bar glyphs are white), tinted ones are kept.
                    for k in 0..<3 { c[k] = min(255, max(0, bg[k] + (pix[k] - bg[k]) / a)) }
                    if (c.max()! - c.min()!) < 70 { c = [255, 255, 255] }
                }
            }
            q[o] = UInt8(c[0] * a); q[o + 1] = UInt8(c[1] * a); q[o + 2] = UInt8(c[2] * a); q[o + 3] = UInt8(a * 255)
        }
    }
    // Despeckle: drop faint pixels with fewer than two solid neighbours (wallpaper residue).
    var alpha = [UInt8](repeating: 0, count: sw * h)
    for i in 0..<(sw * h) { alpha[i] = q[i * 4 + 3] }
    for y in 0..<h { for x in 0..<sw {
        let i = y * sw + x
        if alpha[i] == 0 || alpha[i] > 170 { continue }
        var solid = 0
        for dy in -1...1 { for dx in -1...1 where !(dx == 0 && dy == 0) {
            let nx = x + dx, ny = y + dy
            if nx >= 0 && ny >= 0 && nx < sw && ny < h && alpha[ny * sw + nx] > 90 { solid += 1 } } }
        if solid < 2 { q[i * 4] = 0; q[i * 4 + 1] = 0; q[i * 4 + 2] = 0; q[i * 4 + 3] = 0 }
    } }
    guard let outImg = octx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.png" as CFString, 1, nil) else { return fail("guard 6") }
    CGImageDestinationAddImage(dest, outImg, nil)
    guard CGImageDestinationFinalize(dest) else { return fail("guard 7") }
    let pt = { (v: Int) in Double(v) / scale }
    let itemsJSON = statusItems.map { "{\"x0\":\(pt($0.0 - x0)),\"x1\":\(pt($0.1 - x0))}" }.joined(separator: ",")
    print("{\"width\":\(pt(sw)),\"height\":\(pt(h)),\"rightInset\":\(pt(w - x1)),\"gapToClock\":\(pt(clock.0 - x1))," +
          "\"clockWidth\":\(pt(clock.1 - clock.0)),\"clockRightInset\":\(pt(w - clock.1)),\"darkText\":\(darkText)," +
          "\"items\":[\(itemsJSON)]}")
    return true
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "wallpaper" {
    // wallpaper <in> <out.jpg> <maxPx> <dark|light>
    guard args.count >= 6 else { exit(2) }
    exit(convertWallpaper(args[2], args[3], maxPx: Int(args[4]) ?? 3840, dark: args[5] == "dark") ? 0 : 1)
}
if args.count >= 2 && args[1] == "strip" {
    // strip <in.png> <out.png> <scale> <white|black>   (glyph colour)
    guard args.count >= 6 else { exit(2) }
    exit(stripStatusItems(args[2], args[3], scale: Double(args[4]) ?? 2, textIsDark: args[5] == "black") ? 0 : 1)
}
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: icon-helper icon|thumb|symbol <px> ...\n".data(using: .utf8)!)
    exit(2)
}
let mode = args[1]
let px = Int(args[2]) ?? 256
var i = 3
switch mode {
case "icon":
    while i + 1 < args.count {
        writePNG(workspaceIcon(args[i], px), size: px, to: args[i + 1]); i += 2
    }
case "thumb":
    while i + 1 < args.count {
        let path = args[i], out = args[i + 1]; i += 2
        if let ql = quickLookIcon(path, px) {
            // Finder draws thumbnails slightly inset within the icon cell; mimic with a small pad.
            writePNG(ql, size: px, to: out, pad: ql.size.width >= CGFloat(px) ? CGFloat(px) * 0.04 : 0)
        } else {
            writePNG(workspaceIcon(path, px), size: px, to: out)
        }
    }
case "symbol":
    // symbol <px> <name> <pointSize> <weight> <out.png>
    while i + 3 < args.count {
        let name = args[i], pt = CGFloat(Double(args[i + 1]) ?? 13), weight = args[i + 2], out = args[i + 3]; i += 4
        guard let img = symbolImage(name, pointSize: pt, weight: weight) else { continue }
        // Render at natural aspect: canvas px tall, width proportional.
        let natural = img.size
        let scale = CGFloat(px) / max(natural.height, 1)
        let wpx = Int((natural.width * scale).rounded(.up))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: wpx, pixelsHigh: px,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        img.draw(in: NSRect(x: 0, y: 0, width: CGFloat(wpx), height: CGFloat(px)), from: .zero,
                 operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        if let data = rep.representation(using: .png, properties: [:]) {
            try? data.write(to: URL(fileURLWithPath: out))
        }
        // Report natural point size so the page can size it: "name width height"
        print("\(name) \(natural.width) \(natural.height)")
    }
default:
    exit(2)
}
