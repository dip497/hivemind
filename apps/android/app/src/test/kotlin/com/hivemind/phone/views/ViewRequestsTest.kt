package com.hivemind.phone.views

import android.net.Uri
import android.webkit.WebResourceRequest
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.core.PhoneException
import com.hivemind.phone.core.ViewFile
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What a view's web view is answered (design §6.1): its files, as the computer serves them, on its
 * own origin and nothing else; never left to the network.
 */
@RunWith(AndroidJUnit4::class)
class ViewRequestsTest {
    private val site = ViewSite.of("phone-probe")!!
    private val csp = "default-src 'none'; script-src 'self' hm-view: 'nonce-n0nce' 'wasm-unsafe-eval'"

    private fun request(url: String, method: String = "GET") = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = method
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    @Test
    fun `a file on the view's own origin is the computer's, under the policy it comes with, kept by no cache`() {
        val asked = mutableListOf<String>()
        val files = mapOf(
            "__entry.html" to ViewFile("<!doctype html><p>board</p>".toByteArray(), "text/html; charset=utf-8", csp),
            "art/board.json" to ViewFile("{}".toByteArray(), "application/json", csp),
        )
        val file = { path: String -> files.getValue(path.also { asked += it }) }

        val page = answer(request("https://phone-probe.views.hivemind.invalid/__entry.html?js=main.js"), site, file)
        val json = answer(request("https://phone-probe.views.hivemind.invalid/art/board.json"), site, file)

        assertEquals(listOf("__entry.html", "art/board.json"), asked)
        assertEquals(
            listOf(200, "OK", "text/html", "utf-8", mapOf("Content-Security-Policy" to csp, "Cache-Control" to "no-store"), "<!doctype html><p>board</p>"),
            listOf(page.statusCode, page.reasonPhrase, page.mimeType, page.encoding, page.responseHeaders, page.data.readBytes().decodeToString()),
        )
        assertEquals(listOf("application/json", null, "{}"), listOf(json.mimeType, json.encoding, json.data.readBytes().decodeToString()))
    }

    @Test
    fun `anything else is answered not found, the computer never asked, another origin, scheme or method, a path out of the view`() {
        val asked = mutableListOf<String>()
        val file = { path: String -> asked += path; ViewFile(ByteArray(0), "text/plain", csp) }
        val requests = listOf(
            request("https://other.views.hivemind.invalid/__sdk.js"),
            request("https://example.com/__sdk.js"),
            request("http://phone-probe.views.hivemind.invalid/__sdk.js"),
            request("https://phone-probe.views.hivemind.invalid:8443/__sdk.js"),
            request("https://phone-probe.views.hivemind.invalid/__sdk.js", method = "POST"),
            request("https://phone-probe.views.hivemind.invalid/art/%2e%2e/%2e%2e/secret"),
            request("https://phone-probe.views.hivemind.invalid/"),
            request("data:text/html,<p>elsewhere</p>"),
        )

        val answered = requests.map { answer(it, site, file).statusCode }

        assertEquals(List(requests.size) { 404 }, answered)
        assertEquals(emptyList<String>(), asked)
    }

    @Test
    fun `a file the computer will not give is not found`() {
        val refused = answer(request("https://phone-probe.views.hivemind.invalid/missing.js"), site) {
            throw PhoneException.Refused("phone-probe has no file missing.js")
        }

        assertEquals(404, refused.statusCode)
    }
}
