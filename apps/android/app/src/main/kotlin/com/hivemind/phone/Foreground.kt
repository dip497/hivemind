package com.hivemind.phone

import android.content.Context
import android.net.wifi.WifiManager
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.hivemind.phone.core.Phone

/**
 * The core's connections follow the app (design §3.2): every device redialled at once when it comes
 * to the foreground, the connections closed when it leaves. Meanwhile a multicast lock lets mDNS
 * through Wi-Fi, which drops it otherwise: the core finds the person's devices on the same network
 * by mDNS.
 *
 * Observes the process's lifecycle (ProcessLifecycleOwner), not an activity's.
 */
class Foreground(private val phone: Phone, context: Context) : DefaultLifecycleObserver {
    private val multicast = context.applicationContext.getSystemService(WifiManager::class.java)
        ?.createMulticastLock("hivemind mDNS")
        ?.apply { setReferenceCounted(false) }

    override fun onStart(owner: LifecycleOwner) {
        multicast?.acquire()
        phone.onForeground()
    }

    override fun onStop(owner: LifecycleOwner) {
        phone.onBackground()
        multicast?.release()
    }
}
