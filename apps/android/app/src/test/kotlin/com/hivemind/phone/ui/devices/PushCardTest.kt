package com.hivemind.phone.ui.devices

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.core.PushRefused
import com.hivemind.phone.core.PushTold
import com.hivemind.phone.push.PushState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** How Devices says the phone is told while the app is away (P6), from records built here. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "mdpi")
class PushCardTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `told, it says how, who took it, who was away, who said no and why, and why the push server would not`() {
        val told = PushTold(
            via = null,
            told = listOf("desk", "host"),
            away = listOf("laptop"),
            refused = listOf(PushRefused(device = "attic", why = "this device tells nobody")),
            unregistered = "an address it does not post to",
        )
        compose.setContent { PushCard(PushState.Told(told), onChoose = {}, onAgain = {}) }

        compose.onNodeWithText("Told directly by your devices.").assertIsDisplayed()
        compose.onNodeWithText(
            "Your network's push server would not take this phone (an address it does not post to): your devices tell it directly.",
        ).assertIsDisplayed()
        compose.onNodeWithText("desk, host will tell this phone what needs you.").assertIsDisplayed()
        compose.onNodeWithText("laptop: away, told when the app next opens.").assertIsDisplayed()
        compose.onNodeWithText("attic said no: this device tells nobody").assertIsDisplayed()
    }

    @Test
    fun `told through the network's push server, it names it`() {
        val told = PushTold(via = "https://push.example.net", told = listOf("desk"), away = emptyList(), unregistered = null)
        compose.setContent { PushCard(PushState.Told(told), onChoose = {}, onAgain = {}) }

        compose.onNodeWithText("Told through https://push.example.net.").assertIsDisplayed()
        compose.onNodeWithText("Told directly by your devices.").assertDoesNotExist()
    }

    @Test
    fun `with several distributors it offers the system's choice, and with none it says to install one`() {
        var chose = 0
        var state: PushState by mutableStateOf(PushState.ToChoose)
        compose.setContent { PushCard(state, onChoose = { chose++ }, onAgain = {}) }
        compose.onNodeWithText("Choose").performClick()
        assertEquals(1, chose)

        state = PushState.NoDistributor
        compose.onNodeWithText(
            "No UnifiedPush distributor on this phone: install one (ntfy, for instance) to be told what needs you while the app is closed.",
        ).assertIsDisplayed()
        compose.onNodeWithText("Choose").assertDoesNotExist()
    }
}
