package com.hivemind.phone.ui.start

import org.junit.Assert.assertEquals
import org.junit.Test

/** Which photos are sent as they are, as the computer takes them and the phone page sends them (photos.ts). */
class PhotosTest {
    @Test
    fun `a png, jpeg, webp or gif of a megabyte or less is sent as it is, and any other, or a larger one, is drawn again`() {
        for (type in listOf("image/png", "image/jpeg", "image/webp", "image/gif")) assertEquals(type, true, keptAsIs(type, 1024 * 1024))
        assertEquals(false, keptAsIs("image/jpeg", 1024 * 1024 + 1))
        assertEquals(false, keptAsIs("image/heic", 10))
        assertEquals(false, keptAsIs(null, 10))
    }
}
