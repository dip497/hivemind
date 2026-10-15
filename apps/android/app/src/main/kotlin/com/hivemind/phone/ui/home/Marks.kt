package com.hivemind.phone.ui.home

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import com.hivemind.phone.core.AgentMark
import com.hivemind.phone.core.MarkShape

/** Where a mark's box lands in a square [side] wide: as large as fits, centred. */
data class MarkPlacement(val scale: Float, val left: Float, val top: Float)

fun placeMark(mark: AgentMark, side: Float): MarkPlacement {
    val scale = side / maxOf(mark.width, mark.height).toFloat()
    return MarkPlacement(
        scale = scale,
        left = (side - mark.width.toFloat() * scale) / 2 - mark.x.toFloat() * scale,
        top = (side - mark.height.toFloat() * scale) / 2 - mark.y.toFloat() * scale,
    )
}

/** A mark's shapes as paths to draw, each with how to draw it. */
class MarkPaths(val mark: AgentMark, val paths: List<Pair<Path, MarkShape>>)

/** Each agent's mark, read into paths once however many rows draw it. */
class MarkCache {
    private val read = HashMap<String, MarkPaths>()

    fun of(agent: String, mark: AgentMark): MarkPaths {
        read[agent]?.takeIf { it.mark == mark }?.let { return it }
        val paths = mark.shapes.map { shape ->
            val path = PathParser().parsePathString(shape.d).toPath()
            if (shape.evenOdd) path.fillType = PathFillType.EvenOdd
            path to shape
        }
        return MarkPaths(mark, paths).also { read[agent] = it }
    }
}

/** Draws [mark] in [color], fitted into the square [side] wide whose corner is at [at]. */
fun DrawScope.drawMark(mark: MarkPaths, color: Color, side: Float, at: Offset = Offset.Zero) {
    val place = placeMark(mark.mark, side)
    translate(at.x + place.left, at.y + place.top) {
        withTransform({ scale(place.scale, place.scale, pivot = Offset.Zero) }) {
            for ((path, shape) in mark.paths) {
                val alpha = shape.opacity.toFloat().coerceIn(0f, 1f)
                if (shape.fill) drawPath(path, color, alpha = alpha)
                if (shape.stroke > 0) {
                    val cap = if (shape.round) StrokeCap.Round else StrokeCap.Butt
                    drawPath(path, color, alpha = alpha, style = Stroke(shape.stroke.toFloat(), cap = cap))
                }
            }
        }
    }
}
