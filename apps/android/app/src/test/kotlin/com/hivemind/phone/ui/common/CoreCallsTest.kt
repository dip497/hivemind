package com.hivemind.phone.ui.common

import com.hivemind.phone.core.PhoneException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** How a screen's calls to the core go: one at a time for each thing, failures told once. */
@OptIn(ExperimentalCoroutinesApi::class)
class CoreCallsTest {
    @Test
    fun `a call the core refuses tells the person why, in the core's words`() = runTest {
        val calls = CoreCalls(this)

        calls.launch("t1", { throw PhoneException.Unreachable("desk is away") })
        advanceUntilIdle()

        assertEquals(Notice.Failed("desk is away"), calls.notice)
        assertTrue(calls.busy.isEmpty())
    }

    @Test
    fun `a second Start while the first is on its way starts nothing`() = runTest {
        val calls = CoreCalls(this)
        val answer = CompletableDeferred<String>()
        val started = mutableListOf<String>()

        calls.launch("ws-1", { answer.await() }) { started += it }
        runCurrent()
        calls.launch("ws-1", { "tile-2" }) { started += it }
        calls.launch("ws-2", { "tile-3" }) { started += it }
        runCurrent()
        assertEquals(setOf<Any>("ws-1"), calls.busy)

        answer.complete("tile-1")
        advanceUntilIdle()
        assertEquals(listOf("tile-3", "tile-1"), started)
        assertTrue(calls.busy.isEmpty())
    }
}
