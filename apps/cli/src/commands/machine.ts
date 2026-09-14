/** `hive machine` — saved ssh machines. Nothing is saved unless the probe succeeds. */
import { defineCommand } from "citty";
import { HiveError, newMachineId, readMachines, resolveMachine, validateLabel, validateTarget, writeMachines, type Machine } from "@hivemind/core";
import { err, ok } from "../format.js";
import { EXIT } from "../hcp.js";
import { installSelf, probe, type ProbeResult } from "../remote.js";

const EXIT_FOR: Record<string, number> = { machine_unreachable: EXIT.unavailable, machine_not_found: EXIT.notFound, machine_target_invalid: EXIT.usage, machine_label_invalid: EXIT.usage };
const fail = (ctx: { json: boolean }, e: unknown, fallback: string): never => {
  const code = e instanceof HiveError ? e.code : fallback;
  return err(ctx, code, e instanceof Error ? e.message : String(e), EXIT_FOR[code] ?? EXIT.error);
};

/** `me@build-box:2222` → `build-box`. */
export function defaultLabel(target: string): string {
  return target.replace(/^ssh:\/\//, "").replace(/\/.*$/, "").replace(/^.*@/, "").replace(/:\d+$/, "");
}

const line = (m: Machine) => `${m.id}  ${m.enabled ? "on " : "off"}  ${m.label.padEnd(16)}  ${m.target}${m.platform ? `  (${m.platform})` : ""}`;

const addCmd = defineCommand({
  meta: { name: "add", description: "Probe an ssh target and save it as a machine" },
  args: {
    target: { type: "positional", required: true, description: "ssh destination: alias, user@host, or ssh://user@host:port" },
    label: { type: "string", description: "display name (default: the host)" },
    install: { type: "boolean", description: "if hive is missing there, put it in ~/.local/bin/hive (this binary, or the same version's release download)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const target = validateTarget(String(args.target));
      const label = validateLabel(String(args.label ?? defaultLabel(target)));
      const list = await readMachines();
      if (list.some((m) => m.target === target)) throw new HiveError("machine_exists", `${target} is already saved as '${list.find((m) => m.target === target)!.label}'`);
      let found: ProbeResult = probe(target);
      let installed = false;
      if (!found.hivePath || !found.daemon) {
        const what = found.hivePath ? `hive ${found.hiveVersion ?? ""} on ${target} is too old for terminal sessions` : `hive is not installed on ${target} (${found.platform})`;
        if (!args.install) throw new HiveError("machine_no_hive", `${what} — rerun with --install, or install hive-${found.platform} there`);
        installSelf(target, found.platform);
        installed = true;
        found = probe(target);
        if (!found.hivePath || !found.daemon) throw new HiveError("machine_install_failed", `installed hive on ${target} but the probe still cannot run its daemon`);
      }
      const m: Machine = { id: newMachineId(), label, target, enabled: true, hivePath: found.hivePath!, platform: found.platform };
      await writeMachines([...list, m]);
      return ok(ctx, { ...m, hiveVersion: found.hiveVersion ?? null, installed }, () =>
        `added ${m.label} (${m.id}) — ${m.platform}, ${found.hiveVersion ?? "hive"} at ${m.hivePath}${installed ? " [installed]" : ""}`);
    } catch (e) { return fail(ctx, e, "machine_add_failed"); }
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List saved machines" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const list = await readMachines();
      return ok(ctx, list, () => (list.length ? list.map(line).join("\n") : "no machines — `hive machine add <ssh-target>`"));
    } catch (e) { return fail(ctx, e, "machine_list_failed"); }
  },
});

const checkCmd = defineCommand({
  meta: { name: "check", description: "Re-probe a machine: reachable, platform, hive path and version" },
  args: { machine: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const list = await readMachines();
      const m = resolveMachine(list, String(args.machine));
      const found = probe(m.target);
      // hive may have moved or been installed since `add`.
      if (found.hivePath !== m.hivePath || found.platform !== m.platform) {
        const next = list.map((x) => (x.id === m.id ? { ...x, platform: found.platform, ...(found.hivePath ? { hivePath: found.hivePath } : {}) } : x));
        await writeMachines(next);
      }
      return ok(ctx, { id: m.id, label: m.label, reachable: true, ...found }, () =>
        `${m.label}: reachable, ${found.platform}, ${found.hivePath ? `${found.hiveVersion ?? "hive"} at ${found.hivePath}` : "hive NOT installed"}`);
    } catch (e) { return fail(ctx, e, "machine_check_failed"); }
  },
});

const renameCmd = defineCommand({
  meta: { name: "rename", description: "Change a machine's label" },
  args: { machine: { type: "positional", required: true }, label: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const list = await readMachines();
      const m = resolveMachine(list, String(args.machine));
      const label = validateLabel(String(args.label));
      await writeMachines(list.map((x) => (x.id === m.id ? { ...x, label } : x)));
      return ok(ctx, { id: m.id, label }, () => `renamed ${m.id} → ${label}`);
    } catch (e) { return fail(ctx, e, "machine_rename_failed"); }
  },
});

const setEnabled = (enabled: boolean) => defineCommand({
  meta: { name: enabled ? "enable" : "disable", description: enabled ? "Enable a machine" : "Disable a machine (kept, not connected)" },
  args: { machine: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const list = await readMachines();
      const m = resolveMachine(list, String(args.machine));
      await writeMachines(list.map((x) => (x.id === m.id ? { ...x, enabled } : x)));
      return ok(ctx, { id: m.id, enabled }, () => `${enabled ? "enabled" : "disabled"} ${m.label}`);
    } catch (e) { return fail(ctx, e, "machine_update_failed"); }
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Forget a machine (its remote sessions keep running)" },
  args: { machine: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const list = await readMachines();
      const m = resolveMachine(list, String(args.machine));
      await writeMachines(list.filter((x) => x.id !== m.id));
      return ok(ctx, { id: m.id, removed: true }, () => `removed ${m.label} — its sessions on ${m.target} are still running`);
    } catch (e) { return fail(ctx, e, "machine_remove_failed"); }
  },
});

export const machineCmd = defineCommand({
  meta: { name: "machine", description: "Saved ssh machines for --machine (auth stays with OpenSSH)" },
  subCommands: { add: addCmd, list: listCmd, check: checkCmd, rename: renameCmd, enable: setEnabled(true), disable: setEnabled(false), remove: removeCmd },
});
