package com.hivemind.phone

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import com.hivemind.phone.core.PhoneException

/**
 * The app's process: it opens the core once, and keeps it in step with the foreground. WorkManager,
 * which answers from a notification, starts only when one is answered, not with every process.
 */
class PhoneApp : Application(), Configuration.Provider {
    /** The core, or why it could not be opened: its keys unreadable, the disk full. */
    lateinit var core: Opened
        private set

    override val workManagerConfiguration: Configuration get() = Configuration.Builder().build()

    override fun onCreate() {
        super.onCreate()
        core = try {
            Opened.Ready(PhoneCore.open(this))
        } catch (e: PhoneException) {
            Opened.Broken(e.message.orEmpty())
        }
        (core as? Opened.Ready)?.let {
            val process = ProcessLifecycleOwner.get().lifecycle
            process.addObserver(Foreground(it.core.phone, this))
            // After the core's: the devices are redialled before they are told where the phone is.
            process.addObserver(it.core.push)
        }
    }

    sealed interface Opened {
        data class Ready(val core: PhoneCore) : Opened

        data class Broken(val reason: String) : Opened
    }
}
