import Foundation
import SwiftUI

/// A frame's colour as the desktop keeps it: `#rrggbb`, `#rgb` or `oklch(L C H)`, read into sRGB
/// (each part 0...1); none for anything else, which Home draws in grey.
struct FrameColor: Equatable {
    let red: Double
    let green: Double
    let blue: Double

    static func read(_ text: String) -> FrameColor? {
        let text = text.trimmingCharacters(in: .whitespaces).lowercased()
        if text.hasPrefix("#") { return hex(String(text.dropFirst())) }
        if text.hasPrefix("oklch(") && text.hasSuffix(")") {
            let inside = text.dropFirst(6).dropLast().split(separator: "/").first ?? ""
            let parts = inside.split(whereSeparator: { $0 == " " || $0 == "," })
            guard parts.count == 3 else { return nil }
            var lightness = parts[0]
            let percent = lightness.hasSuffix("%")
            if percent { lightness = lightness.dropLast() }
            guard var l = Double(lightness), let c = Double(parts[1]), let h = Double(parts[2].replacingOccurrences(of: "deg", with: "")) else {
                return nil
            }
            if percent { l /= 100 }
            return oklch(l, c, h)
        }
        return nil
    }

    var color: Color { Color(.sRGB, red: red, green: green, blue: blue) }

    private static func hex(_ digits: String) -> FrameColor? {
        let full = digits.count == 3 ? digits.map { "\($0)\($0)" }.joined() : digits
        guard full.count == 6, let rgb = UInt32(full, radix: 16) else { return nil }
        return FrameColor(
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255)
    }

    /// OKLCH to sRGB by way of OKLab and linear sRGB, clipped to what sRGB holds.
    private static func oklch(_ l: Double, _ c: Double, _ h: Double) -> FrameColor {
        let a = c * cos(h * .pi / 180)
        let b = c * sin(h * .pi / 180)
        let l3 = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m3 = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s3 = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
        func gamma(_ v: Double) -> Double {
            let v = min(max(v, 0), 1)
            return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055
        }
        return FrameColor(
            red: gamma(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
            green: gamma(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
            blue: gamma(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3))
    }
}
