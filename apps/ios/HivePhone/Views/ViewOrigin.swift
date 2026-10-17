import Foundation

/// A community view's own origin in its web view (design §6.1): `hm-view://<label>/`, the label
/// being the view's id as a hostname, `@scope/name` written `scope--name`, as the view SDK's
/// `viewHost` writes it for the computer's own windows. What the view's page asks for there, and
/// only there, is one of the view's files; anything else is not found.
struct ViewOrigin: Hashable {
    static let scheme = "hm-view"

    /// What a hostname of a view's may hold: what a view's id may, `@` and `/` aside.
    private static let hostCharacters = Set("abcdefghijklmnopqrstuvwxyz0123456789-")

    let label: String

    /// None for an id no hostname can carry: not a view's.
    init?(id: String) {
        var label = id
        if label.hasPrefix("@") {
            label.removeFirst()
            if let slash = label.firstIndex(of: "/") {
                label.replaceSubrange(slash...slash, with: "--")
            }
        }
        guard (1...63).contains(label.count), label.allSatisfy({ Self.hostCharacters.contains($0) }) else {
            return nil
        }
        self.label = label
    }

    /// Where `path` in the view is, its page among them.
    func url(of path: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = Self.scheme
        parts.host = label
        parts.path = "/" + path
        return parts.url
    }

    /// The path in the view that `url` asks for: none when it is not on this view's origin, or
    /// names no file inside the view.
    func path(of url: URL) -> String? {
        guard url.scheme?.lowercased() == Self.scheme,
              url.host(percentEncoded: false)?.lowercased() == label else { return nil }
        let path = url.path(percentEncoded: false)
        guard path.hasPrefix("/") else { return nil }
        let relative = String(path.dropFirst())
        let segments = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !relative.contains("\\"), !relative.contains("\0"),
              segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
        return relative
    }

    /// Whether a frame whose security origin is `scheme://host` is on this view's origin.
    func isOrigin(scheme: String, host: String) -> Bool {
        scheme.lowercased() == Self.scheme && host.lowercased() == label
    }

    /// What a request is answered.
    struct Served {
        let response: HTTPURLResponse
        let data: Data
    }

    /// What a request on the view's origin is answered: `file` as the device served it, under the
    /// policy it came with and never kept, with the headers the computer's own `hm-view` handler
    /// gives its windows; not found when there is no file.
    static func answer(_ url: URL, with file: ViewFile?) -> Served? {
        guard let file else {
            let headers = [
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Security-Policy": "default-src 'none'",
                "Cache-Control": "no-store",
            ]
            let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: headers)
            return response.map { Served(response: $0, data: Data()) }
        }
        let headers = [
            "Content-Type": file.mime,
            "Content-Security-Policy": file.csp,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Allow-Origin": "*",
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)
        return response.map { Served(response: $0, data: file.data) }
    }
}
