package com.hivemind.phone.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Choice
import com.hivemind.phone.core.Decision
import com.hivemind.phone.core.Question
import com.hivemind.phone.core.QuestionAnswer
import com.hivemind.phone.core.ToolAsked
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.core.Waiting
import com.hivemind.phone.ui.theme.Mono

/**
 * The answers to what an agent waits on (spec/needs.md "Answering"), compact, the first answer
 * filled: the tool a permission is for and its command; Deny and Allow side by side for a
 * permission the device can decide; a question's options as pills that wrap, each question
 * answered in its place; Approve or Ask for changes for a plan; and a line of reply for anything else. One
 * place for both the Needs you list and the agent's own screen.
 */
@Composable
fun AnswerControls(waiting: Waiting, busy: Boolean, onAnswer: (Answer) -> Unit, modifier: Modifier = Modifier) {
    val questions = waiting.questions
    val choosing = waiting.kind == WaitKind.QUESTION && waiting.choose && questions.isNotEmpty()
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        waiting.tool?.let { ToolCommand(it) }
        if (!choosing) questions.forEach { QuestionAsked(it) }
        when {
            choosing && questions.size == 1 && !questions[0].many -> {
                val question = questions[0]
                QuestionText(question)
                Options {
                    question.options.forEachIndexed { n, option ->
                        OptionPill(option, chosen = false, enabled = !busy, tag = "choice-0-$n") {
                            onAnswer(Answer.Questions(listOf(QuestionAnswer.Chosen(listOf(n.toUInt())))))
                        }
                    }
                }
                ReplyBox(hint = stringResource(R.string.own_answer_or_hint), busy = busy, onSend = { onAnswer(Answer.Text(it)) })
            }
            choosing -> QuestionsForm(waiting, busy, onAnswer)
            waiting.kind == WaitKind.PERMISSION && waiting.decide -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { onAnswer(Answer.Decide(Decision.DENY)) },
                    enabled = !busy,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.action_deny))
                }
                Button(onClick = { onAnswer(Answer.Decide(Decision.ALLOW)) }, enabled = !busy, modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.action_allow))
                }
            }
            waiting.kind == WaitKind.PLAN -> PlanControls(waiting.plan, busy, onAnswer, Modifier)
            else -> ReplyBox(hint = stringResource(R.string.reply_hint), busy = busy, onSend = { onAnswer(Answer.Text(it)) })
        }
    }
}

/** The tool a permission is for, and its command in mono: four lines of it until tapped. */
@Composable
private fun ToolCommand(tool: ToolAsked) {
    var whole by rememberSaveable { mutableStateOf(false) }
    Surface(
        color = MaterialTheme.colorScheme.background,
        shape = MaterialTheme.shapes.extraSmall,
        onClick = { whole = !whole },
        modifier = Modifier.fillMaxWidth().testTag("tool"),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_terminal), null, tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(16.dp))
                Text(
                    tool.name,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            tool.about?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = Mono,
                    maxLines = if (whole) Int.MAX_VALUE else 4,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun QuestionText(question: Question) {
    Text(question.question, style = MaterialTheme.typography.bodyMedium)
}

/** A question its options cannot be chosen for from here: the question, and its options to read. */
@Composable
private fun QuestionAsked(question: Question) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        QuestionText(question)
        question.options.forEach {
            Text(
                "· ${it.label}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A question's options as compact pills, side by side, wrapping onto the next row. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Options(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

/** An option as a compact pill: its label, and what it means when the agent says; filled once chosen. */
@Composable
private fun OptionPill(option: Choice, chosen: Boolean, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val content: @Composable RowScope.() -> Unit = {
        Column {
            Text(option.label)
            option.description?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = LocalContentColor.current.copy(alpha = 0.7f))
            }
        }
    }
    val pill = Modifier.testTag(tag).semantics { selected = chosen }
    val padding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)
    if (chosen) {
        Button(onClick = onClick, enabled = enabled, contentPadding = padding, modifier = pill, content = content)
    } else {
        OutlinedButton(
            onClick = onClick,
            enabled = enabled,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
            contentPadding = padding,
            modifier = pill,
            content = content,
        )
    }
}

/**
 * Several questions, or one of several answers: each its options and a line of its own, the one or
 * the other; one Send once each has an answer, each answer in its question's place.
 */
