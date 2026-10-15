import SwiftUI

/// Pair until the phone is paired with one of the person's devices, Home after; and the core told
/// when the app comes to the foreground or leaves it (design §3.2).
@MainActor
struct RootView: View {
    let model: PhoneModel
    @Environment(\.scenePhase) private var phase
    /// Set while Pair is on screen, so that pairing ends on whose the phone now is rather than on a
    /// jump to Home the moment the device is there.
    @State private var pairing = false

    var body: some View {
        Group {
            if pairing || model.overview.devices.isEmpty {
                NavigationStack {
                    PairView(model: model) { pairing = false }
                }
                .onAppear { pairing = true }
            } else {
                HomeScreen(model: model)
            }
        }
        .tint(Look.text)
        .onOpenURL { url in model.pendingLink = url.absoluteString }
        .onChange(of: phase, initial: true) { _, phase in
            switch phase {
            case .active: model.foreground()
            case .background: model.background()
            default: break
            }
        }
    }
}

/// What the last call that went wrong said, for a few seconds.
@MainActor
struct NoticeBanner: View {
    let model: PhoneModel

    var body: some View {
        if let notice = model.notice {
            Text(notice)
                .font(.callout)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .padding(.top, 8)
                .padding(.horizontal, 16)
                .onTapGesture { model.notice = nil }
                .task(id: notice) {
                    do {
                        try await Task.sleep(for: .seconds(4))
                        model.notice = nil
                    } catch {
                        // A newer notice took its place.
                    }
                }
        }
    }
}
