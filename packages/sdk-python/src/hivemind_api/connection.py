"""One connection to the drive socket (spec/workspace-api.md "Drive socket"), on asyncio: it says
hello with a token, then carries calls answered by their id, notices, and the events the host
sends, singly or several to a line. A Unix socket, or the app's named pipe on Windows."""

import asyncio
import json
import logging
import os
import sys
from typing import Any, Callable, Dict, List, Optional, Union

from .errors import ApiError

log = logging.getLogger("hivemind_api")

DEFAULT_TIMEOUT_MS = 30_000
# The host sends lines of up to 1 MiB; a list of events may come close to it.
LINE_LIMIT = 16 * 1024 * 1024

Identity = Union[str, Dict[str, str]]
Listener = Callable[..., Any]


def _unavailable(message: str) -> ApiError:
    return ApiError("UNAVAILABLE", message)


def _from_host(error: Any) -> ApiError:
    error = error if isinstance(error, dict) else {}
    code = error.get("code") if isinstance(error.get("code"), str) else "FAILED"
    message = error.get("message") if isinstance(error.get("message"), str) else code
    return ApiError(code, message)


async def _open_stream(socket: str):
    if sys.platform == "win32":
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=LINE_LIMIT, loop=loop)
        protocol = asyncio.StreamReaderProtocol(reader, loop=loop)
        transport, _ = await loop.create_pipe_connection(lambda: protocol, socket)  # type: ignore[attr-defined]
        return reader, asyncio.StreamWriter(transport, protocol, reader, loop)
    return await asyncio.open_unix_connection(socket, limit=LINE_LIMIT)


class Connection:
    """A connection the host has said hello on. Its methods run on the loop that opened it."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._next = 1
        self._waiting: Dict[int, "asyncio.Future[Any]"] = {}
        self._listeners: Dict[str, List[Listener]] = {}
        self._welcome: "asyncio.Future[Dict[str, Any]]" = asyncio.get_running_loop().create_future()
        self.closed = asyncio.Event()
        self.as_: Identity = "person"
        self.api = ""
        self._reading = asyncio.ensure_future(self._read())

    async def _read(self) -> None:
        try:
            while True:
                try:
                    line = await self._reader.readline()
                except (ConnectionError, OSError):
                    break
                if not line:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                self._take(message)
        finally:
            self._end()

    def _take(self, message: Any) -> None:
        # The events of one moment may come as a list on one line.
        if isinstance(message, list):
            for event in message:
                self._hear(event)
            return
        if not isinstance(message, dict):
            return
        if not self._welcome.done():
            hello = message.get("hello")
            if isinstance(hello, dict) and "as" in hello:
                self._welcome.set_result(hello)
            else:
                self._welcome.set_exception(_from_host(message.get("error")))
                self._writer.close()
            return
        msg_id = message.get("id")
        if isinstance(msg_id, int) and not isinstance(msg_id, bool):
            future = self._waiting.pop(msg_id, None)
            if future is not None and not future.done():
                if "error" in message:
                    future.set_exception(_from_host(message["error"]))
                else:
                    future.set_result(message.get("result"))
            return
        self._hear(message)

    def _hear(self, message: Any) -> None:
        if not isinstance(message, dict) or not isinstance(message.get("event"), str):
            return
        params = message.get("params") if isinstance(message.get("params"), list) else []
        for listener in list(self._listeners.get(message["event"], [])):
            # One listener's failure stops neither the others nor the connection.
            try:
                listener(*params)
            except Exception:
                log.exception("a listener for %s failed", message["event"])

    def _end(self) -> None:
        if not self._welcome.done():
            self._welcome.set_exception(_unavailable("the drive socket closed before it said who this is"))
        for future in self._waiting.values():
            if not future.done():
                future.set_exception(_unavailable("the connection closed before the answer came"))
        self._waiting.clear()
        self.closed.set()

    async def hello(self, token: str, workspace: Optional[str]) -> None:
        line: Dict[str, Any] = {"token": token}
        if workspace:
            line["workspace"] = workspace
        self._writer.write((json.dumps({"hello": line}) + "\n").encode("utf-8"))
        await self._writer.drain()
        hello = await self._welcome
        self.as_ = hello["as"]
        self.api = str(hello.get("api", ""))

    async def call(self, method: str, params: Optional[List[Any]] = None, timeout_ms: Optional[int] = None) -> Any:
        if self.closed.is_set():
            raise _unavailable("the connection is closed")
        msg_id = self._next
        self._next += 1
        loop = asyncio.get_running_loop()
        future: "asyncio.Future[Any]" = loop.create_future()
        self._waiting[msg_id] = future
        wait_ms = DEFAULT_TIMEOUT_MS if timeout_ms is None else timeout_ms

        def give_up() -> None:
            if self._waiting.pop(msg_id, None) is not None and not future.done():
                future.set_exception(ApiError("TIMEOUT", "no answer to %s within %d ms" % (method, wait_ms)))

        timer = loop.call_later(wait_ms / 1000, give_up)
        try:
            self._writer.write((json.dumps({"id": msg_id, "method": method, "params": params or []}) + "\n").encode("utf-8"))
            await self._writer.drain()
            return await future
        except (ConnectionError, OSError) as e:
            self._waiting.pop(msg_id, None)
            raise _unavailable("the connection closed: %s" % e) from None
        finally:
            timer.cancel()

    def notice(self, method: str, params: Optional[List[Any]] = None) -> None:
        if not self.closed.is_set():
            self._writer.write((json.dumps({"method": method, "params": params or []}) + "\n").encode("utf-8"))

    def on(self, event: str, listener: Listener) -> Callable[[], None]:
        self._listeners.setdefault(event, []).append(listener)

        def off() -> None:
            if listener in self._listeners.get(event, []):
                self._listeners[event].remove(listener)

        return off

    def close(self) -> None:
        self._writer.close()


async def open_connection(socket: str, token: str, workspace: Optional[str]) -> Connection:
    """Open ``socket``, say hello, and return once the host says who this is."""
    if sys.platform != "win32" and not os.path.exists(socket):
        raise _unavailable("neither the hivemind app nor `hive host` is running (no socket at %s)" % socket)
    try:
        reader, writer = await _open_stream(socket)
    except OSError as e:
        raise _unavailable("the drive socket is not answering: %s" % e) from None
    connection = Connection(reader, writer)
    try:
        await connection.hello(token, workspace)
    except (ConnectionError, OSError) as e:
        connection.close()
        raise _unavailable("the drive socket closed before it said who this is: %s" % e) from None
    except BaseException:
        connection.close()
        raise
    return connection
