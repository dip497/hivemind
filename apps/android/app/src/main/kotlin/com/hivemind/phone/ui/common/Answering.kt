package com.hivemind.phone.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Decision
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.core.Waiting
import com.hivemind.phone.ui.theme.Mono

/**
 * The answers to what an agent waits on (spec/needs.md "Answering"), as full-width pills, the
 * first answer filled: Allow and Deny for a permission the device can decide, Approve or Ask for
 * changes for a plan, and a line of reply for anything else. One place for both the Needs you list and the agent's own screen.
 */
@Composable
fun AnswerControls(waiting: Waiting, busy: Boolean, onAnswer: (Answer) -> Unit, modifier: Modifier = Modifier) {
    when {
        waiting.kind == WaitKind.PERMISSION && waiting.decide -> Column(
            modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(onClick = { onAnswer(Answer.Decide(Decision.ALLOW)) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_allow))
            }
            OutlinedButton(
                onClick = { onAnswer(Answer.Decide(Decision.DENY)) },
                enabled = !busy,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.action_deny))
            }
        }
        waiting.kind == WaitKind.PLAN -> PlanControls(waiting.plan, busy, onAnswer, modifier)
        else -> ReplyBox(
            hint = stringResource(R.string.reply_hint),
            busy = busy,
            onSend = { onAnswer(Answer.Text(it)) },
            modifier = modifier,
        )
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
