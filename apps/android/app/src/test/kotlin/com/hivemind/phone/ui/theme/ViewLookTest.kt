package com.hivemind.phone.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.R
import com.hivemind.phone.core.ThemeMode
import com.hivemind.phone.core.ViewTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The look a view is given on the phone (design §5.5): the app's own, by every token and status tone
 * the desktop gives its views, in colours the computer takes (`#rrggbb`), its page's background the
 * window's own, so nothing flashes white before it draws.
 */
@RunWith(AndroidJUnit4::class)
class ViewLookTest {
    @get:Rule
    val compose = createComposeRule()

    private val tokens = setOf("bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3", "line", "line2", "brand", "err", "ok", "warn", "info", "accent")
    private val tones = setOf("working", "attention", "done", "idle", "exited", "failed")
    private val colour = Regex("^#[0-9a-fA-F]{6}$")

    private fun look(accent: Color?): ViewTheme {
        var theme: ViewTheme? = null
        compose.setContent {
            PhoneTheme(accent) { theme = viewTheme(MaterialTheme.colorScheme, LocalStateColors.current, isSystemInDarkTheme()) }
        }
        compose.waitForIdle()
        return theme!!
    }

    /** What a look must hold for the computer to take it and the page to sit on the window's own background. */
    private fun told(theme: ViewTheme, window: Int): List<Any?> {
        val colours = theme.colors.values + theme.status.values + listOfNotNull(theme.accent, theme.surface, theme.terminalBackground)
        val background = "#%06x".format(ApplicationProvider.getApplicationContext<android.content.Context>().getColor(window) and 0xFFFFFF)
        return listOf(theme.colors.keys, theme.status.keys, colours.filterNot(colour::matches), theme.colors["bg"] == background)
    }

    @Test
    fun `light, the person's colour its accent`() {
        val theme = look(accent = Color(0xFF3A7BD5))

        assertEquals(listOf(tokens, tones, emptyList<String>(), true), told(theme, R.color.window_light))
        assertEquals(listOf(ThemeMode.LIGHT, "#3a7bd5", "#3a7bd5"), listOf(theme.mode, theme.accent, theme.colors["brand"]))
    }

    @Test
    @Config(qualifiers = "night")
    fun `dark, as the phone is`() {
        val theme = look(accent = null)

        assertEquals(listOf(tokens, tones, emptyList<String>(), true), told(theme, R.color.window_dark))
        assertEquals(ThemeMode.DARK, theme.mode)
    }
}
