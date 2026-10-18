"""The asyncio client: the same jobs as the sync client, awaited.

    from hivemind_api.aio import connect

    async with await connect() as hive:
        print((await hive.agents.list())["agents"])
"""

from typing import Any, Callable, Dict, List, Optional, cast

from . import calls
from .connection import Connection, Identity, open_connection
from .places import default_token, default_workspace, drive_socket_path
from .types import AgentList, AgentRead, AgentSince, Answered, FrameClosed, FrameOpened, Started


async def connect(token: Optional[str] = None, workspace: Optional[str] = None, socket: Optional[str] = None) -> "AsyncClient":
    """Connect to the drive socket and say hello. ``token`` defaults to ``HCP_TOKEN``,
    ``HIVE_DRIVE_TOKEN``, else the person's token on this machine; ``workspace`` to
    ``HIVE_WORKSPACE``; ``socket`` to ``HIVE_DRIVE_SOCK``, else the app's on this machine."""
    workspace = workspace if workspace is not None else default_workspace()
    connection = await open_connection(socket or drive_socket_path(), token if token is not None else default_token(), workspace)
    return AsyncClient(connection, workspace)


class AsyncClient:
    def __init__(self, connection: Connection, named: Optional[str]) -> None:
        self._connection = connection
        #: Who the host says this is: "person", or {"client"|"agent", "role", "workspace"}.
        self.as_: Identity = connection.as_
        #: The workspace API version the host speaks.
        self.api = connection.api
        #: The workspace's folder: the one a grant or an agent drives, else the one named.
        self.workspace: Optional[str] = named if connection.as_ == "person" else cast(Dict[str, str], connection.as_)["workspace"]
        #: Set when the connection closes, from either end.
        self.closed = connection.closed
        self.agents = _Agents(self)
        self.frames = _Frames(self)
        self.terminals = _Terminals(self)

    async def call(self, method: str, params: Optional[List[Any]] = None, timeout_ms: Optional[int] = None) -> Any:
        """Call any method: its result, or ``ApiError`` with the host's code."""
        return await self._connection.call(method, params, timeout_ms)

    def notice(self, method: str, params: Optional[List[Any]] = None) -> None:
        """Tell the host something it does not answer (a keystroke, a resize)."""
        self._connection.notice(method, params)

    def on(self, event: str, listener: Callable[..., Any]) -> Callable[[], None]:
        """Call ``listener(*params)`` for each ``event``; the function returned stops."""
        return self._connection.on(event, listener)

    def close(self) -> None:
        self._connection.close()

    async def __aenter__(self) -> "AsyncClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.close()

    async def _make(self, request: calls.Request) -> Any:
        method, params, timeout_ms = request
        return await self.call(method, params, timeout_ms)


class _Agents:
    def __init__(self, client: AsyncClient) -> None:
        self._client = client

    async def list(self) -> AgentList:
        return await self._client._make(calls.agent_list(self._client.workspace))

    async def since(self, seq: int) -> Optional[AgentSince]:
        return await self._client._make(calls.agent_since(self._client.workspace, seq))

    async def start(self, start: Dict[str, Any]) -> Started:
        return await self._client._make(calls.agent_start(self._client.workspace, start))

    async def read(self, tile: str, timeout_ms: int = 120_000) -> AgentRead:
        return await self._client._make(calls.agent_read(tile, timeout_ms))

    async def send(self, tile: str, text: str) -> Dict[str, bool]:
        return await self._client._make(calls.agent_send(tile, text))

    async def answer(self, tile: str, since: int, answer: Dict[str, Any]) -> Answered:
        return await self._client._make(calls.agent_answer(tile, since, answer))

    async def output(self, tile: str, lines: Optional[int] = None) -> Dict[str, str]:
        return await self._client._make(calls.agent_output(tile, lines))

    async def interrupt(self, tile: str) -> Dict[str, bool]:
        return await self._client._make(calls.agent_interrupt(tile))

    async def close(self, tile: str) -> Dict[str, bool]:
        return await self._client._make(calls.agent_close(tile))


class _Frames:
    def __init__(self, client: AsyncClient) -> None:
        self._client = client

    async def open(self, spec: Dict[str, Any]) -> FrameOpened:
        return await self._client._make(calls.frame_open(self._client.workspace, spec))

    async def close(self, frame: str, options: Optional[Dict[str, Any]] = None) -> FrameClosed:
        return await self._client._make(calls.frame_close(self._client.workspace, frame, options))


class _Terminals:
    def __init__(self, client: AsyncClient) -> None:
        self._client = client

    def write(self, tile: str, data: str, paste: Optional[bool] = None) -> None:
        self._client.notice(*calls.terminal_write(tile, data, paste))

    def close(self, tile: str) -> None:
        self._client.notice(*calls.terminal_close(tile))
