import SwiftUI

/// Pair until the phone is paired with one of the person's devices, the tabs after; and the core
/// told when the app comes to the foreground or leaves it (design §3.2).
@MainActor
struct RootView: View {
    let model: PhoneModel
    @Environment(\.scenePhase) private var phase
    /// Set while Pair is on screen, so that pairing ends on whose the phone now is rather than on a
    /// jump to the tabs the moment the device is there.
    @State private var pairing = false

    var body: some View {
        Group {
            if pairing || model.overview.devices.isEmpty {
                NavigationStack {
                    PairView(model: model) { pairing = false }
                }
                .onAppear { pairing = true }
            } else {
                MainTabs(model: model)
            }
        }
        .tint(Accent.color(model.overview.person?.color))
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

/// The tabs (design §6): what needs the person, every agent, the community views the person's
/// computers offer the phone, and the person's devices.
@MainActor
struct MainTabs: View {
    let model: PhoneModel
    @State private var pairingAnother = false

    var body: some View {
        TabView {
            NeedsTab(model: model)
                .tabItem { Label("Needs you", systemImage: "exclamationmark.bubble") }
                .badge(model.overview.needs.count)
            AgentsTab(model: model)
                .tabItem { Label("Agents", systemImage: "terminal") }
            ViewsTab(model: model)
                .tabItem { Label("Views", systemImage: "square.grid.2x2") }
            DevicesTab(model: model) { pairingAnother = true }
                .tabItem { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
        }
        .overlay(alignment: .top) { NoticeBanner(model: model) }
        .sheet(isPresented: $pairingAnother) {
            NavigationStack {
                PairView(model: model) { pairingAnother = false }
            }
        }
        .onChange(of: model.pendingLink, initial: true) { _, link in
            if link != nil { pairingAnother = true }
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
