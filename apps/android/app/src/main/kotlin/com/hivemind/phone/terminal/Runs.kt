package com.hivemind.phone.terminal

/**
 * The style runs of one terminal line, as the core packs them (docs/design/phone-app-2026-10-02.md
 * §5.3): 16 bytes a run, little-endian, `start: u16` and `len: u16` (UTF-16 units of the line's
 * text), `col: u16` (the cell the run starts at), `flags: u16` ([RunFlags]), `fg: u32` and
 * `bg: u32` ([TermPalette]). Decoded once, when the line changes, into the fields drawing reads
 * every frame.
 */
class Runs private constructor(private val fields: IntArray) {
    val count: Int get() = fields.size / FIELDS

    /** Where the run's text starts in the line's, in UTF-16 units. */
    fun start(run: Int): Int = fields[run * FIELDS]

    /** One past where the run's text ends. */
    fun end(run: Int): Int = fields[run * FIELDS] + fields[run * FIELDS + 1]

    /** The cell the run starts at. */
    fun col(run: Int): Int = fields[run * FIELDS + 2]

    fun flags(run: Int): Int = fields[run * FIELDS + 3]

    fun fg(run: Int): Int = fields[run * FIELDS + 4]

    fun bg(run: Int): Int = fields[run * FIELDS + 5]

    /** How many cells the run covers: two for a wide character, else one a character. */
    fun cells(run: Int): Int = fields[run * FIELDS + 6]

    companion object {
        private const val SIZE = 16
        private const val FIELDS = 7

        val NONE = Runs(IntArray(0))

        /**
         * The runs of a line of [text]. The core never sends a run reaching past the text; were one
         * to, it is cut to the text rather than take the app down mid-draw.
         */
        fun decode(packed: ByteArray, text: String): Runs {
            val count = packed.size / SIZE
            val fields = IntArray(count * FIELDS)
            var kept = 0
            for (run in 0 until count) {
                val at = run * SIZE
                val start = u16(packed, at)
                if (start >= text.length) continue
                val end = start + minOf(u16(packed, at + 2), text.length - start)
                val flags = u16(packed, at + 6)
                val field = kept * FIELDS
                fields[field] = start
                fields[field + 1] = end - start
                fields[field + 2] = u16(packed, at + 4)
                fields[field + 3] = flags
                fields[field + 4] = u32(packed, at + 8)
                fields[field + 5] = u32(packed, at + 12)
                fields[field + 6] = if (flags and RunFlags.WIDE != 0) 2 else Character.codePointCount(text, start, end)
                kept++
            }
            return Runs(if (kept == count) fields else fields.copyOf(kept * FIELDS))
        }

        private fun u16(bytes: ByteArray, at: Int): Int =
            (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8)

        private fun u32(bytes: ByteArray, at: Int): Int = u16(bytes, at) or (u16(bytes, at + 2) shl 16)
    }
}

/** The bits of a run's `flags` (design §5.3). */
object RunFlags {
    const val BOLD = 1 shl 0
    const val DIM = 1 shl 1
    const val ITALIC = 1 shl 2
    const val UNDERLINE = 1 shl 3
    const val INVERSE = 1 shl 4
    const val STRIKETHROUGH = 1 shl 5
    const val HIDDEN = 1 shl 6

    /** A run of one double-width character: it covers two cells. */
    const val WIDE = 1 shl 8
}
