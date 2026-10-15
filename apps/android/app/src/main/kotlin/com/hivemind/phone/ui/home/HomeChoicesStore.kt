package com.hivemind.phone.ui.home

import android.content.SharedPreferences
import androidx.annotation.StringRes
import androidx.core.content.edit
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.HomeChoices
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** The View menu's groups, each its choices in the desktop's words; the first is what Home shows by. */
enum class ViewGroup(val id: String, @StringRes val title: Int, val choices: List<Pair<String, Int>>) {
    STATUS(
        "status",
        R.string.view_status,
        listOf(
            "all" to R.string.view_all,
            "needs-you" to R.string.view_needs_you,
            "unread" to R.string.view_unread,
            "working" to R.string.view_working,
            "idle" to R.string.view_idle,
            "exited" to R.string.view_exited,
        ),
    ),
    ACTIVITY(
        "activity",
        R.string.view_activity,
        listOf("all" to R.string.view_all, "hour" to R.string.view_past_hour, "today" to R.string.view_today, "week" to R.string.view_this_week),
    ),
    GROUP_BY(
        "groupBy",
        R.string.view_group_by,
        listOf(
            "group" to R.string.view_project,
            "machine" to R.string.view_machine,
            "date" to R.string.view_date,
            "status" to R.string.view_status,
            "agent" to R.string.view_agent,
            "none" to R.string.view_none,
        ),
    ),
    SORT_BY(
        "sortBy",
        R.string.view_sort_by,
        listOf("canvas" to R.string.view_canvas_order, "activity" to R.string.view_last_activity, "name" to R.string.view_name),
    ),
    ;

    val default: String get() = choices.first().first
}

/** What Home shows by until the person chooses otherwise. */
val FirstChoices = HomeChoices(
    status = ViewGroup.STATUS.default,
    activity = ViewGroup.ACTIVITY.default,
    groupBy = ViewGroup.GROUP_BY.default,
    sortBy = ViewGroup.SORT_BY.default,
    folded = emptyList(),
    seen = emptyMap(),
    offsetMinutes = 0,
)

fun HomeChoices.chosen(group: ViewGroup): String = when (group) {
    ViewGroup.STATUS -> status
    ViewGroup.ACTIVITY -> activity
    ViewGroup.GROUP_BY -> groupBy
    ViewGroup.SORT_BY -> sortBy
}

fun HomeChoices.choosing(group: ViewGroup, id: String): HomeChoices = when (group) {
    ViewGroup.STATUS -> copy(status = id)
    ViewGroup.ACTIVITY -> copy(activity = id)
    ViewGroup.GROUP_BY -> copy(groupBy = id)
    ViewGroup.SORT_BY -> copy(sortBy = id)
}

/** Some View choice is not Home's first: the View button says so. */
val HomeChoices.narrowed: Boolean get() = ViewGroup.entries.any { chosen(it) != it.default }

/** The key the core names [agent]'s tile by in Home's lists. */
fun tileKey(agent: AgentRef): String = "t:${agent.workspace}/${agent.tile}"

/**
 * What the person chose to see on Home, kept phone-wide as one record: the View choices, the keys
 * of what they folded, and when they last opened each tile.
 */
class HomeChoicesStore(private val kept: SharedPreferences, private val clock: () -> Long = System::currentTimeMillis) {
    private val state = MutableStateFlow(read())
    val choices: StateFlow<HomeChoices> = state.asStateFlow()

    fun choose(group: ViewGroup, id: String) = change { it.choosing(group, id) }

    /** Every View choice back to Home's first; what is folded and seen stays. */
    fun reset() = change { ViewGroup.entries.fold(it) { kept, group -> kept.choosing(group, group.default) } }

    /** Folds what is under [key], or shows it again when it is folded. */
    fun fold(key: String) = change { it.copy(folded = if (key in it.folded) it.folded - key else it.folded + key) }

    /** The person looked at [agent] now: what it did until now is read. */
    fun opened(agent: AgentRef) = change { it.copy(seen = it.seen + (tileKey(agent) to clock().toULong())) }

    private fun change(how: (HomeChoices) -> HomeChoices) {
        val next = how(state.value)
        state.value = next
        kept.edit { putString(RECORD, write(next)) }
    }

    private fun read(): HomeChoices {
        val record = kept.getString(RECORD, null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return FirstChoices
        var choices = FirstChoices
        for (group in ViewGroup.entries) {
            val id = record.optString(group.id)
            if (group.choices.any { it.first == id }) choices = choices.choosing(group, id)
        }
        val folded = record.optJSONArray("folded")?.let { list -> (0 until list.length()).mapNotNull { list.optString(it).ifEmpty { null } } }
        val seen = record.optJSONObject("seen")?.let { at -> at.keys().asSequence().associateWith { at.optLong(it).toULong() } }
        return choices.copy(folded = folded.orEmpty(), seen = seen.orEmpty())
    }

    private fun write(choices: HomeChoices): String = JSONObject().apply {
        for (group in ViewGroup.entries) put(group.id, choices.chosen(group))
        put("folded", JSONArray(choices.folded))
        put("seen", JSONObject().apply { for ((key, at) in choices.seen) put(key, at.toLong()) })
    }.toString()

    private companion object {
        const val RECORD = "choices"
    }
}
