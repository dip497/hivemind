"""The sync client: the asyncio connection runs on a thread of its own, and each call waits for
its answer. Listeners are called on that thread."""

import asyncio
import threading
from typing import Any, Callable, Coroutine, Dict, List, Optional, TypeVar, cast

from . import calls
from .connection import Connection, Identity, open_connection
from .places import default_token, default_workspace, drive_socket_path
from .types import AgentList, AgentRead, AgentSince, Answered, FrameClosed, FrameOpened, Started

T = TypeVar("T")


class _LoopThread:
    """An event loop on a daemon thread, so a program that forgets to close still exits."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self.loop.run_forever, name="hivemind-api", daemon=True)
        self._thread.start()

    def run(self, coroutine: "Coroutine[Any, Any, T]") -> T:
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result()

    def soon(self, fn: Callable[[], Any]) -> None:
        self.loop.call_soon_threadsafe(fn)

    def stop(self) -> None:
        if self._thread is threading.current_thread():
            self.loop.call_soon(self.loop.stop)
            return
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join()
        self.loop.close()


def connect(token: Optional[str] = None, workspace: Optional[str] = None, socket: Optional[str] = None) -> "Client":
    """Connect to the drive socket and say hello. ``token`` defaults to ``HCP_TOKEN``,
    ``HIVE_DRIVE_TOKEN``, else the person's token on this machine; ``workspace`` to
    ``HIVE_WORKSPACE``; ``socket`` to ``HIVE_DRIVE_SOCK``, else the app's on this machine."""
    workspace = workspace if workspace is not None else default_workspace()
    runner = _LoopThread()
    try:
        connection = runner.run(open_connection(socket or drive_socket_path(), token if token is not None else default_token(), workspace))
    except BaseException:
        runner.stop()
        raise
    return Client(runner, connection, workspace)


class Client:
    def __init__(self, runner: _LoopThread, connection: Connection, named: Optional[str]) -> None:
        self._runner = runner
        self._connection = connection
        #: Who the host says this is: "person", or {"client"|"agent", "role", "workspace"}.
        self.as_: Identity = connection.as_
        #: The workspace API version the host speaks.
        self.api = connection.api
        #: The workspace's folder: the one a grant or an agent drives, else the one named.
        self.workspace: Optional[str] = named if connection.as_ == "person" else cast(Dict[str, str], connection.as_)["workspace"]
        #: Set when the connection closes, from either end: ``hive.closed.wait()``.
        self.closed = threading.Event()
        runner.run(self._watch_close())
        self.agents = _Agents(self)
        self.frames = _Frames(self)
        self.terminals = _Terminals(self)

    async def _watch_close(self) -> None:
        async def watch() -> None:
            await self._connection.closed.wait()
            self.closed.set()

        asyncio.ensure_future(watch())

    def call(self, method: str, params: Optional[List[Any]] = None, timeout_ms: Optional[int] = None) -> Any:
        """Call any method: its result, or ``ApiError`` with the host's code."""
        return self._runner.run(self._connection.call(method, params, timeout_ms))

    def notice(self, method: str, params: Optional[List[Any]] = None) -> None:
        """Tell the host something it does not answer (a keystroke, a resize)."""
        self._runner.soon(lambda: self._connection.notice(method, params))

    def on(self, event: str, listener: Callable[..., Any]) -> Callable[[], None]:
        """Call ``listener(*params)`` for each ``event``, on the connection's thread; the function
        returned stops."""
        return self._connection.on(event, listener)

    def close(self) -> None:
        if self._runner.loop.is_closed():
            return
        self._runner.soon(self._connection.close)
        self.closed.wait(5)
        self._runner.stop()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _make(self, request: calls.Request) -> Any:
        method, params, timeout_ms = request
        return self.call(method, params, timeout_ms)


class _Agents:
    def __init__(self, client: Client) -> None:
        self._client = client

    def list(self) -> AgentList:
        """The workspace's agents as they are now, and the feed's position (``seq``)."""
        return self._client._make(calls.agent_list(self._client.workspace))

    def since(self, seq: int) -> Optional[AgentSince]:
        """Each change and event after ``seq``; None when the host no longer has them all."""
        return self._client._make(calls.agent_since(self._client.workspace, seq))

    def start(self, start: Dict[str, Any]) -> Started:
        """Start an agent, as the person does at their desktop: ``{"tile": …}``."""
        return self._client._make(calls.agent_start(self._client.workspace, start))

    def read(self, tile: str, timeout_ms: int = 120_000) -> AgentRead:
        """Its reply at the end of its next turn, waiting up to ``timeout_ms`` (0: what is there now)."""
        return self._client._make(calls.agent_read(tile, timeout_ms))

    def send(self, tile: str, text: str) -> Dict[str, bool]:
        """A message for it, typed in as its next prompt once it is at its prompt."""
        return self._client._make(calls.agent_send(tile, text))

    def answer(self, tile: str, since: int, answer: Dict[str, Any]) -> Answered:
        """Answer what it waits on, the wait that began at ``since`` (its ``waiting["since"]``)."""
        return self._client._make(calls.agent_answer(tile, since, answer))

    def output(self, tile: str, lines: Optional[int] = None) -> Dict[str, str]:
        """The last ``lines`` lines it printed."""
        return self._client._make(calls.agent_output(tile, lines))

    def interrupt(self, tile: str) -> Dict[str, bool]:
        return self._client._make(calls.agent_interrupt(tile))

    def close(self, tile: str) -> Dict[str, bool]:
        return self._client._make(calls.agent_close(tile))


class _Frames:
    def __init__(self, client: Client) -> None:
        self._client = client

    def open(self, spec: Dict[str, Any]) -> FrameOpened:
        """A frame bound to a folder of the workspace, or to a worktree on a branch."""
        return self._client._make(calls.frame_open(self._client.workspace, spec))

    def close(self, frame: str, options: Optional[Dict[str, Any]] = None) -> FrameClosed:
        return self._client._make(calls.frame_close(self._client.workspace, frame, options))


class _Terminals:
    def __init__(self, client: Client) -> None:
        self._client = client

    def write(self, tile: str, data: str, paste: Optional[bool] = None) -> None:
        """Type into a terminal (``paste``: hand it over as one block); needs the role ``terminals``."""
        self._client.notice(*calls.terminal_write(tile, data, paste))

    def close(self, tile: str) -> None:
        """End its session for good; needs the role ``agents``."""
        self._client.notice(*calls.terminal_close(tile))
