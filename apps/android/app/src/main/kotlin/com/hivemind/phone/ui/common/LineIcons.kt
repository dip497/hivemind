package com.hivemind.phone.ui.common

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The outlined marks the desktop's Layers panel draws (Lucide, ISC License), drawn in the colour
 * an [androidx.compose.material3.Icon] tints them; the `…Fill` ones are their insides, for a tint.
 */
object LineIcons {
    private const val FOLDER =
        "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
    private const val FOLDER_OPEN =
        "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"

    val Folder = icon("Folder", FOLDER)
    val FolderFill = icon("FolderFill", FOLDER, fill = true)
    val FolderOpen = icon("FolderOpen", FOLDER_OPEN)
    val FolderOpenFill = icon("FolderOpenFill", "$FOLDER_OPEN Z", fill = true)
    val GitBranch = icon("GitBranch", "M6 3v12", "M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0", "M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0", "M18 9a9 9 0 0 1-9 9")
    val Window = icon("Window", "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M10 4v4", "M2 8h20", "M6 4v4")
    val Terminal = icon("Terminal", "m7 11 2-2-2-2", "M11 13h4", "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z")
    val Sliders = icon("Sliders", "M20 7h-9", "M14 17H5", "M20 17a3 3 0 1 1-6 0a3 3 0 1 1 6 0", "M10 7a3 3 0 1 1-6 0a3 3 0 1 1 6 0")
    val ChevronRight = icon("ChevronRight", "m9 18 6-6-6-6")
    val ChevronDown = icon("ChevronDown", "m6 9 6 6 6-6")

    private fun icon(name: String, vararg paths: String, fill: Boolean = false): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            for (d in paths) {
                addPath(
                    pathData = PathParser().parsePathString(d).toNodes(),
                    fill = if (fill) SolidColor(Color.Black) else null,
                    stroke = if (fill) null else SolidColor(Color.Black),
                    strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()
}
