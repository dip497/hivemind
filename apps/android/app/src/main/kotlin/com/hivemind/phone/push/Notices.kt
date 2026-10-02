package com.hivemind.phone.push

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.hivemind.phone.MainActivity
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Decision
import com.hivemind.phone.core.Notice
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.PhoneException
import com.hivemind.phone.core.WaitKind

/** What answering a wait from its notification came to, as the notification then says. */
private sealed interface Answered {
    data class Landed(val decision: Decision) : Answered

    /** It waits on that no more, or it was answered already: from the app, another phone, the computer. */
    data object Already : Answered

    /** It did not go, in the core's words: the device did not answer, it said no. */
    data class NotAnswered(val why: String) : Answered
}

/**
 * What the person is told while the app is away (P6, spec/push.md), as notifications: a channel for
 * each kind; one notification for each wait, its workspace, tile and `since` its tag, so that two
 * devices telling the same thing show it once; Allow and Deny on a permission its device can decide
 * from the notification; and a wait cleared once its device says it waits no more.
 */
class Notices(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    init {
        manager.createNotificationChannelsCompat(
            listOf(
                channel(CHANNEL_NEEDS, NotificationManagerCompat.IMPORTANCE_HIGH, R.string.channel_needs, R.string.channel_needs_about),
                channel(CHANNEL_ENDED, NotificationManagerCompat.IMPORTANCE_DEFAULT, R.string.channel_ended, R.string.channel_ended_about),
                channel(CHANNEL_BACK, NotificationManagerCompat.IMPORTANCE_LOW, R.string.channel_back, R.string.channel_back_about),
            ),
        )
    }

    /** What the push service handed the app, read by the core and shown: nothing for a notice not to show, or one not for this phone. */
    suspend fun told(phone: Phone, body: ByteArray) {
        val notice = try {
            phone.readNotice(body)
        } catch (e: PhoneException) {
            Log.w(TAG, "a push message not read: ${e.message}")
            null
        }
        notice?.let(::show)
    }

    fun show(notice: Notice) {
        when (notice) {
            is Notice.Waits -> waits(Wait.of(notice), said = null, actions = notice.decide)
            is Notice.Finished ->
                ended(FINISHED, notice.agent, notice.agentName, notice.workspaceName, notice.since, R.string.notify_finished)
            is Notice.Failed ->
                ended(FAILED, notice.agent, notice.agentName, notice.workspaceName, notice.since, R.string.notify_failed)
            is Notice.Back -> post(
                BACK,
                "back/${notice.device}",
                NotificationCompat.Builder(context, CHANNEL_BACK)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle(context.getString(R.string.notify_back, notice.name))
                    .setWhen(notice.since.toLong())
                    .setShowWhen(true)
                    .setAutoCancel(true)
                    .setContentIntent(app())
                    .build(),
            )
        }
    }

    /** Allow or Deny tapped: said at once, the actions gone, while the answer goes. */
    fun answering(wait: Wait, decision: Decision) = waits(
        wait,
        context.getString(if (decision == Decision.ALLOW) R.string.notify_allowing else R.string.notify_denying),
        actions = false,
    )

    /**
     * Answers [wait] with [decision] by [answer], the core's call (spec/needs.md "Answering"), and
     * says on its notification how that went.
     */
    suspend fun answer(wait: Wait, decision: Decision, answer: suspend () -> Boolean) = answered(
        wait,
        try {
            if (answer()) Answered.Landed(decision) else Answered.Already
        } catch (e: PhoneException) {
            Answered.NotAnswered(e.message.orEmpty())
        },
    )

    /** How answering from the notification went; Allow and Deny again when it did not go, to try again. */
    private fun answered(wait: Wait, answered: Answered) = when (answered) {
        is Answered.Landed -> waits(
            wait,
            context.getString(if (answered.decision == Decision.ALLOW) R.string.notify_allowed else R.string.notify_denied),
            actions = false,
        )
        Answered.Already -> waits(wait, context.getString(R.string.notify_already), actions = false)
        is Answered.NotAnswered -> waits(wait, context.getString(R.string.notify_not_answered, answered.why), actions = wait.decide)
    }

    /**
     * Clears each wait shown that its device, having said what waits there since the notification
     * was posted, no longer lists: answered, or waiting no more. What it said before says nothing of
     * a newer wait, nor do the workspaces it told since, so a device that has not said since leaves
     * it be.
     */
    fun cleared(overview: Overview) {
        val said = overview.devices.associate { it.id to (it.answeredAt?.toLong() ?: Long.MIN_VALUE) }
        val listed = overview.needs.mapNotNull { agent -> agent.waiting?.let { agent.at to it.since.toLong() } }.toSet()
        for (shown in manager.activeNotifications) {
            if (shown.id != WAITS) continue
            val wait = Wait.from(shown.notification.extras) ?: continue
            val saidSince = (said[wait.agent.device] ?: Long.MIN_VALUE) > shown.postTime
            if (saidSince && (wait.agent to wait.since) !in listed) manager.cancel(shown.tag, WAITS)
        }
    }

    /** What a wait's notification shows while its answer goes, before Android 12 runs it as a foreground service. */
    fun answeringForeground(): Notification = NotificationCompat.Builder(context, CHANNEL_NEEDS)
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle(context.getString(R.string.notify_answering))
        .setSilent(true)
        .build()

    private fun waits(wait: Wait, said: String?, actions: Boolean) {
        val builder = NotificationCompat.Builder(context, CHANNEL_NEEDS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(wait.agentName)
            .setContentText(said ?: context.getString(R.string.notify_waits, kind(wait.kind), wait.workspaceName))
            .setWhen(wait.since)
            .setShowWhen(true)
            .setAutoCancel(true)
            // Told again, by another device, or as it is answered: changed in place, not sounded again.
            .setOnlyAlertOnce(true)
            .setContentIntent(open(wait.agent))
            .addExtras(wait.bundle())
        if (actions) {
            builder.addAction(0, context.getString(R.string.action_allow), answer(wait, Decision.ALLOW))
            builder.addAction(0, context.getString(R.string.action_deny), answer(wait, Decision.DENY))
        }
        post(WAITS, wait.tag, builder.build())
    }

    private fun ended(id: Int, agent: AgentRef, agentName: String, workspaceName: String, since: ULong, said: Int) = post(
        id,
        "${agent.workspace}/${agent.tile}/$since",
        NotificationCompat.Builder(context, CHANNEL_ENDED)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(agentName)
            .setContentText(context.getString(said, workspaceName))
            .setWhen(since.toLong())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(open(agent))
            .build(),
    )

    private fun kind(kind: WaitKind) = context.getString(
        when (kind) {
            WaitKind.PERMISSION -> R.string.notify_kind_permission
            WaitKind.QUESTION -> R.string.notify_kind_question
            WaitKind.PLAN -> R.string.notify_kind_plan
            WaitKind.OTHER -> R.string.notify_kind_other
        },
    )

    private fun open(agent: AgentRef): PendingIntent =
        PendingIntent.getActivity(context, 0, opening(context, agent), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun app(): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun answer(wait: Wait, decision: Decision): PendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, AnswerReceiver::class.java)
            // An address of its own for each wait and answer: an intent's extras do not tell two apart.
            .setData(
                Uri.Builder().scheme("hivemind").authority("answer")
                    .appendPath(wait.agent.device).appendPath(wait.agent.workspace).appendPath(wait.agent.tile)
                    .appendPath(wait.since.toString()).appendPath(decision.name)
                    .build(),
            )
            .putExtras(wait.bundle())
            .putExtra(AnswerReceiver.DECISION, decision.name),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun post(id: Int, tag: String, notification: Notification) {
        // Asked for in context (Devices, and after pairing): until it is given, nothing is shown.
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        manager.notify(tag, id, notification)
    }

    private fun channel(id: String, importance: Int, name: Int, about: Int) =
        NotificationChannelCompat.Builder(id, importance)
            .setName(context.getString(name))
            .setDescription(context.getString(about))
            .build()

    companion object {
        const val CHANNEL_NEEDS = "needs"
        const val CHANNEL_ENDED = "ended"
        const val CHANNEL_BACK = "back"

        // A notification is its tag and its id: one id for each kind, the tag naming which.
        const val WAITS = 1
        const val FINISHED = 2
        const val FAILED = 3
        const val BACK = 4

        private const val TAG = "hivemind"
    }
}
