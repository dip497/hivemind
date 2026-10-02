package com.hivemind.phone.ui.views

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.core.ViewInfo
import com.hivemind.phone.device
import com.hivemind.phone.overview
import com.hivemind.phone.ui.start.Place
import com.hivemind.phone.ui.theme.PhoneTheme
import com.hivemind.phone.workspace
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The Views tab (design §6, screen 9): what the person's computers offer the phone, and how it reads. */
@RunWith(AndroidJUnit4::class)
class ViewsListTest {
    @get:Rule
    val compose = createComposeRule()

    private fun view(id: String, name: String) = ViewInfo(id = id, name = name, version = "1.0.0", page = "__entry.html")

    private val hivemind = Place(DESK, "desk", "ws-1", "hivemind")
    private val site = Place(DESK, "desk", "ws-2", "site")
    private val notes = Place("laptop-id", "laptop", "ws-9", "notes")

    @Test
    fun `each computer's views are listed by workspace as the core lists them, one away as it last offered them, a workspace gone not at all`() {
        val now = overview(
            devices = listOf(device(DESK, "desk"), device("laptop-id", "laptop", reachable = false)),
            workspaces = listOf(workspace("ws-1", "hivemind"), workspace("ws-2", "site"), workspace("ws-9", "notes", device = "laptop-id")),
        )
        val offered = mapOf(
            site to listOf(view("site-map", "Site map")),
            hivemind to listOf(view("phone-probe", "Priya's phone board"), view("Not--an-id", "Broken")),
            notes to listOf(view("@priya/notes", "Notes")),
            Place(DESK, "desk", "ws-gone", "gone") to listOf(view("gone", "Gone")),
        )

        val rows = viewRows(now, offered).map { Triple(it.view.name, it.place.workspaceName, it.away) }

        assertEquals(
            listOf(Triple("Priya's phone board", "hivemind", false), Triple("Site map", "site", false), Triple("Notes", "notes", true)),
            rows,
        )
    }

    @Test
    fun `a row says where the view is, and a computer away says so, its view not opened`() {
        val opened = mutableListOf<String>()
        val rows = listOf(
            ViewRow(view("phone-probe", "Priya's phone board"), hivemind, away = false),
            ViewRow(view("@priya/notes", "Notes"), notes, away = true),
        )
        compose.setContent {
            PhoneTheme(accent = null) { ViewsList(rows, refreshing = false, onRefresh = {}, onOpen = { opened += it.view.id }) }
        }

        compose.onNodeWithText("hivemind · desk").assertIsDisplayed()
        compose.onNodeWithText("notes · laptop is away").assertIsDisplayed()
        compose.onNodeWithText("Notes").performClick()
        compose.onNodeWithText("Priya's phone board").performClick()

        assertEquals(listOf("phone-probe"), opened)
    }

    @Test
    fun `with nothing offered, it says what would be`() {
        compose.setContent {
            PhoneTheme(accent = null) { ViewsList(emptyList(), refreshing = false, onRefresh = {}, onOpen = {}) }
        }

        compose.onNodeWithText("No views yet. A community view that works on a phone, installed on your computer, shows here.").assertIsDisplayed()
    }
}
