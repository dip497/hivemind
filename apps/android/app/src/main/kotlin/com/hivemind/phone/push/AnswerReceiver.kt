package com.hivemind.phone.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.hivemind.phone.PhoneApp
import com.hivemind.phone.core.Decision

/**
 * Allow or Deny, tapped on a wait's notification, or on someone asking to join (design §6.8): said on the notification at once,
 * then answered by [AnswerWork] with the app left closed. Not exported: only the app's own
 * notifications send it.
 */
class AnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val decision = Decision.entries.firstOrNull { it.name == intent.getStringExtra(DECISION) } ?: return
        val opened = (context.applicationContext as PhoneApp).core as? PhoneApp.Opened.Ready ?: return
        val wait = Wait.from(intent.extras)
        if (wait != null) {
            opened.core.notices.answering(wait, decision)
            AnswerWork.enqueue(context, wait, decision)
            return
        }
        val asking = Asking.from(intent.extras) ?: return
        opened.core.notices.answering(asking, decision)
        AnswerWork.enqueue(context, asking, decision)
    }

    companion object {
        const val DECISION = "answer.decision"
    }
}
