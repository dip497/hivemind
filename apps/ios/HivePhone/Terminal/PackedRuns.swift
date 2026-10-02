import Foundation

/// One style run of a terminal line (design §5.3): `length` UTF-16 units of the line's text from
/// `start`, drawn in one style from column `col`.
struct TerminalRun: Equatable {
    var start: Int
    var length: Int
    var col: Int
    var flags: UInt16
    var fg: UInt32
    var bg: UInt32

    var bold: Bool { flags & 0x001 != 0 }
    var dim: Bool { flags & 0x002 != 0 }
    var italic: Bool { flags & 0x004 != 0 }
    var underline: Bool { flags & 0x008 != 0 }
    var inverse: Bool { flags & 0x010 != 0 }
    var strikethrough: Bool { flags & 0x020 != 0 }
    var hidden: Bool { flags & 0x040 != 0 }
    /// A run of one double-width character, two cells wide.
    var wide: Bool { flags & 0x100 != 0 }
}

/// A run's colour (design §5.3): the top byte says which kind.
enum TerminalColor: Equatable {
    /// The theme's own foreground or background.
    case standard
    case palette(UInt8)
    case rgb(UInt8, UInt8, UInt8)

    init(_ packed: UInt32) {
        switch packed >> 24 {
        case 1: self = .palette(UInt8(packed & 0xff))
        case 2: self = .rgb(UInt8((packed >> 16) & 0xff), UInt8((packed >> 8) & 0xff), UInt8(packed & 0xff))
        default: self = .standard
        }
    }
}

/// A line's runs as the core packs them (design §5.3): 16 bytes each, little-endian, back to back.
/// Read once per changed line; drawing never looks at the bytes again.
enum PackedRuns {
    static let size = 16

    static func decode(_ bytes: some ContiguousBytes) -> [TerminalRun] {
        bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> [TerminalRun] in
            let count = raw.count / size
            var runs: [TerminalRun] = []
            runs.reserveCapacity(count)
            for at in stride(from: 0, to: count * size, by: size) {
                runs.append(TerminalRun(
                    start: Int(UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: at, as: UInt16.self))),
                    length: Int(UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: at + 2, as: UInt16.self))),
                    col: Int(UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: at + 4, as: UInt16.self))),
                    flags: UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: at + 6, as: UInt16.self)),
                    fg: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: at + 8, as: UInt32.self)),
                    bg: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: at + 12, as: UInt32.self))))
            }
            return runs
        }
    }
}
