import Cocoa
import CoreGraphics

let size = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: size * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Cannot create CGContext")
}

ctx.setAllowsAntialiasing(true)
ctx.setShouldAntialias(true)

let w = CGFloat(size)
let h = CGFloat(size)
let center = CGPoint(x: w * 0.5, y: h * 0.5)

// 1. Apple macOS Continuous Squircle Clipping Path
let inset: CGFloat = 20
let rect = CGRect(x: inset, y: inset, width: w - inset * 2, height: h - inset * 2)
let cornerRadius: CGFloat = 222
let squirclePath = CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)

ctx.saveGState()
ctx.addPath(squirclePath)
ctx.clip()

// 2. Deep Midnight Obsidian Luxury Background Gradient
let bgColors = [
    CGColor(red: 0.024, green: 0.039, blue: 0.075, alpha: 1.0),
    CGColor(red: 0.045, green: 0.070, blue: 0.130, alpha: 1.0),
    CGColor(red: 0.080, green: 0.045, blue: 0.090, alpha: 1.0)
] as CFArray
let bgLocs: [CGFloat] = [0.0, 0.55, 1.0]
if let bgGrad = CGGradient(colorsSpace: colorSpace, colors: bgColors, locations: bgLocs) {
    ctx.drawLinearGradient(bgGrad, start: CGPoint(x: 0, y: h), end: CGPoint(x: w, y: 0), options: [])
}

// 3. Ambient Emerald & Amber Backlight Glow behind the Lens
ctx.saveGState()
let glow1Colors = [
    CGColor(red: 0.176, green: 0.831, blue: 0.749, alpha: 0.36),
    CGColor(red: 0.176, green: 0.831, blue: 0.749, alpha: 0.0)
] as CFArray
if let g1 = CGGradient(colorsSpace: colorSpace, colors: glow1Colors, locations: [0, 1]) {
    ctx.drawRadialGradient(g1, startCenter: CGPoint(x: w * 0.36, y: h * 0.64), startRadius: 10, endCenter: CGPoint(x: w * 0.36, y: h * 0.64), endRadius: 420, options: [])
}
let glow2Colors = [
    CGColor(red: 0.984, green: 0.573, blue: 0.235, alpha: 0.32),
    CGColor(red: 0.984, green: 0.573, blue: 0.235, alpha: 0.0)
] as CFArray
if let g2 = CGGradient(colorsSpace: colorSpace, colors: glow2Colors, locations: [0, 1]) {
    ctx.drawRadialGradient(g2, startCenter: CGPoint(x: w * 0.66, y: h * 0.34), startRadius: 10, endCenter: CGPoint(x: w * 0.66, y: h * 0.34), endRadius: 420, options: [])
}
ctx.restoreGState()

