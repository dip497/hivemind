import XCTest
@testable import HivePhone

/// A community view's own origin in its web view (design §6.1): the hostname its id is written as,
/// which requests are the view's files, and what each is answered.
final class ViewOriginTests: XCTestCase {
    func testAViewsOriginIsItsIdWrittenAsAHostnameAsTheComputersWindowsWriteIt() throws {
        XCTAssertEqual(ViewOrigin(id: "board")?.label, "board")
        XCTAssertEqual(ViewOrigin(id: "@priya/phone-board")?.label, "priya--phone-board")
        XCTAssertEqual(
            try XCTUnwrap(ViewOrigin(id: "@priya/phone-board")).url(of: "__entry.html"),
            URL(string: "hm-view://priya--phone-board/__entry.html"))
        // No hostname carries these: there is no origin to show them on.
        for id in ["", "Board", "@priya/board/x", "board.example.com", String(repeating: "a", count: 64)] {
            XCTAssertNil(ViewOrigin(id: id), id)
        }
    }

    func testARequestIsOneOfTheViewsFilesOnlyOnItsOwnOriginAndInsideIt() throws {
        let origin = try XCTUnwrap(ViewOrigin(id: "@priya/board"))
        let cases: [(String, String?)] = [
            ("hm-view://priya--board/index.html", "index.html"),
            ("hm-view://priya--board/assets/app.js?v=2#top", "assets/app.js"),
            ("hm-view://priya--board/fonts/Inter%20Bold.woff2", "fonts/Inter Bold.woff2"),
            // Another view's origin, another scheme, no file, or out of the view.
            ("hm-view://board/index.html", nil),
            ("https://priya--board/index.html", nil),
            ("hm-view://priya--board/", nil),
            ("hm-view://priya--board/../index.html", nil),
            ("hm-view://priya--board/assets/%2E%2E/%2E%2E/secret", nil),
        ]
        for (url, path) in cases {
            XCTAssertEqual(origin.path(of: try XCTUnwrap(URL(string: url))), path, url)
        }
    }

    func testAFileIsServedUnderThePolicyItCameWithAndNeverKeptAndAnythingElseIsNotFound() throws {
        let url = try XCTUnwrap(URL(string: "hm-view://priya--board/index.html"))
        let csp = "default-src 'none'; script-src 'self' hm-view: 'nonce-bm9uY2U=' 'wasm-unsafe-eval'"
        let page = ViewFile(data: Data("<p>On a phone</p>".utf8), mime: "text/html; charset=utf-8", csp: csp)

        let served = try XCTUnwrap(ViewOrigin.answer(url, with: page))

        XCTAssertEqual(served.response.statusCode, 200)
        XCTAssertEqual(served.response.value(forHTTPHeaderField: "Content-Type"), "text/html; charset=utf-8")
        XCTAssertEqual(served.response.value(forHTTPHeaderField: "Content-Security-Policy"), csp)
        XCTAssertEqual(served.response.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        XCTAssertEqual(served.data, page.data)

        // What the computer did not serve: a phone error, or a request not the view's.
        let missing = try XCTUnwrap(ViewOrigin.answer(url, with: nil))
        XCTAssertEqual(missing.response.statusCode, 404)
        XCTAssertEqual(missing.data, Data())
    }
}
