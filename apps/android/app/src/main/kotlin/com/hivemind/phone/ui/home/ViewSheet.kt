package com.hivemind.phone.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.HomeChoices
import com.hivemind.phone.ui.common.GroupLabel
import com.hivemind.phone.ui.common.LineIcons
import com.hivemind.phone.ui.common.PillChip

/** The View button: a dot on it while some choice is not Home's first. */
@Composable
fun ViewButton(narrowed: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    IconButton(onClick = onClick, modifier = Modifier.testTag("home-view")) {
        Box {
            Icon(LineIcons.Sliders, stringResource(R.string.view_title), tint = colors.onSurfaceVariant, modifier = Modifier.size(22.dp))
            if (narrowed) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .size(9.dp)
                        .background(colors.background, CircleShape)
                        .padding(1.5.dp)
                        .background(colors.primary, CircleShape),
                )
            }
        }
    }
}

/** The View menu as a sheet: one choice in each group, taken as it is tapped. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ViewSheet(choices: HomeChoices, onChoose: (ViewGroup, String) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.background,
    ) {
        ViewChoices(choices, onChoose)
    }
}

/** The four groups of the View menu, each its choices as pills. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ViewChoices(choices: HomeChoices, onChoose: (ViewGroup, String) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
    ) {
        Text(stringResource(R.string.view_title), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
        for (group in ViewGroup.entries) {
            Spacer(Modifier.height(18.dp))
            GroupLabel(stringResource(group.title))
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((id, words) in group.choices) {
                    PillChip(choices.chosen(group) == id, onClick = { onChoose(group, id) }, label = stringResource(words))
                }
            }
        }
    }
}
