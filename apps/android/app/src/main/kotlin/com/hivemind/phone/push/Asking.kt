package com.hivemind.phone.push

import android.os.Bundle
import androidx.work.Data
import com.hivemind.phone.core.JoinRef
import com.hivemind.phone.core.Notice

/**
 * Someone asking to join a workspace, as its notification names them (spec/push.md "Join"): enough
 * to let them in or turn them away from the notification, and to say there how that went. Carried
 * as [Wait] is: in the notification's extras, the Allow and Deny intents, and the work that answers.
 */
data class Asking(val join: JoinRef, val who: String, val workspaceName: String, val role: String, val since: Long) {
    /** The notification's tag: the same question told twice is one notification. */
    val tag: String get() = "join/${join.workspace}/${join.req}"

    private fun write(text: (String, String) -> Unit, number: (String, Long) -> Unit) {
        text(DEVICE, join.device)
        text(WORKSPACE, join.workspace)
        number(REQ, join.req.toLong())
        text(WHO, who)
        text(WORKSPACE_NAME, workspaceName)
        text(ROLE, role)
        number(SINCE, since)
    }

    fun bundle(): Bundle = Bundle().also { b -> write(b::putString, b::putLong) }

    fun data(): Data = Data.Builder().also { d -> write({ k, v -> d.putString(k, v) }, { k, v -> d.putLong(k, v) }) }.build()

    companion object {
        private const val DEVICE = "join.device"
        private const val WORKSPACE = "join.workspace"
        private const val REQ = "join.req"
        private const val WHO = "join.who"
        private const val WORKSPACE_NAME = "join.workspaceName"
        private const val ROLE = "join.role"
        private const val SINCE = "join.since"

        fun of(notice: Notice.Join) = Asking(notice.join, notice.who, notice.workspaceName, notice.role, notice.since.toLong())

        /** The question [bundle] carries; none in one that carries none, as a wait's. */
        fun from(bundle: Bundle?): Asking? = bundle?.let { b -> read(b::getString) { b.getLong(it, -1) } }

        fun from(data: Data): Asking? = read(data::getString) { data.getLong(it, -1) }

        private fun read(text: (String) -> String?, number: (String) -> Long): Asking? {
            val req = number(REQ).takeIf { it >= 0 } ?: return null
            return Asking(
                JoinRef(text(DEVICE) ?: return null, text(WORKSPACE) ?: return null, req.toULong()),
                text(WHO).orEmpty(),
                text(WORKSPACE_NAME).orEmpty(),
                text(ROLE).orEmpty(),
                number(SINCE),
            )
        }
    }
}
