package com.hivemind.phone.ui.diff

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Diff
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.PhoneException
import kotlinx.coroutines.launch

sealed interface DiffState {
    data object Loading : DiffState

    /** The changes, and each file's part of the patch by its path. */
    data class Loaded(val diff: Diff, val patches: Map<String, String>) : DiffState

    data class Failed(val message: String) : DiffState
}

/**
 * The unified diff cut into each file's part, by the path its header names: the new path (`b/…`),
 * or the old one for a file deleted. The core sends one patch for all files (design §5.2).
 */
fun patchesByFile(patch: String): Map<String, String> {
    val parts = LinkedHashMap<String, String>()
    val header = Regex("^diff --git ", RegexOption.MULTILINE)
    val starts = header.findAll(patch).map { it.range.first }.toList()
    starts.forEachIndexed { i, start ->
        val part = patch.substring(start, starts.getOrNull(i + 1) ?: patch.length)
        val names = part.lineSequence().first().removePrefix("diff --git ")
        val path = names.substringAfter(" b/", "").ifEmpty { names.removePrefix("a/").substringBefore(" ") }
        parts[path] = part.trimEnd('\n')
    }
    return parts
}

/** What an agent changed in the folder it runs in (design §6.5). */
class DiffViewModel(private val phone: Phone, private val ref: AgentRef) : ViewModel() {
    var state: DiffState by mutableStateOf(DiffState.Loading)
        private set

    init {
        load()
    }

    fun load() {
        state = DiffState.Loading
        viewModelScope.launch {
            state = try {
                val diff = phone.diff(ref)
                DiffState.Loaded(diff, patchesByFile(diff.patch))
            } catch (e: PhoneException) {
                DiffState.Failed(e.message.orEmpty())
            }
        }
    }
}
