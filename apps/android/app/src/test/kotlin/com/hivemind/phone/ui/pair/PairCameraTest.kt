package com.hivemind.phone.ui.pair

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.core.Phone
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Pair on a device with no camera to open (an emulator started without one, a Chromebook, some
 * tablets): the app installs there, the camera being optional, so Pair offers the link to paste and
 * never crashes reaching for a camera.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "mdpi")
class PairCameraTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val dir = TemporaryFolder()

    private val app = ApplicationProvider.getApplicationContext<Application>()

    private val unavailable = "The camera can't be opened here. Paste the link instead."

    private fun pair(features: List<String>, cameraAllowed: Boolean) {
        val packages = shadowOf(app.packageManager)
        for (feature in listOf(PackageManager.FEATURE_CAMERA_ANY, PackageManager.FEATURE_CAMERA)) {
            packages.setSystemFeature(feature, feature in features)
        }
        if (cameraAllowed) shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
        val pairing = PairViewModel(Phone.open(dir.root.path, "Priya's Pixel"))
        compose.setContent { PairScreen(pairing, onDone = {}) }
    }

    private fun waitToBeTold() = compose.waitUntil(30_000) {
        compose.onAllNodesWithText(unavailable).fetchSemanticsNodes().isNotEmpty()
    }

    @Test
    fun `with no camera, Pair offers neither the camera nor its permission, only the link to paste`() {
        pair(features = emptyList(), cameraAllowed = false)

        compose.onNodeWithText("Use the camera").assertDoesNotExist()
        compose.onNodeWithTag("pair-camera").assertDoesNotExist()
        compose.onNodeWithTag("pair-link").assertIsDisplayed()
        compose.onNodeWithTag("pair-button").assertIsDisplayed()
    }

    @Test
    fun `CameraX finding neither a back camera nor a front one, Pair says so, and the link is pasted instead`() {
        // A camera said to be there, every permission granted as Maestro's launchApp grants them,
        // and none for CameraX to open. (CameraX failing to start at all, as on the CI emulator, is
        // the emulator smoke's to show: under Robolectric it starts, or fails, as it pleases.)
        pair(features = listOf(PackageManager.FEATURE_CAMERA_ANY), cameraAllowed = true)

        waitToBeTold()
        compose.onNodeWithTag("pair-camera").assertDoesNotExist()
        compose.onNodeWithTag("pair-link").assertIsDisplayed()
    }
}
