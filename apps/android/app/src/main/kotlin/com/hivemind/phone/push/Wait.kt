package com.hivemind.phone.push

import android.os.Bundle
import androidx.work.Data
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Notice
import com.hivemind.phone.core.WaitKind

/**
 * A wait, as its notification names it (spec/push.md "What is told"): enough to answer it from the
 * notification, and to say there how that went. Carried in the notification's extras, the Allow and
 * Deny intents, and the work that answers.
 */
data class Wait(
    val agent: AgentRef,
    val agentName: String,
    val workspaceName: String,
    val kind: WaitKind,
    val since: Long,
    val decide: Boolean,
) {
    /** The notification's tag: the same wait told by two devices is one notification. */
    val tag: String get() = "${agent.workspace}/${agent.tile}/$since"

    private fun write(text: (String, String) -> Unit, number: (String, Long) -> Unit, flag: (String, Boolean) -> Unit) {
        text(DEVICE, agent.device)
        text(WORKSPACE, agent.workspace)
        text(TILE, agent.tile)
        text(AGENT_NAME, agentName)
        text(WORKSPACE_NAME, workspaceName)
        text(KIND, kind.name)
        number(SINCE, since)
        flag(DECIDE, decide)
    }

    fun bundle(): Bundle = Bundle().also { b -> write(b::putString, b::putLong, b::putBoolean) }

    fun data(): Data = Data.Builder().also { d ->
        write({ key, value -> d.putString(key, value) }, { key, value -> d.putLong(key, value) }, { key, value -> d.putBoolean(key, value) })
    }.build()

    companion object {
        private const val DEVICE = "wait.device"
        private const val WORKSPACE = "wait.workspace"
        private const val TILE = "wait.tile"
        private const val AGENT_NAME = "wait.agentName"
        private const val WORKSPACE_NAME = "wait.workspaceName"
        private const val KIND = "wait.kind"
        private const val SINCE = "wait.since"
        private const val DECIDE = "wait.decide"

        fun of(notice: Notice.Waits) = Wait(
            notice.agent,
            notice.agentName,
            notice.workspaceName,
            notice.kind,
            notice.since.toLong(),
            notice.decide,
        )

        /** The wait [bundle] carries; none in one that carries none, as another notification's extras. */
        fun from(bundle: Bundle?): Wait? = bundle?.let { b -> read(b::getString, { b.getLong(it, -1) }, b::getBoolean) }

        fun from(data: Data): Wait? = read(data::getString, { data.getLong(it, -1) }, { data.getBoolean(it, false) })

        private fun read(text: (String) -> String?, number: (String) -> Long, flag: (String) -> Boolean): Wait? {
            val since = number(SINCE).takeIf { it >= 0 } ?: return null
            val kind = WaitKind.entries.firstOrNull { it.name == text(KIND) } ?: return null
            return Wait(
                AgentRef(text(DEVICE) ?: return null, text(WORKSPACE) ?: return null, text(TILE) ?: return null),
                text(AGENT_NAME).orEmpty(),
                text(WORKSPACE_NAME).orEmpty(),
                kind,
                since,
                flag(DECIDE),
            )
        }
    }
}
