package com.hivemind.phone.ui.home

import android.app.Application
import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.core.HomeChoices
import com.hivemind.phone.core.HomeShown
import com.hivemind.phone.core.NoHandle
import com.hivemind.phone.core.Phone
import com.hivemind.phone.overview
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.util.TimeZone

/** Home asks the core with what the person chose, every time it asks. */
@RunWith(AndroidJUnit4::class)
class HomeViewModelTest {
    private class Computer : Phone(NoHandle) {
        val asked = mutableListOf<HomeChoices>()

        override fun home(query: String, machine: String?, choices: HomeChoices): List<HomeShown> {
            asked += choices
            return emptyList()
        }
    }

    private val kept = ApplicationProvider.getApplicationContext<Application>().getSharedPreferences("home", Context.MODE_PRIVATE)

    @Test
    fun `Home is asked for as the person left it, with the phone's clock offset, and again as they fold and choose`() {
        HomeChoicesStore(kept).apply {
            choose(ViewGroup.STATUS, "unread")
            fold("f:ws-1/f1")
        }
        val computer = Computer()
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Kolkata"))
        val home = try {
            HomeViewModel(computer, MutableStateFlow(overview()), HomeChoicesStore(kept))
        } finally {
            TimeZone.setDefault(zone)
        }

        val first = computer.asked.last()
        assertEquals("unread", first.status)
        assertEquals(listOf("f:ws-1/f1"), first.folded)
        assertEquals("India is 5 h 30 min ahead of UTC", 330, first.offsetMinutes)

        home.fold("s:waiting")
        home.choose(ViewGroup.GROUP_BY, "status")
        shadowOf(Looper.getMainLooper()).idle()

        val last = computer.asked.last()
        assertEquals("status", last.groupBy)
        assertEquals(listOf("f:ws-1/f1", "s:waiting"), last.folded)
        assertEquals("status", home.state.value.choices.groupBy)
    }
}
