package com.hivemind.phone.ui.start

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.hivemind.phone.core.Photo
import java.io.ByteArrayOutputStream
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
 * A photo given with a prompt, as the computer takes it (as the phone page does, photos.ts): kept
 * as it is when small, else drawn again as a jpeg at most 2048 pixels on its longer side. None when
 * it cannot be read or drawn. Reads the file: not on the main thread.
 */
fun photoOf(resolver: ContentResolver, uri: Uri): Photo? {
    val type = resolver.getType(uri)
    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    if (keptAsIs(type, bytes.size)) return Photo(kind = type!!, bytes = bytes)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val longer = max(bounds.outWidth, bounds.outHeight)
    if (longer <= 0) return null
    // Decoded at the nearest power of two above the size wanted, then scaled to it.
    var sample = 1
    while (longer / (sample * 2) >= SIDE) sample *= 2
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val scale = minOf(1f, SIDE.toFloat() / max(decoded.width, decoded.height))
    val drawn = if (scale < 1f) {
        Bitmap.createScaledBitmap(decoded, (decoded.width * scale).roundToInt(), (decoded.height * scale).roundToInt(), true)
    } else {
        decoded
    }
    val jpeg = ByteArrayOutputStream().also { drawn.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
    return Photo(kind = "image/jpeg", bytes = jpeg)
}
