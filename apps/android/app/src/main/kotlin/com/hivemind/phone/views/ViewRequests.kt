package com.hivemind.phone.views

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.hivemind.phone.core.ViewFile
import java.io.ByteArrayInputStream

/**
 * What the web view showing a view is answered for [request] (design §6.1): a GET of a file on the
 * view's own [site] is that file as the computer serves it to its own windows ([file]: the SDK, the
 * page made for a script entry and the import map among them), under the Content-Security-Policy it
 * comes with and kept by no cache; anything else, and a file the computer will not give, is a 404.
 * Never null: a request left unanswered would go to the network.
 *
 * The web view asks off the main thread, so [file] may wait on the core.
 */
fun answer(request: WebResourceRequest, site: ViewSite, file: (path: String) -> ViewFile): WebResourceResponse {
    val path = pathOf(request, site) ?: return notFound()
    val served = try {
        file(path)
    } catch (e: Exception) {
        // The core's no (not paired, the computer away, no such file), or anything it threw: the
        // page is answered all the same.
        return notFound()
    }
    val (type, charset) = typeOf(served.mime)
    val headers = mapOf("Content-Security-Policy" to served.csp, "Cache-Control" to "no-store")
    return WebResourceResponse(type, charset, 200, "OK", headers, ByteArrayInputStream(served.data))
}

/** The file of the view [request] asks for, by its path in the view's folder: a GET on the view's
 *  own origin, of a path that stays inside it; null for anything else. */
private fun pathOf(request: WebResourceRequest, site: ViewSite): String? {
    if (request.method != "GET") return null
    val url = request.url
    if (url.scheme != "https" || url.host != site.host || url.port != -1) return null
    val path = url.path?.removePrefix("/") ?: return null
    if (path.isEmpty() || path.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
    return path
}

/** A file's type as a web resource response takes it, apart from its charset: `text/html;
 *  charset=utf-8` is `text/html` in `utf-8`. */
private fun typeOf(mime: String): Pair<String, String?> {
    val parts = mime.split(';').map { it.trim() }
    val charset = parts.drop(1).firstNotNullOfOrNull { parameter ->
        val (name, value) = parameter.split('=', limit = 2).takeIf { it.size == 2 } ?: return@firstNotNullOfOrNull null
        value.trim().trim('"').takeIf { name.trim().equals("charset", ignoreCase = true) && it.isNotEmpty() }
    }
    return parts.first().ifEmpty { "application/octet-stream" } to charset
}

private fun notFound() =
    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
