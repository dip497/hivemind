package com.hivemind.phone.ui.start

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import com.hivemind.phone.core.Photo
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/** The most photos one start takes (the computer's IMAGES_MAX). */
const val PHOTOS_MAX = 4

private val KEPT = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
private const val SMALL = 1024 * 1024
private const val SIDE = 2048

/** Whether a photo of [type] and [size] bytes is sent as it is: one the computer takes, and small. */
fun keptAsIs(type: String?, size: Int): Boolean = type in KEPT && size <= SMALL

/**
 * [bytes] drawn upright (as their EXIF orientation says) at most [side] pixels on the longer side,
 * decoded at that size rather than whole and then scaled. None when they are not an image.
 */
fun drawn(bytes: ByteArray, side: Int): Bitmap? = runCatching {
    ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
        val longer = max(info.size.width, info.size.height)
        if (longer > side) {
            val scale = side.toFloat() / longer
            decoder.setTargetSize((info.size.width * scale).roundToInt().coerceAtLeast(1), (info.size.height * scale).roundToInt().coerceAtLeast(1))
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
}.getOrNull()

/**
 * A photo given with a prompt, as the computer takes it (as the phone page does, photos.ts): kept
 * as it is when small, else drawn again upright as a jpeg at most 2048 pixels on its longer side.
 * None when it cannot be read or drawn. Reads the file: not on the main thread.
 */
fun photoOf(resolver: ContentResolver, uri: Uri): Photo? {
    val type = resolver.getType(uri)
    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    if (keptAsIs(type, bytes.size)) return Photo(kind = type!!, bytes = bytes)
    val bitmap = drawn(bytes, SIDE) ?: return null
    val jpeg = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
    bitmap.recycle()
    return Photo(kind = "image/jpeg", bytes = jpeg)
}
