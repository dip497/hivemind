import SwiftUI
import UIKit
import WebKit

/// The view's page, for SwiftUI. The theme's background is drawn under it, so that nothing flashes
/// white before the page draws.
struct ViewPageScreen: UIViewRepresentable {
    let page: ViewPage
    let phone: Phone
    let background: UIColor

    func makeUIView(context: Context) -> ViewPageWeb {
        let view = ViewPageWeb(page: page, phone: phone)
        view.paint(background)
        page.web = view
        return view
    }

    func updateUIView(_ view: ViewPageWeb, context: Context) {
        view.paint(background)
    }

    static func dismantleUIView(_ view: ViewPageWeb, coordinator: ()) {
        view.dismantle()
    }
}

/// A community view's page (design §6.1) in a web view locked down to the view: nothing kept between
/// pages, as in the computer's sandboxed frame; the core's bridge run at the start of each page, in
/// the page's own world, and what the page posts through it taken only from the page itself; the
/// view's files served on its own origin; no going anywhere else, no windows, no link previews. It
/// tells the view's session its size, each page that comes, and the web content process going.
final class ViewPageWeb: UIView, WKNavigationDelegate {
    /// The name the page posts to the app by (`webkit.messageHandlers.hive`, view_bridge.js).
    private static let handler = "hive"

    /// A page that says nothing of its viewport is laid out 980 CSS pixels wide on an iPhone, then
    /// shrunk to fit. This gives each page the web view's own width, the width the view is told it
    /// has, as its first viewport; a page that says its own has the last word. Run in a world of
    /// the app's: the page sees only the element.
    private static let fitted = """
        (() => {
          const fit = document.createElement("meta");
          fit.name = "viewport";
          fit.content = "width=device-width, initial-scale=1";
          document.documentElement?.prepend(fit);
        })();
        """

    private let web: WKWebView
    private weak var page: ViewPage?
    private let origin: ViewOrigin
    /// The view's files. The web view's configuration holds them too.
    private let files: ViewFiles
    private var laidOut = CGSize.zero

    init(page: ViewPage, phone: Phone) {
        let origin = page.offered.origin
        let files = ViewFiles(phone: phone, page: page)
        self.page = page
        self.origin = origin
        self.files = files
        let scripts = WKUserContentController()
        scripts.addUserScript(WKUserScript(
            source: viewBridge(), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(
            source: Self.fitted, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        scripts.add(PagePosts(page: page, origin: origin), contentWorld: .page, name: Self.handler)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(files, forURLScheme: ViewOrigin.scheme)
        configuration.userContentController = scripts
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences = preferences
        web = WKWebView(frame: .zero, configuration: configuration)
        super.init(frame: .zero)
        web.navigationDelegate = self
        web.allowsLinkPreview = false
        web.isOpaque = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.accessibilityIdentifier = "view.page"
        #if DEBUG
        web.isInspectable = true
        #endif
        addSubview(web)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        web.frame = bounds
        if bounds.size != laidOut {
            laidOut = bounds.size
            page?.sized(bounds.size)
        }
    }

    func load(_ url: URL) {
        web.load(URLRequest(url: url))
    }

    /// What the view's host said, handed to the page as it is (`__hive.said`): passed as a value,
    /// never written into the script.
    func say(_ message: String) {
        web.callAsyncJavaScript(
            "window.__hive.said(text)", arguments: ["text": message], in: nil, in: .page, completionHandler: nil)
    }

    func paint(_ background: UIColor) {
        backgroundColor = background
        web.backgroundColor = background
        web.scrollView.backgroundColor = background
        web.underPageBackgroundColor = background
    }

    /// The screen goes: the page's handler is let go of, and nothing more is loaded.
    func dismantle() {
        web.configuration.userContentController.removeScriptMessageHandler(
            forName: Self.handler, contentWorld: .page)
        web.navigationDelegate = nil
        web.stopLoading()
        if page?.web === self {
            page?.web = nil
        }
    }

    // MARK: Where the page may go

    /// Only to the view's own files: no link leaves the view, and no other page comes in its place.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        let own = navigationAction.request.url.flatMap { origin.path(of: $0) } != nil
        decisionHandler(own ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        page?.committed()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        page?.terminated()
    }
}

/// What a view's page posts to the app (`webkit.messageHandlers.hive`, view_bridge.js), taken only
/// from the page's main frame, on the view's own origin. The user content controller holds its
/// handlers strongly, so this holds the view weakly.
@MainActor
private final class PagePosts: NSObject, WKScriptMessageHandler {
    private weak var page: ViewPage?
    private let origin: ViewOrigin

    init(page: ViewPage, origin: ViewOrigin) {
        self.page = page
        self.origin = origin
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let from = frame.securityOrigin
        guard frame.isMainFrame, origin.isOrigin(scheme: from.`protocol`, host: from.host),
              let text = message.body as? String else { return }
        page?.posted(text)
    }
}
