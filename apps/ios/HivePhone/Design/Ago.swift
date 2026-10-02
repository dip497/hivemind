import Foundation

/// How long ago a moment the core gave was (milliseconds since the epoch, as every time in the
/// overview is), as the lists say it: "<1 min", "5 min", "3 h", "2 d".
enum Ago {
    static func span(since millis: UInt64, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince1970 - Double(millis) / 1000)
        if seconds < 60 { return "<1 min" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) h" }
        return "\(Int(seconds / 86_400)) d"
    }
}
