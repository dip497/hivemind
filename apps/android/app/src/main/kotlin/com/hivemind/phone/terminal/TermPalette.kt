package com.hivemind.phone.terminal

/**
 * The colours a run names (design §5.3: top byte 0, the default colour; 1, a palette index in the
 * low byte; 2, RGB in the low three bytes), drawn as the desktop draws them by default (its Signal
 * theme, packages/hive-core/src/settings-schema.ts), so an agent's screen looks the same on both.
 */
class TermPalette(
    val foreground: Int,
    val background: Int,
    val cursor: Int,
    named: IntArray,
) {
    // The 16 named colours, then xterm's 6×6×6 cube and its 24 greys.
    private val indexed = IntArray(256).also { table ->
        named.copyInto(table)
        val levels = intArrayOf(0, 95, 135, 175, 215, 255)
        for (i in 0 until 216) table[16 + i] = rgb(levels[i / 36], levels[i / 6 % 6], levels[i % 6])
        for (i in 0 until 24) {
            val grey = 8 + 10 * i
            table[232 + i] = rgb(grey, grey, grey)
        }
    }

    /** The colour of the text a run's `fg` names. */
    fun ink(spec: Int): Int = resolve(spec, foreground)

    /** The colour behind a run's text that its `bg` names, or [NONE] where the terminal's own shows. */
    fun paper(spec: Int): Int = resolve(spec, NONE)

    // Read for every run of every line drawn: no boxing, no allocation.
    private fun resolve(spec: Int, default: Int): Int = when (spec ushr 24) {
        1 -> indexed[spec and 0xFF]
        2 -> spec or OPAQUE
        else -> default
    }

    companion object {
        /** No colour of its own: nothing is painted. */
        const val NONE = 0
        private const val OPAQUE = 0xFF shl 24

        private fun rgb(r: Int, g: Int, b: Int): Int = OPAQUE or (r shl 16) or (g shl 8) or b

        val SIGNAL = TermPalette(
            foreground = 0xFFE6E7E9.toInt(),
            background = 0xFF1A1C1F.toInt(),
            cursor = 0xFFE6E7E9.toInt(),
            named = longArrayOf(
                0xFF2A2D32, 0xFFC8756A, 0xFF8FB39A, 0xFFD9B26B, 0xFF7D9BC4, 0xFFA894C4, 0xFF7FB3B8, 0xFFD5D8DC,
                0xFF5A5F66, 0xFFDC8B80, 0xFFA6C8AF, 0xFFE6C688, 0xFF98B2D6, 0xFFBDABD6, 0xFF98C8CC, 0xFFF0F1F3,
            ).map { it.toInt() }.toIntArray(),
        )
    }
}
