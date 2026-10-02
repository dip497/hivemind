package com.hivemind.phone

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.hivemind.phone.core.Phone
import com.hivemind.phone.live.OverviewFeed
import com.hivemind.phone.push.Notices
import com.hivemind.phone.push.Push
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

/**
 * The core, opened once for the process (design §5.1): the phone, and the overview it follows; and
 * what the person is told while the app is away (P6): where the devices tell the phone, and the
 * notifications. [scope] is the process's own work, which outlives every screen.
 */
class PhoneCore private constructor(
    val phone: Phone,
    val feed: OverviewFeed,
    val notices: Notices,
    val push: Push,
    val scope: CoroutineScope,
) {
    companion object {
        /** Opens the core in the app's private files. Main thread: it reads only what the core kept. */
        fun open(context: Context): PhoneCore {
            val dir = File(context.filesDir, "core").apply { mkdirs() }
            val phone = Phone.open(dir.path, phoneName(context))
            val feed = OverviewFeed(phone)
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val app = context.applicationContext
            val notices = Notices(app)
            // A wait answered, or waiting no more, as its device says: its notification goes.
            scope.launch { feed.overview.collect(notices::cleared) }
            return PhoneCore(phone, feed, notices, Push(app, phone, feed.overview, scope), scope)
        }

        /** What the person's devices list this phone as: the name its settings give it, else its model. */
        private fun phoneName(context: Context): String =
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
                ?.takeIf { it.isNotBlank() }
                ?: Build.MODEL
    }
}
