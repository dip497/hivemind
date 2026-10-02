package com.hivemind.phone.push

import com.hivemind.phone.PhoneApp
import com.hivemind.phone.PhoneCore
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * What the UnifiedPush distributor tells the app (P6): where the phone is told, handed to [Push];
 * each message, handed to [Notices] as it came. The core's own push keys encrypt what the devices
 * send (spec/push.md "Sending"), not the connector's, which cannot read it and passes it on whole.
 */
class HivePushService : PushService() {
    private val core: PhoneCore? get() = ((application as PhoneApp).core as? PhoneApp.Opened.Ready)?.core

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        core?.push?.newEndpoint(endpoint.url)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val core = core ?: return
        core.scope.launch { core.notices.told(core.phone, message.content) }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        core?.push?.registrationFailed(reason)
    }

    override fun onUnregistered(instance: String) {
        core?.push?.unregistered()
    }
}
