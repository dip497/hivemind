package com.hivemind.phone.ui.views

import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.R
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.ViewEnded
import com.hivemind.phone.core.ViewFile
import com.hivemind.phone.ui.common.CoreCalls
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.views.ViewPage
import com.hivemind.phone.views.ViewRelay
import com.hivemind.phone.views.ViewSite
import kotlinx.coroutines.runBlocking

/** A view, as the Views list opened it: on [workspace], from [device] (called [deviceName]). */
data class OpenView(val device: String, val deviceName: String, val workspace: String, val id: String, val name: String, val page: String)

/**
 * One view shown (design §6.1), for as long as its screen is in the back stack: its files from the
 * computer, and its session there, relayed.
 */
class ViewViewModel(private val phone: Phone, val view: OpenView) : ViewModel() {
    val calls = CoreCalls(viewModelScope)

    val relay = ViewRelay(
        open = { screen, told -> phone.openView(view.device, view.workspace, view.id, screen, told) },
        tell = calls::tell,
    )

    /** The view's file at [path], as its computer serves it: asked by the web view, off the main thread. */
    fun file(path: String): ViewFile = runBlocking { phone.viewFile(view.device, view.workspace, view.id, path) }

    override fun onCleared() = relay.stop()
}

/**
 * A view, full screen under a bar with its name and Back (design §6.1): its page fills the rest,
 * above the keyboard. Once it is shown no more (not restarting), why, in the app's words, in place
 * of the page.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ViewScreen(vm: ViewViewModel, onBack: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(vm.calls, snackbar)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(vm.view.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val inside = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()
        val site = ViewSite.of(vm.view.id)
        val ended = vm.relay.ended
        when {
            ended != null -> Text(
                endedText(ended, vm.view.deviceName),
                inside.padding(16.dp),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // Views lists only views whose ids make an origin.
            site != null -> ViewPage(vm.relay, site, vm.view.page, vm.view.name, vm::file, inside)
        }
    }
}

/** Why a view is shown no more, in the app's words: [device] is its computer's name. */
@Composable
private fun endedText(ended: ViewEnded, device: String): String = when (ended) {
    is ViewEnded.Disabled -> stringResource(R.string.view_disabled, device, ended.why)
    is ViewEnded.Refused -> stringResource(R.string.ended_refused, device, ended.why)
    ViewEnded.NotHeld -> stringResource(R.string.ended_not_held, device)
    ViewEnded.Unpaired -> stringResource(R.string.ended_unpaired, device)
    // Never told as an end: the page loads anew.
    ViewEnded.Restarting -> ""
}
