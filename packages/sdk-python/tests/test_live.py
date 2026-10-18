"""The clients against a real ``hive host``, started from source with a data folder of its own: a
grant's token is let in at its role, a method the role lacks is FORBIDDEN, and taking the grant
back closes the connection. Needs bun and the repo's packages installed (``pnpm install``)."""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from hivemind_api import ApiError, connect
from hivemind_api import aio

CLI = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "apps", "cli", "src", "index.ts"))
BUN = shutil.which("bun")


@unittest.skipIf(sys.platform == "win32" or BUN is None, "needs bun, and a Unix socket")
class LiveHost(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # sun_path is ~108 bytes; the default temp folder can be deep, /tmp is not.
        cls.dir = tempfile.mkdtemp(prefix="hivemind-api-live-", dir="/tmp")
        cls.workspace = os.path.join(cls.dir, "work")
        cls.data = os.path.join(cls.dir, "data")
        cls.socket = os.path.join(cls.data, "drive.sock")
        os.makedirs(cls.workspace)
        os.makedirs(os.path.join(cls.dir, "home"))
        # Its own home, so no hive-net or settings of this machine's are found, and no tile's sockets.
        cls.env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.path.join(cls.dir, "home"),
            "HIVEMIND_APP_DATA": cls.data,
            "HIVEMIND_PTY_SOCK": os.path.join(cls.dir, "pty.sock"),
            "HIVEMIND_SHELL_ENV": "0",
        }
        cls.host = subprocess.Popen([BUN, CLI, "host", "run"], env=cls.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        until = time.monotonic() + 30
        while not os.path.exists(cls.socket) and time.monotonic() < until:
            time.sleep(0.1)
        cls.hive("host", "add", cls.workspace)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.host.terminate()
        cls.host.wait(10)
        # The terminals' daemon `hive host` started outlives it by design: stop it by its socket.
        subprocess.run([BUN, CLI, "daemon", "stop"], env=cls.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        shutil.rmtree(cls.dir, ignore_errors=True)

    @classmethod
    def hive(cls, *args: str) -> dict:
        r = subprocess.run([BUN, CLI, *args, "--json"], env=cls.env, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError("hive %s: %s%s" % (" ".join(args), r.stdout, r.stderr))
        return json.loads(r.stdout)["data"]

    def test_a_grant_drives_its_workspace_at_its_role_until_it_is_taken_back(self) -> None:
        made = self.hive("grant", "create", "dashboard", "-w", self.workspace, "--role", "view")
        with connect(token=made["token"], socket=self.socket) as hive:
            self.assertEqual(hive.as_, {"client": "dashboard", "role": "view", "workspace": os.path.realpath(self.workspace)})
            self.assertEqual(hive.agents.list(), {"seq": 0, "agents": []})
            with self.assertRaises(ApiError) as refused:
                hive.agents.start({"program": "claude", "prompt": "Run the tests"})
            self.assertEqual(refused.exception.code, "FORBIDDEN")

            self.hive("grant", "revoke", made["grant"]["id"])
            self.assertTrue(hive.closed.wait(5), "still open after the revoke")
            with self.assertRaises(ApiError) as after:
                hive.agents.list()
            self.assertEqual(after.exception.code, "UNAVAILABLE")

    def test_the_asyncio_client_drives_the_same_way(self) -> None:
        made = self.hive("grant", "create", "watcher", "-w", self.workspace, "--role", "view")

        async def run() -> None:
            async with await aio.connect(token=made["token"], socket=self.socket) as hive:
                self.assertEqual(await hive.agents.list(), {"seq": 0, "agents": []})
                with self.assertRaises(ApiError) as refused:
                    await hive.call("agent.close", ["t1"])
                self.assertEqual(refused.exception.code, "FORBIDDEN")

        asyncio.run(run())

    def test_a_token_that_is_no_grant_is_refused(self) -> None:
        with self.assertRaises(ApiError) as refused:
            connect(token="hgr_nothing", workspace=self.workspace, socket=self.socket)
        self.assertEqual(refused.exception.code, "FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
