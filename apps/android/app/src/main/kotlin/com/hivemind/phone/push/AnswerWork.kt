package com.hivemind.phone.push

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.hivemind.phone.PhoneApp
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Decision

/**
 * A wait answered from its notification, as the person (spec/needs.md "Answering"), the app left
 * closed: the core dials the device that holds it when no connection is kept. Expedited, so it
 * goes at once; once only for each wait, whichever button is tapped twice.
 */
class AnswerWork(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val wait = Wait.from(inputData) ?: return Result.failure()
        val decision = Decision.entries.firstOrNull { it.name == inputData.getString(DECISION) } ?: return Result.failure()
        val opened = (applicationContext as PhoneApp).core as? PhoneApp.Opened.Ready ?: return Result.failure()
        val core = opened.core
        core.notices.answer(wait, decision) { core.phone.answer(wait.agent, wait.since.toULong(), Answer.Decide(decision)) }
        return Result.success()
    }

    // Before Android 12, expedited work runs as a foreground service, which shows a notification.
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val notices = ((applicationContext as PhoneApp).core as PhoneApp.Opened.Ready).core.notices
        return ForegroundInfo(ANSWERING, notices.answeringForeground())
    }

    companion object {
        private const val DECISION = "answer.decision"
        private const val ANSWERING = 5

        fun enqueue(context: Context, wait: Wait, decision: Decision) {
            val work = OneTimeWorkRequestBuilder<AnswerWork>()
                .setInputData(Data.Builder().putAll(wait.data()).putString(DECISION, decision.name).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("answer/${wait.tag}", ExistingWorkPolicy.KEEP, work)
        }
    }
}
