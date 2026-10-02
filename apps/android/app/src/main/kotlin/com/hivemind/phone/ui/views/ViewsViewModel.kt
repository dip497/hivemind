package com.hivemind.phone.ui.views

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.PhoneException
import com.hivemind.phone.core.ViewInfo
import com.hivemind.phone.ui.start.Place
import com.hivemind.phone.ui.start.placesOf
import com.hivemind.phone.views.ViewSite
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A view one of the person's computers offers for a workspace it holds: [away] while it cannot be reached. */
data class ViewRow(val view: ViewInfo, val place: Place, val away: Boolean)

/**
 * What Views lists (design §6, screen 9; §6.1): the views each of the person's computers offers for
 * each workspace it holds, [offered] as each last said, in the order of the workspaces; a computer
 * away keeps the rows it last offered, away. A workspace no longer held is no longer listed, and a
 * view whose id is no view's has no origin to be shown on, so it is not offered.
 */
fun viewRows(overview: Overview, offered: Map<Place, List<ViewInfo>>): List<ViewRow> {
    val reachable = overview.devices.filter { it.reachable }.map { it.id }.toSet()
    return placesOf(overview).flatMap { place ->
        offered[place].orEmpty()
            .filter { ViewSite.of(it.id) != null }
            .map { ViewRow(it, place, away = place.device !in reachable) }
    }
}

/**
 * The Views tab: each computer reachable is asked which views it offers for each workspace it
 * holds, again whenever those change (a workspace opened, a computer back), each time the tab is
 * opened, and when the person pulls the list down.
 */
class ViewsViewModel(private val phone: Phone, overview: StateFlow<Overview>) : ViewModel() {
    private val offered = MutableStateFlow<Map<Place, List<ViewInfo>>>(emptyMap())

    val rows: StateFlow<List<ViewRow>> = combine(overview, offered, ::viewRows)
        .stateIn(viewModelScope, SharingStarted.Eagerly, viewRows(overview.value, offered.value))

    /** Whether the list is being asked for again, as the person pulled it. */
    var refreshing by mutableStateOf(false)
        private set

    /** The workspaces to ask about: those of the computers that can be reached now. */
    private val asking = overview.map { now ->
        val reachable = now.devices.filter { it.reachable }.map { it.id }.toSet()
        placesOf(now).filter { it.device in reachable }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    init {
        // A state flow: told only when the workspaces to ask about are others.
        viewModelScope.launch { asking.collectLatest(::ask) }
    }

    /** Asks again, as the tab is opened: what the computers offer may have changed since. */
    fun again() {
        viewModelScope.launch { ask(asking.value) }
    }

    /** Asks again, as the person pulled the list down: [refreshing] until every computer answered. */
    fun refresh() {
        if (refreshing) return
        refreshing = true
        viewModelScope.launch {
            try {
                ask(asking.value)
            } finally {
                refreshing = false
            }
        }
    }

    /** Asks each of [places] at once; what one cannot say now, it said last. */
    private suspend fun ask(places: List<Place>) = coroutineScope {
        places.map { place ->
            async {
                try {
                    place to phone.views(place.device, place.workspace)
                } catch (e: PhoneException) {
                    null
                }
            }
        }.awaitAll().filterNotNull().forEach { (place, views) -> offered.update { it + (place to views) } }
    }
}
