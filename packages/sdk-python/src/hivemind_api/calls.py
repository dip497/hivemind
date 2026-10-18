"""Each common job as the call it makes: its method, its params in the order the method takes
them, and how long to wait. The sync and asyncio clients both make these calls."""

from typing import Any, Dict, List, Optional, Tuple

from .errors import ApiError

Request = Tuple[str, List[Any], Optional[int]]

# How long an agent.read call may take past the wait it asks for.
READ_MARGIN_MS = 10_000


def folder(workspace: Optional[str]) -> str:
    if workspace is None:
        raise ApiError("BAD_REQUEST", 'name the workspace: connect(workspace="<its folder>") or HIVE_WORKSPACE')
    return workspace


def agent_list(workspace: Optional[str]) -> Request:
    return "agent.list", [folder(workspace)], None


def agent_since(workspace: Optional[str], seq: int) -> Request:
    return "agent.since", [folder(workspace), seq], None


def agent_start(workspace: Optional[str], start: Dict[str, Any]) -> Request:
    return "agent.start", [folder(workspace), start], None


def agent_read(tile: str, timeout_ms: int) -> Request:
    return "agent.read", [tile, timeout_ms], timeout_ms + READ_MARGIN_MS


def agent_send(tile: str, text: str) -> Request:
    return "agent.send", [tile, text], None


def agent_answer(tile: str, since: int, answer: Dict[str, Any]) -> Request:
    return "agent.answer", [tile, since, answer], None


def agent_output(tile: str, lines: Optional[int]) -> Request:
    return "agent.output", [tile] if lines is None else [tile, lines], None


def agent_interrupt(tile: str) -> Request:
    return "agent.interrupt", [tile], None


def agent_close(tile: str) -> Request:
    return "agent.close", [tile], None


def frame_open(workspace: Optional[str], spec: Dict[str, Any]) -> Request:
    return "frame.open", [folder(workspace), spec], None


def frame_close(workspace: Optional[str], frame: str, options: Optional[Dict[str, Any]]) -> Request:
    params: List[Any] = [folder(workspace), frame]
    if options is not None:
        params.append(options)
    return "frame.close", params, None


def terminal_write(tile: str, data: str, paste: Optional[bool]) -> Tuple[str, List[Any]]:
    return "terminal.write", [tile, data] if paste is None else [tile, data, paste]


def terminal_close(tile: str) -> Tuple[str, List[Any]]:
    return "terminal.close", [tile]
