package com.hivemind.phone.ui.common

import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.question
import com.hivemind.phone.waiting
import org.junit.Assert.assertEquals
import org.junit.Test

/** Where the person types an answer in words on an agent's screen: the composer, or the card's own controls (design PB §12.12). */
class ComposerAnswersTest {
    @Test
    fun `the composer answers a question with one choice and a wait for words; Allow and Deny, a plan and a form keep their own`() {
        assertEquals(false, composerAnswers(null))
        assertEquals(true, composerAnswers(waiting(WaitKind.QUESTION, 0, choose = true, questions = listOf(question("Which?", "a", "b")))))
        assertEquals(false, composerAnswers(waiting(WaitKind.QUESTION, 0, choose = true, questions = listOf(question("Which?", "a", "b", many = true)))))
        assertEquals(false, composerAnswers(waiting(WaitKind.QUESTION, 0, choose = true, questions = listOf(question("One?", "a"), question("Two?", "b")))))
        // A question asked where its options cannot be chosen from here is answered in words.
        assertEquals(true, composerAnswers(waiting(WaitKind.QUESTION, 0, questions = listOf(question("Which?", "a")))))
        assertEquals(false, composerAnswers(waiting(WaitKind.PERMISSION, 0, decide = true)))
        assertEquals(true, composerAnswers(waiting(WaitKind.PERMISSION, 0)))
        assertEquals(false, composerAnswers(waiting(WaitKind.PLAN, 0, plan = "1. do it")))
    }

    @Test
    fun `the working line counts seconds, then minutes and seconds, then hours and minutes`() {
        assertEquals("0s", elapsed(-5))
        assertEquals("12s", elapsed(12_400))
        assertEquals("3m 04s", elapsed(184_000))
        assertEquals("1h 02m", elapsed(3_720_000))
    }
}
