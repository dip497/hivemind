import SwiftUI
import UIKit

/// A community view, shown (design §6 screen 9, §6.1): its name and Back above, and under them its
/// page, filling the rest of the screen and following the keyboard, in the look the app gives
/// views, over the theme's background. Once the view ends, why, in place of the page. What the
/// phone's lock could not be asked about is said at the foot, as Start says it.
@MainActor
struct ViewScreen: View {
    let model: PhoneModel
    let offered: OfferedView
    @State private var page: ViewPage
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    init(model: PhoneModel, offered: OfferedView) {
        self.model = model
        self.offered = offered
        _page = State(initialValue: ViewPage(offered: offered))
    }

    /// The look the view is given: the app's own, now.
    private var theme: ViewTheme {
        ViewLook.theme(
            dark: scheme == .dark, increasedContrast: contrast == .increased, accent: model.overview.person?.color)
    }

    var body: some View {
        let theme = self.theme
        let background = Accent.color(theme.colors["bg"]) ?? Color(uiColor: .systemBackground)
        ZStack {
            background.ignoresSafeArea()
            if let ended = page.ended {
                ContentUnavailableView {
                    Label(offered.info.name, systemImage: "rectangle.dashed")
                } description: {
                    Text(ended)
                }
                .accessibilityIdentifier("view.ended")
            } else {
                ViewPageScreen(page: page, phone: model.phone, background: UIColor(background))
                if let unloaded = page.unloaded {
                    ContentUnavailableView {
                        Label(offered.info.name, systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(unloaded)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(background)
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = page.notice {
                Text(notice)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.bar)
                    .onTapGesture { page.notice = nil }
                    .accessibilityIdentifier("view.notice")
            }
        }
        .navigationTitle(offered.info.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .onChange(of: theme, initial: true) { _, theme in
            page.looks(theme)
        }
        .onAppear { page.start(on: model.phone) }
        .onDisappear { page.stop() }
    }
}
