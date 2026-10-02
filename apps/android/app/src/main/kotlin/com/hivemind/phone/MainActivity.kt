package com.hivemind.phone

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.push.openedOn
import com.hivemind.phone.ui.PhoneNav
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.PhoneLock
import com.hivemind.phone.ui.theme.PhoneTheme
import com.hivemind.phone.ui.theme.personColor
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * The one activity: the app's screens, in the person's colour once the phone knows it; opened on an
 * agent's screen by a notification about it.
 */
class MainActivity : FragmentActivity() {
    private var frames: FrameMeter? = null

    /** The agents notifications opened the app on, the newest kept until the screens take it. */
    private val opens = Channel<AgentRef>(Channel.CONFLATED)

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val lock = PhoneLock(this)
        // UI tests (Maestro) find the app's controls by their test tags.
        val tagged = Modifier.semantics { testTagsAsResourceId = true }
        when (val opened = (application as PhoneApp).core) {
            is PhoneApp.Opened.Ready -> setContent {
                val feed = opened.core.feed
                val colour by remember(feed) { feed.overview.map { it.person?.color }.distinctUntilChanged() }
                    .collectAsStateWithLifecycle(feed.overview.value.person?.color)
                PhoneTheme(accent = personColor(colour)) {
                    CompositionLocalProvider(LocalPhoneLock provides lock) {
                        Surface(tagged.fillMaxSize()) { PhoneNav(opened.core, remember { opens.receiveAsFlow() }) }
                    }
                }
            }
            is PhoneApp.Opened.Broken -> setContent {
                PhoneTheme(accent = null) {
                    Surface(tagged.fillMaxSize()) {
                        Text(stringResource(R.string.core_broken, opened.reason), Modifier.padding(24.dp))
                    }
                }
            }
        }
        frames = FrameMeter(this)
        // Restored, the screens are as they were: the intent that first opened it is not opened again.
        if (savedInstanceState == null) opened(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        opened(intent)
    }

    private fun opened(intent: Intent?) {
        openedOn(intent)?.let { opens.trySend(it) }
    }
}
