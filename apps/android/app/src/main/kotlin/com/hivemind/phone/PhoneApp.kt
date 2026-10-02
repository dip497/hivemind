package com.hivemind.phone

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import com.hivemind.phone.core.PhoneException

/** The app's process: it opens the core once, and keeps it in step with the foreground. */
class PhoneApp : Application() {
    /** The core, or why it could not be opened: its keys unreadable, the disk full. */
    lateinit var core: Opened
        private set

    override fun onCreate() {
        super.onCreate()
        core = try {
            Opened.Ready(PhoneCore.open(this))
        } catch (e: PhoneException) {
            Opened.Broken(e.message.orEmpty())
        }
        (core as? Opened.Ready)?.let {
            ProcessLifecycleOwner.get().lifecycle.addObserver(Foreground(it.core.phone, this))
        }
    }

    sealed interface Opened {
        data class Ready(val core: PhoneCore) : Opened

        data class Broken(val reason: String) : Opened
    }
}
