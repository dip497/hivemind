package com.hivemind.phone.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance

// Graphite, as the desktop's default theme (Signal): neutral, so the person's colour and what
// waits on them are what stands out.
private val Light = lightColorScheme(
    primary = Color(0xFF3B4250),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDDE1E8),
    onPrimaryContainer = Color(0xFF1A1E26),
    background = Color(0xFFF7F7F8),
    surface = Color(0xFFF7F7F8),
    surfaceContainer = Color(0xFFECEDF0),
    surfaceContainerHigh = Color(0xFFE5E6EA),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFC9CED6),
    onPrimary = Color(0xFF1A1C1F),
    primaryContainer = Color(0xFF33373E),
    onPrimaryContainer = Color(0xFFE6E7E9),
    background = Color(0xFF141518),
    surface = Color(0xFF141518),
    surfaceContainer = Color(0xFF1D1F23),
    surfaceContainerHigh = Color(0xFF25272C),
)

/** The colours of an agent's state: what waits on the person is the one warm thing on screen. */
@Immutable
data class StateColors(val waiting: Color, val working: Color, val done: Color, val failed: Color, val quiet: Color)

private val LightStates = StateColors(
    waiting = Color(0xFFB06E00),
    working = Color(0xFF1A1C1F),
    done = Color(0xFF3F7D55),
    failed = Color(0xFFB3473A),
    quiet = Color(0xFF6B6E72),
)

private val DarkStates = StateColors(
    waiting = Color(0xFFE6B45E),
    working = Color(0xFFF0F1F3),
    done = Color(0xFF8FB39A),
    failed = Color(0xFFDC8B80),
    quiet = Color(0xFF8E9197),
)

val LocalStateColors = staticCompositionLocalOf { DarkStates }

/** Material 3, light or dark as the phone is, with the person's colour as the accent once known. */
@Composable
fun PhoneTheme(accent: Color?, content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val base = if (dark) Dark else Light
    MaterialTheme(colorScheme = if (accent == null) base else base.accented(accent, dark)) {
        androidx.compose.runtime.CompositionLocalProvider(
            LocalStateColors provides if (dark) DarkStates else LightStates,
            content = content,
        )
    }
}

private fun ColorScheme.accented(accent: Color, dark: Boolean): ColorScheme {
    // A colour as the person chose it may sit too close to the background to read: a dark one is
    // lifted on a dark theme, a pale one deepened on a light theme.
    val shown = when {
        dark && accent.luminance() < 0.25f -> lerp(accent, Color.White, 0.45f)
        !dark && accent.luminance() > 0.6f -> lerp(accent, Color.Black, 0.35f)
        else -> accent
    }
    val on = if (shown.luminance() > 0.45f) Color(0xFF1A1C1F) else Color.White
    return copy(
        primary = shown,
        onPrimary = on,
        primaryContainer = lerp(background, shown, 0.22f),
        onPrimaryContainer = onBackground,
    )
}

/** The person's colour, as `Person.color` gives it (`#rrggbb`); null for none or anything else. */
fun personColor(hex: String?): Color? {
    if (hex == null || hex.length != 7 || hex[0] != '#') return null
    val digits = hex.substring(1)
    if (!digits.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
    return Color(0xFF000000 or digits.toLong(16))
}
