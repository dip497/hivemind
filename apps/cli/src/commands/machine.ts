/** `hive machine` — saved ssh machines. Nothing is saved unless the probe succeeds. */
import { defineCommand } from "citty";
import { HiveError, isWindowsPlatform, newMachineId, readMachines, resolveMachine, validateLabel, validateTarget, writeMachines, type Machine } from "@hivemind/core";
import { err, ok } from "../format.js";
import { EXIT } from "../exit-codes.js";
import { ensureHive, probe } from "../remote.js";

const EXIT_FOR: Record<string, number> = { machine_unreachable: EXIT.unavailable, machine_not_found: EXIT.notFound, machine_target_invalid: EXIT.usage, machine_label_invalid: EXIT.usage, machine_install_unavailable: EXIT.refused, machine_without_hive: EXIT.refused };
const fail = (ctx: { json: boolean }, e: unknown, fallback: string): never => {
  const code = e instanceof HiveError ? e.code : fallback;
  return err(ctx, code, e instanceof Error ? e.message : String(e), EXIT_FOR[code] ?? EXIT.error);
};

/** `me@build-box:2222` → `build-box`. */
export function defaultLabel(target: string): string {
  return target.replace(/^ssh:\/\//, "").replace(/\/.*$/, "").replace(/^.*@/, "").replace(/:\d+$/, "");
}

const line = (m: Machine) => `${m.id}  ${m.enabled ? "on " : "off"}  ${m.label.padEnd(16)}  ${m.target}${m.platform ? `  (${m.platform})` : ""}  ${m.installHive ? "hive" : "plain ssh"}`;

const addCmd = defineCommand({
  meta: { name: "add", description: "Reach an ssh target and save it as a machine; its terminals run over plain ssh unless --install-hive puts this version's hive there" },
  args: {
    target: { type: "positional", required: true, description: "ssh destination: alias, user@host, or ssh://user@host:port" },
    label: { type: "string", description: "display name (default: the host)" },
    "install-hive": { type: "boolean", description: "put this version's hive there, so terminals keep running when the connection drops (not on Windows yet)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const target = validateTarget(String(args.target));
      const label = validateLabel(String(args.label ?? defaultLabel(target)));
      const list = await readMachines();
      if (list.some((m) => m.target === target)) throw new HiveError("machine_exists", `${target} is already saved as '${list.find((m) => m.target === target)!.label}'`);
      const installHive = !!args["install-hive"];
      const found = installHive ? ensureHive(target) : probe(target);
      const installed = "put" in found && !!found.put;
      const m: Machine = {
        id: newMachineId(), label, target, enabled: true, platform: found.platform,
        ...(found.hivePath ? { hivePath: found.hivePath } : {}), ...(found.kind ? { kind: found.kind } : {}), ...(installHive ? { installHive: true } : {}),
      };
      await writeMachines([...list, m]);
      return ok(ctx, { ...m, hiveVersion: found.hiveVersion ?? null, installed }, () =>
        `added ${m.label} (${m.id}) — ${m.platform}, ${installHive ? `${found.hiveVersion ?? "hive"} at ${m.hivePath}${installed ? " [installed]" : ""}` : "terminals over plain ssh"}`);
    } catch (e) { return fail(ctx, e, "machine_add_failed"); }
  },
});

const installHiveCmd = defineCommand({
  meta: { name: "install-hive", description: "Put this version's hive on a machine, so its terminals keep running when the connection drops; --off goes back to plain ssh for new terminals" },
  args: { machine: { type: "positional", required: true }, off: { type: "boolean", description: "run new terminals over plain ssh; those running keep going" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const list = await readMachines();
      const m = resolveMachine(list, String(args.machine));
      const on = !args.off;
      if (on && isWindowsPlatform(m.platform)) throw new HiveError("machine_install_unavailable", "hive is not put on Windows machines yet: their terminals run over plain ssh");
      const found = on ? ensureHive(m.target) : null;
      await writeMachines(list.map((x) => {
        if (x.id !== m.id) return x;
        const { installHive: _was, ...rest } = x;
        return { ...rest, ...(found?.hivePath ? { hivePath: found.hivePath } : {}), ...(on ? { installHive: true } : {}) };
      }));
      return ok(ctx, { id: m.id, installHive: on, ...(found ? { hivePath: found.hivePath ?? null, installed: !!found.put } : {}) }, () =>
        on ? `${m.label}: hive ${found!.hiveVersion ?? ""} at ${found!.hivePath}${found!.put ? " [installed]" : ""}` : `${m.label}: new terminals run over plain ssh`);
    } catch (e) { return fail(ctx, e, "machine_install_failed"); }
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List saved machines" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const list = await readMachines();
      return ok(ctx, { machines: list }, () => (list.length ? list.map(line).join("\n") : "no machines — `hive machine add <ssh-target>`"));
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
        `${m.label}: reachable, ${found.platform}, ${!m.installHive ? "terminals over plain ssh" : found.hivePath ? `hive ${found.hiveVersion ?? ""} at ${found.hivePath}` : "hive is put there the first time it is used"}`);
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
  subCommands: { add: addCmd, list: listCmd, check: checkCmd, "install-hive": installHiveCmd, rename: renameCmd, enable: setEnabled(true), disable: setEnabled(false), remove: removeCmd },
});
