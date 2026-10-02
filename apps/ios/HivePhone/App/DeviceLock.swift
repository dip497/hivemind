import LocalAuthentication

/// The phone's own lock (Face ID, Touch ID or the passcode), asked before an agent is started or
/// closed: driving an agent is running code on the person's computer (design §4).
enum DeviceLock {
    enum Outcome: Equatable {
        case unlocked
        case cancelled
        /// The phone has no lock to ask; without one, anyone holding it could start agents.
        case unavailable(String)
    }

    @MainActor
    static func ask(_ reason: String) async -> Outcome {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return .unavailable("Set a passcode on this phone to start or close agents from it.")
        }
        do {
            let unlocked = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            return unlocked ? .unlocked : .cancelled
        } catch {
            return .cancelled
        }
    }
}
