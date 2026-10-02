package com.hivemind.phone.terminal

import android.graphics.Typeface
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp

private const val MAX_ZOOM = 6f

/**
 * An agent's live terminal: fitted to the width at first, pinched to zoom, following the newest
 * line until the person scrolls up. Lines are drawn one by one, in a lazy list keyed by their
 * index, so a line that changes redraws alone and one that scrolls keeps its place.
 */
@Composable
fun TerminalView(terminal: Terminal, modifier: Modifier = Modifier) {
    val palette = TermPalette.SIGNAL
    val fonts = LocalFontFamilyResolver.current
    val painter = remember(fonts) {
        val face = { weight: FontWeight, style: FontStyle ->
            fonts.resolve(FontFamily.Monospace, weight, style).value as Typeface
        }
        TerminalPainter(
            listOf(
                face(FontWeight.Normal, FontStyle.Normal),
                face(FontWeight.Bold, FontStyle.Normal),
                face(FontWeight.Normal, FontStyle.Italic),
                face(FontWeight.Bold, FontStyle.Italic),
            ),
            palette,
        )
    }
    var zoom by rememberSaveable { mutableFloatStateOf(1f) }
    val across = rememberScrollState()
    val density = LocalDensity.current

    // The person scrolling up stops the view following the newest line; being back at the bottom,
    // after a drag or a fling, starts it again.
    val dragged by terminal.list.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(dragged) {
        if (dragged) terminal.following = false else if (!terminal.list.canScrollForward) terminal.following = true
    }
    LaunchedEffect(terminal) {
        snapshotFlow { terminal.list.canScrollForward }.collect { more -> if (!more) terminal.following = true }
    }

    BoxWithConstraints(
        modifier
            .background(Color(palette.background))
            .clipToBounds()
            .pinch(terminal) { factor, centroidX ->
                val next = (zoom * factor).coerceIn(1f, MAX_ZOOM)
                val applied = next / zoom
                zoom = next
                // The point between the fingers stays where it is, across.
                across.dispatchRawDelta((across.value + centroidX) * applied - centroidX - across.value)
                if (terminal.following && terminal.lineCount > 0) terminal.list.requestScrollToItem(terminal.lineCount - 1)
            },
    ) {
        val cols = terminal.cols.coerceAtLeast(1)
        val viewport = constraints.maxWidth.toFloat()
        val cells = remember(painter, viewport, cols, zoom) { painter.cells(viewport * zoom / cols) }
        val width = with(density) { (cells.width * cols).toDp() }
        val lineHeight = with(density) { cells.height.toDp() }
        Box(Modifier.fillMaxSize().horizontalScroll(across)) {
            LazyColumn(state = terminal.list, modifier = Modifier.width(width).fillMaxHeight()) {
                items(count = terminal.lineCount, key = { terminal.firstLine + it }) { position ->
                    TerminalLine(terminal.slot(position), painter, cells, lineHeight)
                }
            }
        }
    }
}

@Composable
private fun TerminalLine(slot: LineSlot, painter: TerminalPainter, cells: Cells, height: Dp) {
    // The slot is read while drawing, not composing: a changed line costs a redraw, nothing more.
    Spacer(
        Modifier
            .fillMaxWidth()
            .height(height)
            .drawBehind { painter.draw(drawContext.canvas.nativeCanvas, slot.line, slot.cursor, cells) },
    )
}

/**
 * Two fingers zoom; one still scrolls. The pinch is taken before the list sees it, so the list
 * does not scroll while the fingers spread.
 */
private fun Modifier.pinch(key: Any, onZoom: (factor: Float, centroidX: Float) -> Unit): Modifier = this.then(
    Modifier.pointerInput(key) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (event.changes.count { it.pressed } >= 2) {
                    val factor = event.calculateZoom()
                    if (factor != 1f) {
                        onZoom(factor, event.calculateCentroid(useCurrent = true).x)
                        event.changes.forEach { it.consume() }
                    }
                }
            } while (event.changes.any { it.pressed })
        }
    },
)
