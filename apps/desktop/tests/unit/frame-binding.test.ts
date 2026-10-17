// Frames and the machines they run on (R9, machines/frame-binding.ts): a frame bound by a saved
// machine's address is bound to the machine; one on a machine no longer saved goes back to its
// address and still runs there; one that changes nothing is left as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rebindFrames } from "../../src/renderer/src/machines/frame-binding.ts";

const box = { id: "m_1", target: "me@box", hostId: "me@box:22" };

test("a workspace from before: frames at a saved machine's address are bound to it, the rest as they were", () => {
  const frames = [
    { id: "f1", workspacePath: "ssh://me@box/srv/api" },
    { id: "f2", workspacePath: "ssh://me@box/srv/api", worktreePath: "ssh://me@box/srv/api-wt" },
    { id: "f3", workspacePath: "ssh://me@elsewhere/srv" },
    { id: "f4", workspacePath: "/home/me/web" },
  ];
  assert.deepEqual(rebindFrames(frames, [box], []), [
    { id: "f1", workspacePath: "machine://m_1/srv/api" },
    { id: "f2", workspacePath: "machine://m_1/srv/api", worktreePath: "machine://m_1/srv/api-wt" },
    { id: "f3", workspacePath: "ssh://me@elsewhere/srv" },
    { id: "f4", workspacePath: "/home/me/web" },
  ]);
});

test("a machine removed: its frames go back to its address; saved again, to the new machine", () => {
  const frames = [{ id: "f1", workspacePath: "machine://m_1/srv/api" }];
  const back = rebindFrames(frames, [], [box]);
  assert.deepEqual(back, [{ id: "f1", workspacePath: "ssh://me@box/srv/api" }]);
  const again = { ...box, id: "m_2" };
  assert.deepEqual(rebindFrames(back, [again], []), [{ id: "f1", workspacePath: "machine://m_2/srv/api" }]);
  // Removed and saved again at once (another window's edit): straight to the new one.
  assert.deepEqual(rebindFrames(frames, [again], [box]), [{ id: "f1", workspacePath: "machine://m_2/srv/api" }]);
});

test("frames with nothing to change are the same frames", () => {
  const frames = [{ id: "f1", workspacePath: "machine://m_1/srv" }, { id: "f2", workspacePath: "/home/me" }];
  assert.equal(rebindFrames(frames, [box], []), frames);
});
