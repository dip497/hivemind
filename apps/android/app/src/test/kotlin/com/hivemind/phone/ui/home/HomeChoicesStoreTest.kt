package com.hivemind.phone.ui.home

import android.app.Application
import android.content.Context
import androidx.core.content.edit
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.core.AgentRef
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** How the person left Home, kept phone-wide: what the core is asked with on every launch. */
@RunWith(AndroidJUnit4::class)
class HomeChoicesStoreTest {
    private val kept = ApplicationProvider.getApplicationContext<Application>().getSharedPreferences("home", Context.MODE_PRIVATE)

    @Test
    fun `the View choices, what was folded and when each tile was opened are there again when the app opens again`() {
        val store = HomeChoicesStore(kept, clock = { 1_790_000_000_000L })
        store.choose(ViewGroup.STATUS, "needs-you")
        store.choose(ViewGroup.GROUP_BY, "agent")
        store.choose(ViewGroup.SORT_BY, "activity")
        store.choose(ViewGroup.ACTIVITY, "week")
        store.fold("f:ws-1/f1")
        store.fold("s:waiting")
        store.opened(AgentRef(DESK, "ws-1", "t1"))

        val again = HomeChoicesStore(kept).choices.value

        assertEquals("needs-you", again.status)
        assertEquals("week", again.activity)
        assertEquals("agent", again.groupBy)
        assertEquals("activity", again.sortBy)
        assertEquals(listOf("f:ws-1/f1", "s:waiting"), again.folded)
        assertEquals(mapOf("t:ws-1/t1" to 1_790_000_000_000uL), again.seen)
    }

    @Test
    fun `folding what is folded shows it again, and opening a tile again moves when it was seen`() {
        var now = 1_000L
        val store = HomeChoicesStore(kept, clock = { now })
        store.fold("p:desk/ws-1/")
        store.fold("p:desk/ws-1/")
        store.opened(AgentRef(DESK, "ws-1", "t1"))
        now = 5_000L
        store.opened(AgentRef(DESK, "ws-1", "t1"))

        assertEquals(emptyList<String>(), store.choices.value.folded)
        assertEquals(mapOf("t:ws-1/t1" to 5_000uL), HomeChoicesStore(kept).choices.value.seen)
    }

    @Test
    fun `a record it cannot read, or a choice it does not know, leaves Home as it first shows`() {
        kept.edit { putString("choices", "{not json") }
        assertEquals(FirstChoices, HomeChoicesStore(kept).choices.value)

        kept.edit { putString("choices", """{"status":"sleeping","sortBy":"name","folded":["f:a/b"]}""") }
        val read = HomeChoicesStore(kept).choices.value
        assertEquals(FirstChoices.copy(sortBy = "name", folded = listOf("f:a/b")), read)
    }
}
