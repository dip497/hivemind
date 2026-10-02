import Foundation

/// What a failed call says to the person: the core's own words (design §5.1, `PhoneError`, a flat
/// error whose text is its `message`).
enum ErrorText {
    static func of(_ error: Error) -> String {
        guard let error = error as? PhoneError else { return error.localizedDescription }
        switch error {
        case .NotPaired(let message), .Unreachable(let message), .Refused(let message),
            .Invalid(let message), .Failed(let message):
            return message
        }
    }
}
