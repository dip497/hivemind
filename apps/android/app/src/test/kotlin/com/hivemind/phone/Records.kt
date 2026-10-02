package com.hivemind.phone

import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.Device
import com.hivemind.phone.core.DeviceKind
import com.hivemind.phone.core.Entry
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Person
import com.hivemind.phone.core.ScreenLine
import com.hivemind.phone.core.ScreenUpdate
import com.hivemind.phone.core.Tool
import com.hivemind.phone.core.ToolResult
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.core.Waiting
import com.hivemind.phone.core.Who
import com.hivemind.phone.core.Workspace
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Records as the core hands them to the app (docs/design/phone-app-2026-10-02.md §5.2-§5.4), built
// here: the tests drive the app's code with them, and no core runs.

const val DESK = "desk-id"
const val MINUTE = 60_000L

fun agent(
    tile: String,
    name: String = tile,
    state: AgentState = AgentState.WORKING,
    device: String = DESK,
    deviceName: String = "desk",
    workspace: String = "ws-1",
    workspaceName: String = "hivemind",
    waiting: Waiting? = null,
    canInterrupt: Boolean = true,
    since: Long? = null,
) = Agent(
    at = AgentRef(device, workspace, tile),
    name = name,
    workspaceName = workspaceName,
    deviceName = deviceName,
    machine = deviceName,
    program = null,
    state = state,
    since = since?.toULong(),
    waiting = waiting,
    canInterrupt = canInterrupt,
)

fun waiting(kind: WaitKind, since: Long, decide: Boolean = false, plan: String? = null) =
    Waiting(kind = kind, since = since.toULong(), plan = plan, decide = decide)

fun device(
    id: String,
    name: String,
    reachable: Boolean = true,
    awaySince: Long? = null,
    heardAt: Long? = null,
    answeredAt: Long? = heardAt,
) = Device(
    id = id,
    name = name,
    kind = DeviceKind.COMPUTER,
    reachable = reachable,
    awaySince = awaySince?.toULong(),
    heardAt = heardAt?.toULong(),
    answeredAt = answeredAt?.toULong(),
)

fun workspace(id: String, name: String, device: String = DESK, folder: String? = null) =
    Workspace(device = device, id = id, name = name, folder = folder)

fun overview(
    agents: List<Agent> = emptyList(),
    needs: List<Agent> = emptyList(),
    working: Int = 0,
    devices: List<Device> = listOf(device(DESK, "desk", heardAt = 0)),
    workspaces: List<Workspace> = emptyList(),
) = Overview(
    revision = 1u,
    agents = agents,
    needs = needs,
    working = working.toUInt(),
    devices = devices,
    workspaces = workspaces,
    person = Person("Priya", "#3a7bd5"),
)

// What is said (§5.4): by the person; by the agent, its text or a tool it used; by a tool.
fun person(id: String, text: String) = Entry(id = id, at = 0u, who = Who.PERSON, text = text, tool = null, result = null)

fun agentSaid(id: String, text: String) = Entry(id = id, at = 0u, who = Who.AGENT, text = text, tool = null, result = null)

fun toolUse(id: String, use: String, name: String, about: String? = null) =
    Entry(id = id, at = 0u, who = Who.AGENT, text = null, tool = Tool(use, name, about), result = null)

fun toolResult(id: String, use: String, text: String, error: Boolean = false) =
    Entry(id = id, at = 0u, who = Who.TOOL, text = null, tool = null, result = ToolResult(use, text, error))

/** One style run as §5.3 packs it: 16 bytes, little-endian. */
fun run(start: Int, len: Int, col: Int, flags: Int = 0, fg: Int = 0, bg: Int = 0): ByteArray =
    ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN)
        .putShort(start.toShort())
        .putShort(len.toShort())
        .putShort(col.toShort())
        .putShort(flags.toShort())
        .putInt(fg)
        .putInt(bg)
        .array()

fun runs(vararg each: ByteArray): ByteArray = each.fold(ByteArray(0)) { all, one -> all + one }

/** A colour as a run names it: a palette index (top byte 1), or RGB (top byte 2). */
fun palette(index: Int) = (1 shl 24) or index

fun rgb(rgb: Int) = (2 shl 24) or rgb

fun line(index: Long, text: String, runs: ByteArray = run(0, text.length, 0)) = ScreenLine(index.toULong(), text, runs)

fun update(
    revision: Long,
    first: Long,
    count: Long,
    lines: List<ScreenLine>,
    cols: Int = 20,
    rows: Int = 4,
    cursorLine: Long = 0,
    cursorCol: Int = 0,
    cursorVisible: Boolean = false,
) = ScreenUpdate(
    revision = revision.toULong(),
    cols = cols.toUShort(),
    rows = rows.toUShort(),
    firstLine = first.toULong(),
    lineCount = count.toULong(),
    cursorLine = cursorLine.toULong(),
    cursorCol = cursorCol.toUShort(),
    cursorVisible = cursorVisible,
    lines = lines,
)
