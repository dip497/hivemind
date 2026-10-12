package com.hivemind.phone.ui.common

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The box a message is typed in, as a phone shows it. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReplyBoxTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `its hint stays on one line however long the agent's name`() {
        compose.setContent {
            Column(Modifier.width(360.dp)) {
                ReplyBox("Message claude", busy = false, onSend = {})
                ReplyBox("Message claude-refactor-the-login-redirect-flow-and-its-tests", busy = false, onSend = {})
            }
        }

        val (short, long) = compose.onAllNodesWithTag("reply").fetchSemanticsNodes().map { it.boundsInRoot.height }
        assertEquals(short, long)
    }
}
