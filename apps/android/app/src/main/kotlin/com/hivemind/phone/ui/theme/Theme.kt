package com.hivemind.phone.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.hivemind.phone.R

// Neutral greyscale: colour is kept for what waits on the person, what failed, what is done and the
// lines of a diff. `surfaceContainer` is a raised card, `surfaceContainerHigh` a chosen chip or a
// pressed control, `outlineVariant` a hairline and `tertiary` the faintest text.
private val Light = lightColorScheme(
    primary = Color(0xFF171717),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEDEDED),
    onPrimaryContainer = Color(0xFF171717),
    secondary = Color(0xFF5D5D5D),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDEDED),
    onSecondaryContainer = Color(0xFF171717),
    tertiary = Color(0xFF8F8F8F),
    background = Color.White,
    onBackground = Color(0xFF171717),
    surface = Color.White,
    onSurface = Color(0xFF171717),
    surfaceVariant = Color(0xFFEDEDED),
    onSurfaceVariant = Color(0xFF5D5D5D),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF7F7F7),
    surfaceContainer = Color(0xFFF7F7F7),
    surfaceContainerHigh = Color(0xFFEDEDED),
    surfaceContainerHighest = Color(0xFFEDEDED),
    outline = Color(0xFFD4D4D4),
    outlineVariant = Color(0xFFE5E5E5),
    error = Color(0xFFD73A49),
    errorContainer = Color(0xFFFBE4E6),
    onErrorContainer = Color(0xFF171717),
    inverseSurface = Color(0xFF171717),
    inverseOnSurface = Color(0xFFF4F4F4),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFF4F4F4),
    onPrimary = Color(0xFF171717),
    primaryContainer = Color(0xFF2B2B2B),
    onPrimaryContainer = Color(0xFFF4F4F4),
    secondary = Color(0xFFA3A3A3),
    onSecondary = Color(0xFF171717),
    secondaryContainer = Color(0xFF2B2B2B),
    onSecondaryContainer = Color(0xFFF4F4F4),
    tertiary = Color(0xFF6E6E6E),
    background = Color(0xFF191919),
    onBackground = Color(0xFFF4F4F4),
    surface = Color(0xFF191919),
    onSurface = Color(0xFFF4F4F4),
    surfaceVariant = Color(0xFF2B2B2B),
    onSurfaceVariant = Color(0xFFA3A3A3),
    surfaceContainerLowest = Color(0xFF191919),
    surfaceContainerLow = Color(0xFF212121),
    surfaceContainer = Color(0xFF212121),
    surfaceContainerHigh = Color(0xFF2B2B2B),
    surfaceContainerHighest = Color(0xFF2B2B2B),
    outline = Color(0xFF3D3D3D),
    outlineVariant = Color(0xFF2E2E2E),
    error = Color(0xFFF0707B),
    errorContainer = Color(0xFF3A2224),
    onErrorContainer = Color(0xFFF4F4F4),
    inverseSurface = Color(0xFFF4F4F4),
    inverseOnSurface = Color(0xFF171717),
)

/** The colours of an agent's state: what waits on the person is the one warm thing on screen. */
@Immutable
data class StateColors(val waiting: Color, val working: Color, val done: Color, val failed: Color, val quiet: Color)

private val LightStates = StateColors(
    waiting = Color(0xFFB26A00),
    working = Color(0xFF171717),
    done = Color(0xFF258B20),
    failed = Color(0xFFD73A49),
    quiet = Color(0xFF8F8F8F),
)

private val DarkStates = StateColors(
    waiting = Color(0xFFE8A64A),
    working = Color(0xFFF4F4F4),
    done = Color(0xFF5FBF57),
    failed = Color(0xFFF0707B),
    quiet = Color(0xFF6E6E6E),
)

val LocalStateColors = staticCompositionLocalOf { DarkStates }

/** The person's own colour, once known: their dot, and the accent the community views are given. */
val LocalPersonColor = staticCompositionLocalOf<Color?> { null }

val Sans = FontFamily(
    Font(R.font.geist_400, FontWeight.Normal),
    Font(R.font.geist_500, FontWeight.Medium),
    Font(R.font.geist_600, FontWeight.SemiBold),
)

val Mono = FontFamily(Font(R.font.jetbrains_mono_400, FontWeight.Normal))

private fun TextStyle.sans(weight: FontWeight, tight: Boolean = false) =
    copy(fontFamily = Sans, fontWeight = weight, letterSpacing = if (tight) (-0.02).em else 0.em)

private val Type = Typography().run {
    copy(
        displayLarge = displayLarge.sans(FontWeight.SemiBold, tight = true),
        displayMedium = displayMedium.sans(FontWeight.SemiBold, tight = true),
        displaySmall = displaySmall.sans(FontWeight.SemiBold, tight = true),
        headlineLarge = headlineLarge.sans(FontWeight.SemiBold, tight = true),
        headlineMedium = headlineMedium.sans(FontWeight.SemiBold, tight = true),
        headlineSmall = headlineSmall.sans(FontWeight.SemiBold, tight = true),
        titleLarge = titleLarge.sans(FontWeight.SemiBold, tight = true),
        titleMedium = titleMedium.sans(FontWeight.SemiBold, tight = true),
        titleSmall = titleSmall.sans(FontWeight.SemiBold),
        bodyLarge = bodyLarge.sans(FontWeight.Normal),
        bodyMedium = bodyMedium.sans(FontWeight.Normal),
        bodySmall = bodySmall.sans(FontWeight.Normal),
        labelLarge = labelLarge.sans(FontWeight.Medium),
        labelMedium = labelMedium.sans(FontWeight.Medium),
        labelSmall = labelSmall.sans(FontWeight.Medium),
    )
}

/** Pills for buttons and chips; rounder cards, sheets and the composer. */
private val Shape = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(percent = 50),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/**
 * Material 3, light or dark as the phone is. [accent] is the person's own colour, once known: it
 * marks only what is theirs, never the app's controls.
 */
@Composable
fun PhoneTheme(accent: Color?, content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    MaterialTheme(colorScheme = if (dark) Dark else Light, typography = Type, shapes = Shape) {
        CompositionLocalProvider(
            LocalStateColors provides if (dark) DarkStates else LightStates,
            LocalPersonColor provides accent?.let { readable(it, dark) },
            content = content,
        )
    }
}

// A colour as the person chose it may sit too close to the background to read: a dark one is
// lifted on a dark theme, a pale one deepened on a light theme.
private fun readable(accent: Color, dark: Boolean): Color = when {
    dark && accent.luminance() < 0.25f -> lerp(accent, Color.White, 0.45f)
    !dark && accent.luminance() > 0.6f -> lerp(accent, Color.Black, 0.35f)
    else -> accent
}

/** The person's colour, as `Person.color` gives it (`#rrggbb`); null for none or anything else. */
fun personColor(hex: String?): Color? {
    if (hex == null || hex.length != 7 || hex[0] != '#') return null
    val digits = hex.substring(1)
    if (!digits.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
    return Color(0xFF000000 or digits.toLong(16))
}
