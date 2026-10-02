package com.hivemind.phone

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.hivemind.phone.core.Phone
import com.hivemind.phone.live.OverviewFeed
import java.io.File

/** The core, opened once for the process (design §5.1): the phone, and the overview it follows. */
class PhoneCore private constructor(val phone: Phone, val feed: OverviewFeed) {
    companion object {
        /** Opens the core in the app's private files. Main thread: it reads only what the core kept. */
        fun open(context: Context): PhoneCore {
            val dir = File(context.filesDir, "core").apply { mkdirs() }
            val phone = Phone.open(dir.path, phoneName(context))
            return PhoneCore(phone, OverviewFeed(phone))
        }

        /** What the person's devices list this phone as: the name its settings give it, else its model. */
        private fun phoneName(context: Context): String =
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
                ?.takeIf { it.isNotBlank() }
                ?: Build.MODEL
    }
}
