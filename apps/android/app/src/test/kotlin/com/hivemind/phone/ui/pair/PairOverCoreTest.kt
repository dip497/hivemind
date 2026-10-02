package com.hivemind.phone.ui.pair

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.core.Phone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File

/**
 * Pairing over the real core: the facade as scripts/phone/build-android.sh builds it for this
 * machine, loaded through the generated bindings, as the app loads it on a phone.
 */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalCoroutinesApi::class)
class PairOverCoreTest {
    @get:Rule
    val dir = TemporaryFolder()

    // The view model's calls run as on a phone's main thread: one at a time, off the test's own.
    @Before
    fun main() = Dispatchers.setMain(Dispatchers.Default.limitedParallelism(1))

    @After
    fun reset() = Dispatchers.resetMain()

    private fun pairing() = PairViewModel(Phone.open(dir.root.path, "Priya's Pixel"))

    private suspend fun PairViewModel.settled(): PairState {
        withTimeout(30_000) { while (state is PairState.Pairing) delay(10) }
        return state
    }

    @Test
    fun `a pasted link that is not one is refused, in the core's words`() = runBlocking {
        val pairing = pairing()

        pairing.pair("not a link")

        val state = pairing.settled()
        assertTrue("$state", state is PairState.Failed && state.message.isNotBlank())
    }

    @Test
    fun `a code the camera reads that is no pairing link is passed over`() {
        val pairing = pairing()

        pairing.scanned("https://example.com/menu")

        assertEquals(PairState.Ready, pairing.state)
    }

    @Test
    fun `while it pairs it names the computer the link is for`() = runBlocking {
        // conformance/pairing.json's link to "Desk" with no address and no relay: one that names
        // its computer, and reaches nothing.
        val cases = JSONObject(File("../../../conformance/pairing.json").readText()).getJSONArray("link")
        val case = (0 until cases.length()).map { cases.getJSONObject(it) }.single { it.getString("about") == "no addresses and no relay" }
        val pairing = pairing()

        pairing.pair(case.getString("text"))

        assertEquals("Desk", (pairing.state as PairState.Pairing).with?.name)
        val state = pairing.settled()
        assertTrue("$state", state is PairState.Failed && state.message.isNotBlank())
    }
}
