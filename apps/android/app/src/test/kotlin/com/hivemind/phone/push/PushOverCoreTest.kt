package com.hivemind.phone.push

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.PhoneApp
import com.hivemind.phone.ui.devices.PushCard
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.File

/**
 * Where the devices tell the phone, given over the real core: the app's own, as PhoneApp opens it
 * in the process, the facade built for this machine and loaded through the generated bindings.
 */
@RunWith(AndroidJUnit4::class)
@Config(application = PhoneApp::class, qualifiers = "mdpi")
class PushOverCoreTest {
    @get:Rule
    val compose = createComposeRule()

    private val app = ApplicationProvider.getApplicationContext<PhoneApp>()
    private val core = (app.core as PhoneApp.Opened.Ready).core

    @Test
    fun `when the core cannot give the devices the new endpoint, Devices says why and offers to try again`() {
        // What the phone keeps is gone from under it: its push keys can be neither read nor made.
        File(app.filesDir, "core").deleteRecursively()
        compose.setContent {
            val state by core.push.state.collectAsState()
            PushCard(state, onChoose = {}, onAgain = {})
        }

        core.push.newEndpoint("https://ntfy.example.net/upPriya")

        val until = System.nanoTime() + 30_000_000_000
        while (core.push.state.value !is PushState.NotTold && System.nanoTime() < until) Thread.sleep(10)
        val state = core.push.state.value
        assertTrue("$state", state is PushState.NotTold && state.why.isNotBlank())
        compose.onNodeWithText("Your devices were not told where to reach this phone: ${(state as PushState.NotTold).why}").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertIsDisplayed()
    }
}
