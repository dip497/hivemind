import Foundation
import WebKit

/// A community view's files, served to its web view on the view's own origin (design §6.1): each
/// had from the computer as it serves them to its own windows (`view_file`), and answered under the
/// policy it came with; anything not the view's, or not had, is not found. A load WebKit has stopped
/// is never answered: a stopped task raises an exception when it is.
@MainActor
final class ViewFiles: NSObject, WKURLSchemeHandler {
    private let phone: Phone
    private let offered: OfferedView
    /// Told when the page itself could not be had.
    private weak var page: ViewPage?
    /// The loads under way, by their task.
    private var loading: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(phone: Phone, page: ViewPage) {
        self.phone = phone
        offered = page.offered
        self.page = page
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        guard let path = offered.origin.path(of: url) else {
            answer(urlSchemeTask, with: ViewOrigin.answer(url, with: nil))
            return
        }
        let id = ObjectIdentifier(urlSchemeTask as AnyObject)
        let phone = self.phone
        let offered = self.offered
        loading[id] = Task { [weak self] in
            var file: ViewFile? = nil
            var failure: String? = nil
            do {
                file = try await phone.viewFile(
                    device: offered.device, workspace: offered.workspace, view: offered.info.id, path: path)
            } catch {
                failure = ErrorText.of(error)
            }
            // Stopped meanwhile: WebKit wants nothing more of it.
            guard let self, self.loading.removeValue(forKey: id) != nil else { return }
            if let failure, path == offered.info.page {
                self.page?.pageFailed(failure)
            }
            self.answer(urlSchemeTask, with: ViewOrigin.answer(url, with: file))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        loading.removeValue(forKey: ObjectIdentifier(urlSchemeTask as AnyObject))?.cancel()
    }

    private func answer(_ task: any WKURLSchemeTask, with served: ViewOrigin.Served?) {
        guard let served else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(served.response)
        task.didReceive(served.data)
        task.didFinish()
    }
}
