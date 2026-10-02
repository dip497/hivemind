package com.hivemind.phone.views

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import com.hivemind.phone.R
import com.hivemind.phone.core.Screen
import com.hivemind.phone.core.ViewFile
import com.hivemind.phone.core.viewBridge
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.theme.LocalStateColors
import com.hivemind.phone.ui.theme.viewTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.math.roundToInt

/** Whether this phone's web view can show views: started, and with what joins a page to the app. */
private enum class WebViewHere { STARTING, READY, TOO_OLD, BROKEN }

/**
 * A community view's page (design §6.1), filling [modifier]: its [page] loaded from its [site] in a
 * web view of its own, the files the computer serves ([files]), the page joined to its host through
 * [relay], on the screen it fills, in the app's look; behind it, the look's background, so the page
 * never flashes white. A new web view, and so a new session, when the one there loses its renderer.
 * [name] is the view's, for the phone's lock.
 */
@Composable
fun ViewPage(relay: ViewRelay, site: ViewSite, page: String, name: String, files: (path: String) -> ViewFile, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var here by remember { mutableStateOf(WebViewHere.STARTING) }
    LaunchedEffect(Unit) { here = startWebView(context) }
    val background = MaterialTheme.colorScheme.background
    val theme = viewTheme(MaterialTheme.colorScheme, LocalStateColors.current, isSystemInDarkTheme())
    val lock = LocalPhoneLock.current
    val lockTitle = stringResource(R.string.lock_view_title)
    val lockSubtitle = stringResource(R.string.lock_view_subtitle, name)
    Box(modifier.background(background)) {
        when (here) {
            WebViewHere.STARTING -> Unit
            WebViewHere.TOO_OLD -> Note(stringResource(R.string.view_too_old))
            WebViewHere.BROKEN -> Note(stringResource(R.string.view_no_webview))
            WebViewHere.READY -> BoxWithConstraints(Modifier.fillMaxSize()) {
                // The web view fills this box: its size in dp is the page's in CSS pixels.
                val screen = Screen(maxWidth.value.roundToInt().toUInt(), maxHeight.value.roundToInt().toUInt(), theme)
                var renderers by remember { mutableIntStateOf(0) }
                key(renderers) {
                    AndroidView(
                        factory = { inside ->
                            val web = viewWebView(inside, site, page, files, background.toArgb(), relay, gone = { renderers++ }) { then ->
                                lock.ask(lockTitle, lockSubtitle, then)
                            }
                            relay.show(web.tag as ViewRelay.Shown, screen)
                            web
                        },
                        onRelease = { web ->
                            relay.hide(web.tag as ViewRelay.Shown)
                            web.destroy()
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                // Turned, the keyboard up or down, the window split, the look changed.
                SideEffect { relay.screen(screen) }
            }
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(text, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * Starts this process's web view off the main thread, as far as it can be; then whether it joins a
 * page to the app as views need: a web message listener, and a script run at the start of each page.
 */
private suspend fun startWebView(context: Context): WebViewHere = suspendCancellableCoroutine { done ->
    val config = WebViewStartUpConfig.Builder(Dispatchers.Default.asExecutor()).build()
    WebViewCompat.startUpWebView(
        context.applicationContext,
        config,
        object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
            override fun onResult(result: WebViewStartUpResult) {
                val joins = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
                    WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
                done.resume(if (joins) WebViewHere.READY else WebViewHere.TOO_OLD)
            }

            override fun onError(error: WebViewStartupException) {
                done.resume(WebViewHere.BROKEN)
            }
        },
    )
}

/**
 * A web view for the view at [site], locked down: scripts for its page and nothing else of the
 * platform's (no files, no content, no storage, no geolocation, no windows, no going elsewhere);
 * every request answered by the app ([answer]: no request reaches the network); the core's bridge
 * run at the start of each of the view's pages, posting through the `hive` web message listener,
 * which only the view's own origin is given, and nothing else of the app's in reach. Its tag is
 * how [relay] knows it: shown, it loads [page]; [lock] asks the phone's lock; [gone] is told when
 * its renderer went, and it cannot be used again.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun viewWebView(
    context: Context,
    site: ViewSite,
    page: String,
    files: (path: String) -> ViewFile,
    background: Int,
    relay: ViewRelay,
    gone: () -> Unit,
    lock: (then: () -> Unit) -> Boolean,
): WebView {
    // Inspected from a computer's Chrome only in a build made to debug.
    WebView.setWebContentsDebuggingEnabled(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
    val web = WebView(context)
    web.setBackgroundColor(background)
    web.settings.apply {
        javaScriptEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        // As in the computer's sandboxed frame: no storage.
        domStorageEnabled = false
        setGeolocationEnabled(false)
        setSupportMultipleWindows(false)
        javaScriptCanOpenWindowsAutomatically = false
        // Nothing a view loads is from the network, so there is nothing to look up for it there.
        safeBrowsingEnabled = false
    }
    val shown = ViewRelay.Shown(load = { web.loadUrl(site.url(page)) }, lock = lock)
    web.tag = shown
    web.webViewClient = object : WebViewClient() {
        // Off the main thread: waiting on the core here waits only for this file.
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
            answer(request, site, files)

        // The view goes nowhere: the app loads its page, and nothing else.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (url?.startsWith(site.origin + "/") == true) relay.started(shown)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            relay.hide(shown)
            gone()
            return true
        }
    }
    WebViewCompat.addWebMessageListener(web, "hive", setOf(site.origin)) { _, message, origin, mainFrame, proxy ->
        if (message.type == WebMessageCompat.TYPE_STRING && site.isTheView(origin, mainFrame)) {
            message.data?.let { text -> relay.posted(shown, text) { proxy.postMessage(it) } }
        }
    }
    WebViewCompat.addDocumentStartJavaScript(web, viewBridge(), setOf(site.origin))
    return web
}