@Composable
private fun QuestionsForm(waiting: Waiting, busy: Boolean, onAnswer: (Answer) -> Unit) {
    val questions = waiting.questions
    val chosen = remember(waiting.since) { questions.map { mutableStateListOf<Int>() } }
    val own = remember(waiting.since) { questions.map { mutableStateOf("") } }
    questions.forEachIndexed { i, question ->
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            QuestionText(question)
            if (question.many) {
                Text(
                    stringResource(R.string.choose_any),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            Options {
                question.options.forEachIndexed { n, option ->
                    OptionPill(option, chosen = n in chosen[i], enabled = !busy, tag = "choice-$i-$n") {
                        val picked = chosen[i]
                        when {
                            n in picked -> picked.remove(n)
                            question.many -> picked.add(n)
                            else -> {
                                picked.clear()
                                picked.add(n)
                            }
                        }
                        own[i].value = ""
                    }
                }
            }
            OutlinedTextField(
                value = own[i].value,
                onValueChange = {
                    own[i].value = it
                    if (it.isNotBlank()) chosen[i].clear()
                },
                placeholder = { Text(stringResource(R.string.own_answer_hint), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                singleLine = true,
                enabled = !busy,
                shape = CircleShape,
                colors = OutlinedTextFieldDefaults.colors(
                    unfocusedContainerColor = MaterialTheme.colorScheme.background,
                    focusedContainerColor = MaterialTheme.colorScheme.background,
                    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                ),
                modifier = Modifier.fillMaxWidth().testTag("own-$i"),
            )
        }
    }
    val answered = questions.indices.all { own[it].value.isNotBlank() || chosen[it].isNotEmpty() }
    Button(
        onClick = {
            val answers = questions.indices.map { i ->
                val typed = own[i].value.trim()
                if (typed.isNotEmpty()) QuestionAnswer.Text(typed) else QuestionAnswer.Chosen(chosen[i].sorted().map { it.toUInt() })
            }
            onAnswer(Answer.Questions(answers))
        },
        enabled = !busy && answered,
        modifier = Modifier.fillMaxWidth().testTag("answers-send"),
    ) {
        Text(stringResource(R.string.action_send))
    }
}

@Composable
private fun PlanControls(plan: String?, busy: Boolean, onAnswer: (Answer) -> Unit, modifier: Modifier) {
    var open by rememberSaveable { mutableStateOf(false) }
    var changing by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (open && plan != null) {
            Surface(color = MaterialTheme.colorScheme.background, shape = MaterialTheme.shapes.extraSmall) {
                Text(
                    plan,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = Mono,
                    modifier = Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()).padding(12.dp),
                )
            }
        }
        Button(onClick = { onAnswer(Answer.Plan(approve = true, feedback = null)) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.action_approve))
        }
        if (changing) {
            ReplyBox(
                hint = stringResource(R.string.changes_hint),
                busy = busy,
                onSend = { onAnswer(Answer.Plan(approve = false, feedback = it)) },
            )
        } else {
            OutlinedButton(
                onClick = { changing = true },
                enabled = !busy,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.action_ask_changes))
            }
        }
        if (plan != null && !open) {
            TextButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_review_plan)) }
        }
    }
}

/** One line to send: Send on the keyboard or the button sends it and empties the box. */
@Composable
fun ReplyBox(hint: String, busy: Boolean, onSend: (String) -> Unit, modifier: Modifier = Modifier) {
    var text by rememberSaveable { mutableStateOf("") }
    val send = {
        if (text.isNotBlank()) {
            onSend(text)
            text = ""
        }
    }
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text(hint, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            singleLine = true,
            enabled = !busy,
            shape = CircleShape,
            colors = OutlinedTextFieldDefaults.colors(
                unfocusedContainerColor = MaterialTheme.colorScheme.background,
                focusedContainerColor = MaterialTheme.colorScheme.background,
                unfocusedBorderColor = MaterialTheme.colorScheme.outline,
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            modifier = Modifier.weight(1f).testTag("reply"),
        )
        Button(onClick = send, enabled = !busy && text.isNotBlank(), modifier = Modifier.padding(start = 8.dp).testTag("reply-send")) {
            Text(stringResource(R.string.action_send))
        }
    }
}
