package com.hivemind.phone.push

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.hivemind.phone.MainActivity
import com.hivemind.phone.core.AgentRef

private const val AGENT = "agent"

/**
 * The app, opened on [agent]'s screen, as a notification about it opens it. Its address names the
 * agent, so that each notification's intent is one of its own, its extras not another's.
 */
fun opening(context: Context, agent: AgentRef): Intent =
    Intent(context, MainActivity::class.java)
        .setAction(Intent.ACTION_VIEW)
        .setData(
            Uri.Builder().scheme("hivemind").authority(AGENT)
                .appendPath(agent.device).appendPath(agent.workspace).appendPath(agent.tile)
                .build(),
        )
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)

/** The agent [intent] opens the app on; none for an intent that opens it as the launcher does. */
fun openedOn(intent: Intent?): AgentRef? {
    val address = intent?.data?.takeIf { it.scheme == "hivemind" && it.authority == AGENT } ?: return null
    val (device, workspace, tile) = address.pathSegments.takeIf { it.size == 3 } ?: return null
    return AgentRef(device, workspace, tile)
}