// 4. Outer Anodized Titanium Lens Barrel Ring
let outerBarrelR: CGFloat = 385
ctx.saveGState()
ctx.addArc(center: center, radius: outerBarrelR, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.setFillColor(CGColor(red: 0.035, green: 0.051, blue: 0.090, alpha: 0.95))
ctx.fillPath()

ctx.addArc(center: center, radius: outerBarrelR, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.setLineWidth(14)
ctx.setStrokeColor(CGColor(red: 0.25, green: 0.32, blue: 0.44, alpha: 0.45))
ctx.strokePath()
ctx.restoreGState()

// 5. Precision Camera Aperture Blades (8 Overlapping Geometric Blades inside the Iris)
let bladeCount = 8
let bladeOuterR: CGFloat = 348
let bladeInnerR: CGFloat = 175
for i in 0..<bladeCount {
    ctx.saveGState()
    ctx.translateBy(x: center.x, y: center.y)
    let angle = CGFloat(i) * (.pi * 2.0 / CGFloat(bladeCount))
    ctx.rotate(by: angle)

    let path = CGMutablePath()
    path.move(to: CGPoint(x: bladeInnerR * 0.85, y: -bladeInnerR * 0.45))
    path.addQuadCurve(to: CGPoint(x: bladeOuterR * 0.95, y: bladeOuterR * 0.15),
                      control: CGPoint(x: bladeOuterR * 0.65, y: -bladeOuterR * 0.35))
    path.addArc(center: .zero, radius: bladeOuterR, startAngle: 0.15, endAngle: 0.92, clockwise: false)
    path.addQuadCurve(to: CGPoint(x: bladeInnerR * 0.85, y: -bladeInnerR * 0.45),
                      control: CGPoint(x: bladeInnerR * 1.15, y: bladeInnerR * 0.45))
    path.closeSubpath()

    ctx.addPath(path)
    let isEven = (i % 2 == 0)
    let c1 = isEven
        ? CGColor(red: 0.07, green: 0.15, blue: 0.22, alpha: 0.88)
        : CGColor(red: 0.05, green: 0.10, blue: 0.17, alpha: 0.92)
    ctx.setFillColor(c1)
    ctx.fillPath()

    ctx.addPath(path)
    ctx.setLineWidth(3.0)
    ctx.setStrokeColor(isEven
        ? CGColor(red: 0.176, green: 0.831, blue: 0.749, alpha: 0.32)
        : CGColor(red: 0.984, green: 0.573, blue: 0.235, alpha: 0.25))
    ctx.strokePath()
    ctx.restoreGState()
}

// 6. Bionic Human Iris Radial Fibers (72 Luminous Neural Filaments around the Pupil)
let fiberCount = 72
let irisOuterR: CGFloat = 285
let irisInnerR: CGFloat = 118

// Base Iris Ring Glow
ctx.saveGState()
let irisGradColors = [
    CGColor(red: 0.02, green: 0.04, blue: 0.08, alpha: 1.0),
    CGColor(red: 0.06, green: 0.36, blue: 0.38, alpha: 0.95),
    CGColor(red: 0.176, green: 0.831, blue: 0.749, alpha: 0.85),
    CGColor(red: 0.04, green: 0.08, blue: 0.14, alpha: 0.98)
] as CFArray
if let irisGrad = CGGradient(colorsSpace: colorSpace, colors: irisGradColors, locations: [0.0, 0.38, 0.78, 1.0]) {
    ctx.drawRadialGradient(irisGrad, startCenter: center, startRadius: irisInnerR * 0.85, endCenter: center, endRadius: irisOuterR, options: [])
}
ctx.restoreGState()

// Draw Neural Iris Filaments
for i in 0..<fiberCount {
    let a = CGFloat(i) * (.pi * 2.0 / CGFloat(fiberCount))
    let wave = sin(CGFloat(i) * 0.75) * 14.0
    let r1 = irisInnerR + 4
    let r2 = irisOuterR - 14 + wave

    let p1 = CGPoint(x: center.x + cos(a) * r1, y: center.y + sin(a) * r1)
    let p2 = CGPoint(x: center.x + cos(a) * r2, y: center.y + sin(a) * r2)
    let ctrlA = a + 0.045 * sin(CGFloat(i))
    let ctrlR = (r1 + r2) * 0.5
    let ctrl = CGPoint(x: center.x + cos(ctrlA) * ctrlR, y: center.y + sin(ctrlA) * ctrlR)

    let path = CGMutablePath()
    path.move(to: p1)
    path.addQuadCurve(to: p2, control: ctrl)

    ctx.saveGState()
    ctx.addPath(path)
    // Top-right warm coral-gold spectrum, bottom-left emerald-cyan spectrum
    let mix = (cos(a - 0.6) + 1.0) * 0.5
    if mix > 0.62 {
        ctx.setStrokeColor(CGColor(red: 0.984, green: 0.573, blue: 0.235, alpha: 0.55 + 0.35 * mix))
    } else {
        ctx.setStrokeColor(CGColor(red: 0.176, green: 0.86, blue: 0.78, alpha: 0.45 + 0.45 * (1.0 - mix)))
    }
    ctx.setLineWidth(i % 3 == 0 ? 4.2 : 2.4)
    ctx.setLineCap(.round)
    ctx.strokePath()
    ctx.restoreGState()
}

// 7. Dual Luminous Iris Limbal Arcs (Mint-Teal & Warm Coral-Amber)
ctx.saveGState()
ctx.setLineCap(.round)
ctx.setLineWidth(14)
ctx.addArc(center: center, radius: irisOuterR + 4, startAngle: .pi * 0.15, endAngle: .pi * 0.98, clockwise: false)
ctx.setStrokeColor(CGColor(red: 0.176, green: 0.88, blue: 0.78, alpha: 0.95))
ctx.strokePath()

ctx.addArc(center: center, radius: irisOuterR + 4, startAngle: .pi * 1.15, endAngle: .pi * 1.98, clockwise: false)
ctx.setStrokeColor(CGColor(red: 0.984, green: 0.52, blue: 0.24, alpha: 0.95))
ctx.strokePath()
ctx.restoreGState()

// 8. Deep Optical Pupil Core
ctx.saveGState()
ctx.addArc(center: center, radius: irisInnerR, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.setFillColor(CGColor(red: 0.02, green: 0.03, blue: 0.06, alpha: 1.0))
ctx.fillPath()

ctx.addArc(center: center, radius: irisInnerR, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.setLineWidth(5.5)
ctx.setStrokeColor(CGColor(red: 0.38, green: 0.95, blue: 0.88, alpha: 0.85))
ctx.strokePath()
ctx.restoreGState()

// 9. Crisp 4-Point AI Focus Sparkle inside the Pupil
ctx.saveGState()
let starR: CGFloat = 74
let starIn: CGFloat = 15
let starPath = CGMutablePath()
starPath.move(to: CGPoint(x: center.x, y: center.y + starR))
starPath.addQuadCurve(to: CGPoint(x: center.x + starR, y: center.y),
                      control: CGPoint(x: center.x + starIn, y: center.y + starIn))
starPath.addQuadCurve(to: CGPoint(x: center.x, y: center.y - starR),
                      control: CGPoint(x: center.x + starIn, y: center.y - starIn))
starPath.addQuadCurve(to: CGPoint(x: center.x - starR, y: center.y),
                      control: CGPoint(x: center.x - starIn, y: center.y - starIn))
starPath.addQuadCurve(to: CGPoint(x: center.x, y: center.y + starR),
                      control: CGPoint(x: center.x - starIn, y: center.y + starIn))
starPath.closeSubpath()

ctx.addPath(starPath)
ctx.setFillColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.98))
ctx.fillPath()

// Warm coral center pinpoint
ctx.addArc(center: center, radius: 12, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.setFillColor(CGColor(red: 1.0, green: 0.42, blue: 0.32, alpha: 1.0))
ctx.fillPath()
ctx.restoreGState()

// 10. Realistic Optical Lens Specular Catchlights (Top-Left Glass Reflection)
ctx.saveGState()
ctx.addArc(center: CGPoint(x: center.x - 105, y: center.y + 115), radius: 34, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.setFillColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.55))
ctx.fillPath()

ctx.addArc(center: CGPoint(x: center.x - 62, y: center.y + 150), radius: 14, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.setFillColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.38))
ctx.fillPath()
ctx.restoreGState()

// 11. Outer Glass Squircle Rim Border
ctx.addPath(squirclePath)
ctx.setLineWidth(12)
ctx.setStrokeColor(CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.16))
ctx.strokePath()

ctx.restoreGState()

guard let cgImg = ctx.makeImage() else {
    fatalError("Failed to make image")
}

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/iris_icon_1024.png"
let url = URL(fileURLWithPath: outPath)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Failed to create destination")
}
CGImageDestinationAddImage(dest, cgImg, nil)
CGImageDestinationFinalize(dest)
print("Generated Iris icon at \(outPath)")
