// A project you clone can commit `.hivemind` as a link: `hive init` must not write where it points.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers";

test("hive init refuses a .hivemind that is a link, and writes nothing where it points", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-init-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-outside-")));
  fs.symlinkSync(outside, path.join(dir, ".hivemind"));

  const r = hive(["init", "--prefix", "AB", "--json"], { cwd: dir });

  expect(r.code).not.toBe(0);
  expect(JSON.stringify(r.json)).toContain("LINKED_ROOT");
  expect(fs.readdirSync(outside)).toEqual([]);
});
