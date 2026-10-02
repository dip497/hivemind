import SwiftUI
import UIKit

/// The phone app (docs/design/phone-app-2026-10-02.md): SwiftUI for the lists, sheets and settings,
/// UIKit for the live terminal, the Rust core under both.
@main
@MainActor
struct HivePhoneApp: App {
    @State private var launch: Launch

    init() {
        _launch = State(initialValue: Launch.open())
    }

    var body: some Scene {
        WindowGroup {
            switch launch {
            case .ready(let model):
                RootView(model: model)
            case .failed(let reason):
                ContentUnavailableView(
                    "Hivemind could not start",
                    systemImage: "exclamationmark.triangle",
                    description: Text(reason))
            }
        }
    }
}

/// The phone's core, opened on what it kept in the app's own files.
enum Launch {
    case ready(PhoneModel)
    case failed(String)

    @MainActor
    static func open() -> Launch {
        do {
            var dir = try FileManager.default
                .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("hivemind", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            // The phone's device key is this phone's alone: a backup restored on another phone must
            // not make a second device with its id.
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try dir.setResourceValues(values)
            let phone = try Phone.open(dir: dir.path(percentEncoded: false), name: UIDevice.current.name)
            return .ready(PhoneModel(phone: phone))
        } catch {
            return .failed(ErrorText.of(error))
        }
    }
}
