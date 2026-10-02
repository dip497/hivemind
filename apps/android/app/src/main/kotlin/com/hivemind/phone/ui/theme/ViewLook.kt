package com.hivemind.phone.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.hivemind.phone.core.ThemeMode
import com.hivemind.phone.core.ViewFonts
import com.hivemind.phone.core.ViewTheme
import com.hivemind.phone.terminal.TermPalette
import java.util.Locale

/**
 * The look a community view is given on this phone (design §5.5): the app's own, [colors] and
 * [states] as the app draws itself, dark or light as the phone is, named by the tokens the desktop
 * gives its views (bg…bg4 from the page up to raised panels, fg…fg3 from text to faint text, the
 * lines, the accent, and what is ok, a warning, an error or news), with a colour for each status
 * tone, as the desktop's own meanings have them (attention is what waits on the person). Every
 * colour `#rrggbb`: the computer refuses anything else.
 */
fun viewTheme(colors: ColorScheme, states: StateColors, dark: Boolean): ViewTheme = ViewTheme(
    mode = if (dark) ThemeMode.DARK else ThemeMode.LIGHT,
    colors = mapOf(
        "bg" to colors.background,
        "bg2" to colors.surfaceContainer,
        "bg3" to colors.surfaceContainerHigh,
        "bg4" to colors.surfaceContainerHighest,
        "fg" to colors.onSurface,
        "fg2" to colors.onSurfaceVariant,
        "fg3" to states.quiet,
        "line" to colors.outlineVariant,
        "line2" to colors.outline,
        "brand" to colors.primary,
        "accent" to colors.primary,
        "err" to colors.error,
        "ok" to states.done,
        "warn" to states.waiting,
        "info" to colors.primary,
    ).mapValues { hex(it.value) },
    accent = hex(colors.primary),
    // Material's medium shape: the app's cards and fields.
    radius = 12u,
    fonts = ViewFonts(ui = "sans-serif", mono = "monospace"),
    surface = hex(colors.surfaceContainer),
    terminalBackground = hex(Color(TermPalette.SIGNAL.background)),
    glass = false,
    status = mapOf(
        "working" to states.working,
        "attention" to states.waiting,
        "done" to states.done,
        "idle" to states.quiet,
        "exited" to states.quiet,
        "failed" to states.failed,
    ).mapValues { hex(it.value) },
)

/** [color] as `#rrggbb`, in sRGB, over nothing: its alpha left out. */
private fun hex(color: Color): String = String.format(Locale.ROOT, "#%06x", color.toArgb() and 0xFFFFFF)
