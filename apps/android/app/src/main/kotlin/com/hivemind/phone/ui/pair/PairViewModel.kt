package com.hivemind.phone.ui.pair

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Connecting
import com.hivemind.phone.core.Paired
import com.hivemind.phone.core.PairsWith
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.PhoneException
import com.hivemind.phone.core.connectsWith
import com.hivemind.phone.core.pairsWith
import kotlinx.coroutines.launch

sealed interface PairState {
    data object Ready : PairState

    /** Pairing, with the device the link names (none for one that names none: the core says why). */
    data class Pairing(val with: PairsWith?) : PairState

    /** Asking with an offer to connect, made by the computer the link names. */
    data class Connecting(val with: PairsWith) : PairState

    /** Asked: the words both screens show, while the person at the computer decides. */
    data class Words(val computer: String, val words: List<String>) : PairState

    /** The computer says the phone is `whose`: taken only if the person here says the words match. */
    data class Told(val computer: String, val words: List<String>, val whose: String?, val answering: Boolean = false) : PairState

    /** Paired: with which device, and whose the phone is now. */
    data class Done(val paired: Paired) : PairState

    /** The person here said the words do not match: nothing was taken. */
    data object Refused : PairState

    /** Why not, in the core's words: not a link, the code expired, the computer not answering. */
    data class Failed(val message: String) : PairState
}

/**
 * Pairing with one of the person's computers, from the link its QR code holds (design §6.1), or
 * connecting with the offer it shows under Settings → Connect (spec/pairing.md 0.10).
 */
class PairViewModel(private val phone: Phone) : ViewModel() {
    var state: PairState by mutableStateOf(PairState.Ready)
        private set

    private var scanned: String? = null
    private var asking: Connecting? = null

    /** Pairs or connects with the link, as pasted: tried each time it is asked. */
    fun pair(link: String) {
        if (state.let { it is PairState.Pairing || it is PairState.Connecting || it is PairState.Words || it is PairState.Told }) return
        val text = link.trim()
        val connecting = connectsWith(text)
        if (connecting != null) return connect(text, connecting)
        state = PairState.Pairing(pairsWith(text))
        viewModelScope.launch {
            state = try {
                PairState.Done(phone.pair(text))
            } catch (e: PhoneException) {
                PairState.Failed(e.message.orEmpty())
            }
        }
    }

    private fun connect(link: String, with: PairsWith) {
        state = PairState.Connecting(with)
        viewModelScope.launch {
            try {
                val asked = phone.connect(link)
                asking = asked
                val (computer, words) = asked.offering() to asked.words()
                state = PairState.Words(computer, words)
                state = PairState.Told(computer, words, asked.wait()?.name)
            } catch (e: PhoneException) {
                asking = null
                state = PairState.Failed(e.message.orEmpty())
            }
        }
    }

    /** The person here says whether the words match: yes takes what the computer gives, no refuses it. */
    fun answer(match: Boolean) {
        val told = state as? PairState.Told ?: return
        val asked = asking ?: return
        if (told.answering) return
        state = told.copy(answering = true)
        viewModelScope.launch {
            state = try {
                if (match) PairState.Done(asked.take()) else asked.refuse().let { PairState.Refused }
            } catch (e: PhoneException) {
                PairState.Failed(e.message.orEmpty())
            }
            asking = null
        }
    }

    /**
     * A code the camera read. It reads the same one many times a second, each tried once; and a
     * code that is no pairing link nor offer to connect (a menu, a parcel) is none of its business.
     */
    fun scanned(text: String) {
        if (text == scanned || (pairsWith(text) == null && connectsWith(text) == null)) return
        scanned = text
        pair(text)
    }
}
