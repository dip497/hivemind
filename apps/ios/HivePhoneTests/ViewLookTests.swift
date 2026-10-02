import XCTest
@testable import HivePhone

/// The look the app gives a community view (design §5.5, §6.1): every token the desktop gives views
/// and every status tone, each a colour the computer takes, dark and light, with the contrast
/// increased or not; and the person's colour as its accent.
final class ViewLookTests: XCTestCase {
    /// What the desktop gives views (CommunityView.tsx `THEME_VARS`) and the view protocol's status
    /// tones (protocol.ts `STATUS_TONES`): a view paints with these and finds no others.
    private let tokens: Set<String> = [
        "bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3", "line", "line2", "brand", "err", "ok", "warn", "info", "accent",
    ]
    private let tones: Set<String> = ["working", "attention", "done", "idle", "exited", "failed"]

    func testAViewIsGivenEveryTokenAndToneAsAColourTheComputerTakes() {
        for dark in [false, true] {
            for increasedContrast in [false, true] {
                let theme = ViewLook.theme(dark: dark, increasedContrast: increasedContrast, accent: nil)
                let look = "dark: \(dark), contrast increased: \(increasedContrast)"
                XCTAssertEqual(theme.mode, dark ? .dark : .light, look)
                XCTAssertEqual(Set(theme.colors.keys), tokens, look)
                XCTAssertEqual(Set(theme.status.keys), tones, look)
                let colours = Array(theme.colors.values) + Array(theme.status.values)
                    + [theme.accent, theme.surface, theme.terminalBackground].compactMap { $0 }
                for colour in colours {
                    XCTAssertTrue(isColour(colour), "\(colour), \(look)")
                }
            }
        }
        // Each look is its own: the page's ground in the dark is not the one in the light.
        XCTAssertNotEqual(
            ViewLook.theme(dark: true, increasedContrast: false, accent: nil).colors["bg"],
            ViewLook.theme(dark: false, increasedContrast: false, accent: nil).colors["bg"])
    }

    func testTheAccentIsThePersonsColourWhenTheyHaveOne() {
        let theirs = ViewLook.theme(dark: false, increasedContrast: false, accent: "#3A7BD5")
        XCTAssertEqual(theirs.accent, "#3a7bd5")
        XCTAssertEqual(theirs.colors["brand"], "#3a7bd5")
        // None, or not a colour: the app's own tint, a colour the computer takes all the same.
        for none in [nil, "", "blue", "#+3a7bd"] as [String?] {
            let theme = ViewLook.theme(dark: false, increasedContrast: false, accent: none)
            let accent = theme.accent ?? ""
            XCTAssertTrue(isColour(accent), "\(accent) for \(none ?? "none")")
            XCTAssertNotEqual(theme.accent, none)
        }
    }

    /// `#rrggbb`, as the computer checks a colour (packages/host/src/views.ts `COLOR`).
    private func isColour(_ text: String) -> Bool {
        text.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil
    }
}
