"""conformance/drive.json against the Python client: a host that plays each case's lines over a
real local socket, and the client as a program uses it."""

import json
import os
import re
import shutil
import socket
import sys
import tempfile
import time
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from hivemind_api import ApiError, Client, connect, drive_socket_path

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "..", "..", "conformance", "drive.json"), encoding="utf-8") as f:
    DRIVE = json.load(f)
WAIT_S = 3.0


class HostEnd:
    """The host's end of one connection: the lines it reads, in order, and the end when it comes."""

    def __init__(self, conn: socket.socket) -> None:
        self.conn = conn
        self.conn.settimeout(WAIT_S)
        self.buf = b""

    def next(self) -> Optional[bytes]:
        while b"\n" not in self.buf:
            try:
                chunk = self.conn.recv(65536)
            except (socket.timeout, OSError):
                return None
            if not chunk:
                return None
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line


def outcome(future: "Future[Any]") -> Dict[str, Any]:
    try:
        return {"value": future.result(WAIT_S)}
    except ApiError as e:
        return {"error": e}


class Places(unittest.TestCase):
    def test_where_the_drive_socket_is(self) -> None:
        for p in DRIVE["places"]:
            with self.subTest(p["name"]):
                self.assertEqual(drive_socket_path(platform=p["platform"], env=p["env"]), p["socket"])


@unittest.skipIf(sys.platform == "win32", "the fake host listens on a Unix socket")
class Cases(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.pop("HIVE_WORKSPACE", None)
        # sun_path is ~108 bytes; the default temp folder can be deep, /tmp is not.
        self.dir = tempfile.mkdtemp(prefix="hivemind-api-", dir="/tmp")
        self.pool = ThreadPoolExecutor(max_workers=8)

    def tearDown(self) -> None:
        self.pool.shutdown(wait=False)
        shutil.rmtree(self.dir, ignore_errors=True)

    def play(self, case: Dict[str, Any], sock: str) -> None:
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(sock)
        server.listen(1)
        server.settimeout(WAIT_S)
        given = case["connect"]
        connecting = self.pool.submit(connect, token=given["token"], workspace=given.get("workspace"), socket=sock)
        host: Optional[HostEnd] = None
        client: Optional[Client] = None
        ids: Dict[str, int] = {}
        calls: Dict[str, "Future[Any]"] = {}
        heard: Dict[str, List[List[Any]]] = {}

        def end() -> HostEnd:
            nonlocal host
            if host is None:
                host = HostEnd(server.accept()[0])
            return host

        def with_ids(v: Any) -> Any:
            if isinstance(v, dict) and isinstance(v.get("id"), str):
                return {**v, "id": ids[v["id"]]}
            return v

        try:
            for step in case["steps"]:
                (kind, arg), = step.items()
                if kind == "host_reads":
                    line = end().next()
                    self.assertIsNotNone(line)
                    got = json.loads(line)
                    if isinstance(arg.get("id"), str):
                        self.assertIsInstance(got.get("id"), int)
                        ids[arg["id"]] = got["id"]
                    self.assertEqual(got, with_ids(arg))
                elif kind == "host_sends":
                    end().conn.sendall((json.dumps(with_ids(arg)) + "\n").encode("utf-8"))
                elif kind == "host_sends_raw":
                    end().conn.sendall(re.sub(r"<id:(\w+)>", lambda m: str(ids[m.group(1)]), arg).encode("utf-8"))
                    time.sleep(0.05)
                elif kind == "host_closes":
                    end().conn.close()
                elif kind == "host_sees_end":
                    self.assertIsNone(end().next())
                elif kind == "connected":
                    client = connecting.result(WAIT_S)
                    self.assertEqual({"as": client.as_, "api": client.api}, arg)
                elif kind == "refused":
                    with self.assertRaises(ApiError) as refused:
                        connecting.result(WAIT_S)
                    self.assertEqual(refused.exception.code, arg["code"])
                    if "message" in arg:
                        self.assertEqual(refused.exception.message, arg["message"])
                elif kind == "call":
                    calls[arg["label"]] = self.pool.submit(client.call, arg["method"], arg["params"], arg.get("timeoutMs"))
                elif kind == "answered":
                    self.assertEqual(outcome(calls[arg["label"]]), {"value": arg["result"]})
                elif kind == "failed":
                    got = outcome(calls[arg["label"]])
                    self.assertIn("error", got)
                    self.assertEqual(got["error"].code, arg["code"])
                    if "message" in arg:
                        self.assertEqual(got["error"].message, arg["message"])
                elif kind == "notice":
                    client.notice(arg["method"], arg["params"])
                elif kind == "listen":
                    got_events: List[List[Any]] = []
                    heard[arg] = got_events
                    client.on(arg, lambda *params, got_events=got_events: got_events.append(list(params)))
                elif kind == "heard":
                    got_events = heard[arg["event"]]
                    until = time.monotonic() + WAIT_S
                    while len(got_events) < len(arg["params"]) and time.monotonic() < until:
                        time.sleep(0.01)
                    self.assertEqual(got_events, arg["params"])
                elif kind == "close":
                    client.close()
                elif kind == "closed":
                    self.assertTrue(client.closed.wait(WAIT_S))
                else:
                    self.fail("conformance/drive.json: no step %s" % kind)
        finally:
            if client is not None:
                client.close()
            if host is not None:
                host.conn.close()
            server.close()

    def test_cases(self) -> None:
        for i, case in enumerate(DRIVE["cases"]):
            with self.subTest(case["name"]):
                self.play(case, os.path.join(self.dir, "%d.sock" % i))


if __name__ == "__main__":
    unittest.main()
