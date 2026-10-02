import Foundation
import Observation

/// The app's one `Phone`, and the newest overview of the person's agents and devices (design §3):
/// drawn first from what the core kept, then replaced whole each time the core says a newer one
/// exists, never waited for.
@MainActor
@Observable
final class PhoneModel {
    let phone: Phone
    /// The newest snapshot the main thread took (§5.2).
    private(set) var overview: Overview
    /// What the last call to a device that went wrong said, shown for a moment.
    var notice: String? = nil
    /// A pairing link the system handed the app (`hivemind://pair/…`), until Pair takes it.
    var pendingLink: String? = nil

    @ObservationIgnored private var following: Following? = nil

    init(phone: Phone) {
        self.phone = phone
        overview = phone.overview()
    }

    /// The app came to the foreground: the core dials every device at once (§3.2), and the app
    /// follows the overview from then on.
    func foreground() {
        phone.onForeground()
        if following == nil {
            following = phone.follow(listener: OverviewRelay { [weak self] in self?.pull() })
        }
        pull()
    }

    /// iOS suspends sockets in the background; the core closes them first.
    func background() {
        phone.onBackground()
    }

    /// Takes the newest snapshot, once, however many revisions came since the last one taken.
    func pull() {
        let next = phone.overview()
        if next.revision != overview.revision {
            overview = next
        }
    }

    /// Runs one of the person's calls to a device; what goes wrong becomes the notice.
    func act(_ call: @escaping @MainActor () async throws -> Void) {
        Task {
            do {
                try await call()
            } catch {
                notice = ErrorText.of(error)
            }
        }
    }

    /// Answers what an agent waits on. The wait is named by when it began, so an answer the device
    /// already has, from a notification or another try, lands once (§3.7).
    func answer(_ agent: Agent, _ waiting: Waiting, with answer: Answer) {
        act {
            let landed = try await self.phone.answer(agent: agent.at, since: waiting.since, answer: answer)
            if !landed {
                self.notice = "\(agent.name) no longer waits on that."
            }
        }
    }

    /// Closes an agent once the phone's own lock says it is the person (§4): its session ends and
    /// its tile leaves the board. Whether it is gone now: the core says no when it was closed
    /// already, which is gone too.
    func close(_ agent: AgentRef, named name: String) async -> Bool {
        switch await DeviceLock.ask("Close \(name)") {
        case .unlocked:
            break
        case .cancelled:
            return false
        case .unavailable(let reason):
            notice = reason
            return false
        }
        do {
            _ = try await phone.closeAgent(agent: agent)
            return true
        } catch {
            notice = ErrorText.of(error)
            return false
        }
    }
}
