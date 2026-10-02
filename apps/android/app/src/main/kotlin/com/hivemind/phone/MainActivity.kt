package com.hivemind.phone

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
import com.hivemind.phone.ui.PhoneNav
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.PhoneLock
import com.hivemind.phone.ui.theme.PhoneTheme
import com.hivemind.phone.ui.theme.personColor
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/** The one activity: the app's screens, in the person's colour once the phone knows it. */
class MainActivity : FragmentActivity() {
    private var frames: FrameMeter? = null

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
                        Surface(tagged.fillMaxSize()) { PhoneNav(opened.core) }
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
    }
}
