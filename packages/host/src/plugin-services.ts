/**
 * What a tool plugin's service asks of the host about its own plugin, over its drive connection
 * (design jira-sync §12.3-5), and the commands it answers:
 *
 * - `plugin.options`: its settings' values as the person set them (each checked against its
 *   field), and which of its secrets are set. Once it has asked, each change the person makes is
 *   sent to it as `options.changed`, as a setting changed does not start it again.
 * - `secret.get`: one of its own secrets, never another plugin's.
 * - `plugin.serve`: the commands it answers. `hive ctl plugin call` runs one there when no window
 *   runs the plugin (`call`): the host sends `plugin.called {call, command, args}` on that
 *   connection, and the service answers with `plugin.answer(call, {result} | {error})`.
 *
 * - `tileCall`: a tool's own tile asks its service (the tile SDK's `host.call`), as an agent's
 *   `plugin call` does, without going through a window first.
 *
 * A service is its grant: the grant's plugin is the only one it speaks for, and a connection that
 * holds no service's grant (the person, an agent, another program) is refused. The person sets a
 * secret with `secret.set` (from `hive plugins set`); a service sets only its own plugin's declared
 * secrets (the Jira service keeps its sign-in), signed in the audit log as itself. Electron-free.
 */
import { COMMAND_NAME_RE, parsePluginCommands, type PluginCommand } from "@hivemind/view-sdk/commands";
import { FIELD_ID, pluginOptions, resolveSettings, type PluginState, type SettingField } from "@hivemind/core/plugin-settings";
import { ApiError, text, type ErrorCode } from "@hivemind/workspace-api/protocol";
import { emit, type Connection, type Domain } from "@hivemind/workspace-api/server";
import { PLUGIN_CALL_MS, type PluginOptions } from "@hivemind/workspace-api/plugins";
import type { KeptBy } from "./secrets.js";

export interface PluginServicesOptions {
  /** The tool plugin whose service holds grant `id`, while it does. */
  pluginOfGrant(id: string): string | undefined;
  /** What the plugin `plugin` is set to now, its secrets' values left out. */
  options(plugin: string): Promise<PluginOptions>;
  /** The secret `name` of the tool plugin `plugin`; null when none is set. */
  secret(plugin: string, name: string): string | null;
  /** Set (null: take away) a secret of a plugin, by its settings key (`tool:@owner/name`). */
  setSecret(key: string, name: string, value: string | null): KeptBy | null;
  /** The ids of the `secret` fields the tool plugin `plugin` declares. */
  secretFields(plugin: string): Promise<string[]>;
}

/** What a tool plugin is set to, as its service reads it: its fields' values (its secrets left out)
 *  and the names of its secrets that are set. */
export function optionsOf(plugin: string, fields: readonly SettingField[], states: Record<string, PluginState>, secrets: string[]): PluginOptions {
  const declared = new Set(fields.filter((f) => f.type === "secret").map((f) => f.id));
  return { values: resolveSettings(fields, pluginOptions(states, "tool", plugin)), secrets: secrets.filter((s) => declared.has(s)) };
}

interface Serving { connection: Connection; commands: PluginCommand[] }
interface Waiting { connection: Connection; plugin: string; resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }

const ERROR_CODES = new Set<string>(["BAD_REQUEST", "NOT_FOUND", "FAILED", "FORBIDDEN", "TIMEOUT", "UNAVAILABLE", "UNSUPPORTED", "RATE_LIMITED"]);
/** What a service's answer may hold at most, as JSON. */
const ANSWER_MAX = 4 * 1024 * 1024;

/** Only the person: at a window of theirs, or on one of their own devices. */
const isPerson = (from: Connection): boolean => from.actor.kind === "person" || (from.actor.kind === "peer" && from.actor.access === "owner" && !from.actor.client);

export class PluginServices {
  /** The services that answer commands, by plugin: the last to say so. */
  private readonly serving = new Map<string, Serving>();
  /** The connections told `options.changed`, by plugin, with what they were told last. */
  private readonly listening = new Map<string, Map<Connection, string>>();
  private readonly waiting = new Map<number, Waiting>();
  private next = 1;

  constructor(private readonly o: PluginServicesOptions) {}

  /** The plugin whose service is at the other end of `from`, or refused. */
  private pluginOf(from: Connection): string {
    const { actor } = from;
    const grant = actor.kind === "peer" && actor.client && actor.person.startsWith("client:") ? actor.person.slice("client:".length) : null;
    const plugin = grant ? this.o.pluginOfGrant(grant) : undefined;
    if (!plugin) throw new ApiError("FORBIDDEN", "only a tool plugin's service asks this, of its own plugin, with the grant it is started with ($HIVE_DRIVE_TOKEN)");
    return plugin;
  }

  private listen(plugin: string, from: Connection, told: string): void {
    let conns = this.listening.get(plugin);
    if (!conns) this.listening.set(plugin, (conns = new Map()));
    conns.set(from, told);
  }

  /** The person changed some plugin's settings: each service that asked for its options and whose
   *  options moved is told. */
  async settingsChanged(): Promise<void> {
    for (const [plugin, conns] of this.listening) {
      const now = await this.o.options(plugin);
      const json = JSON.stringify(now);
      for (const [c, told] of conns) {
        if (told === json || c.closed.aborted) continue;
        conns.set(c, json);
        emit(c, "options.changed", now);
      }
    }
  }

  /** Whether a service answers `command` of `plugin`. */
  serves(plugin: string, command: string): boolean {
    return !!this.serving.get(plugin)?.commands.some((c) => c.name === command);
  }

  /** The commands the services here answer, by plugin. */
  commands(): Array<{ plugin: string; commands: PluginCommand[] }> {
    return [...this.serving].map(([plugin, s]) => ({ plugin, commands: s.commands }));
  }

  /** Run `command` of `plugin` in its service, within `ms`: what it answered. Null when no service
   *  answers that command. */
  call(plugin: string, command: string, args: unknown, ms = PLUGIN_CALL_MS): Promise<unknown> | null {
    const s = this.serving.get(plugin);
    if (!s || !s.commands.some((c) => c.name === command)) return null;
    const call = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(call);
        reject(new ApiError("TIMEOUT", `${plugin}'s service did not answer ${command} within ${Math.round(ms / 1000)} s`));
      }, ms);
      this.waiting.set(call, { connection: s.connection, plugin, resolve, reject, timer });
      emit(s.connection, "plugin.called", { call, command, args: args ?? null });
    });
  }

  /** A tool's tile asking its own plugin's service (`host.call`; the window names the plugin, never
   *  the tile's code): what it answered, or why there is no answer to wait for. */
  tileCall(plugin: unknown, command: unknown, args: unknown): Promise<unknown> {
    if (typeof plugin !== "string" || !plugin || plugin.length > 200) return Promise.reject(new ApiError("BAD_REQUEST", "plugin must be a tool plugin's id"));
    if (typeof command !== "string" || !COMMAND_NAME_RE.test(command)) return Promise.reject(new ApiError("BAD_REQUEST", "command must be one of the service's command names"));
    return this.call(plugin, command, args)
      ?? Promise.reject(new ApiError("UNAVAILABLE", this.serving.has(plugin)
        ? `${plugin}'s service has no command "${command}"`
        : `${plugin}'s service is not running: switch it on for this workspace in Settings ▸ Plugins`));
  }

  domain(): Domain<"secret.get" | "secret.set" | "plugin.options", "plugin.serve" | "plugin.answer"> {
    return {
      answers: {
        "plugin.options": async (from) => {
          const plugin = this.pluginOf(from);
          const now = await this.o.options(plugin);
          this.listen(plugin, from, JSON.stringify(now));
          return now;
        },
        "secret.get": (from, name) => {
          const plugin = this.pluginOf(from);
          const field = text(name, "name");
          if (!FIELD_ID.test(field)) throw new ApiError("BAD_REQUEST", "name is one of the plugin's settings");
          try {
            return this.o.secret(plugin, field);
          } catch (e) {
            throw new ApiError("UNAVAILABLE", (e as Error).message);
          }
        },
        "secret.set": async (from, key, name, value) => {
          const k = text(key, "key"), field = text(name, "name");
          if (!isPerson(from)) {
            // A service keeps what it is given to keep (a sign-in), of its own plugin alone.
            let plugin: string;
            try { plugin = this.pluginOf(from); } catch { throw new ApiError("FORBIDDEN", "only the person at this machine, or a tool plugin's service for its own plugin, sets a plugin's secrets"); }
            if (k !== `tool:${plugin}`) throw new ApiError("FORBIDDEN", `a service sets its own plugin's secrets (tool:${plugin}), not ${k}'s`);
            if (!(await this.o.secretFields(plugin)).includes(field)) throw new ApiError("FORBIDDEN", `${field} is not one of ${plugin}'s secret settings`);
          }
          if (value !== null && typeof value !== "string") throw new ApiError("BAD_REQUEST", "value is text, or null to take it away");
          try {
            const kept = this.o.setSecret(k, field, value as string | null);
            void this.settingsChanged();
            return { kept };
          } catch (e) {
            throw new ApiError("BAD_REQUEST", (e as Error).message);
          }
        },
      },
      effects: {
        // Who set which secret is recorded; its value never is.
        "secret.set": (key, name) => ({ target: typeof key === "string" && typeof name === "string" ? `${key}.${name}` : undefined }),
      },
      notices: {
        "plugin.serve": (from, commands) => {
          const plugin = this.pluginOf(from);
          const parsed = parsePluginCommands(commands);
          if ("error" in parsed) throw new Error(`${plugin}'s service: ${parsed.error}`);
          this.serving.set(plugin, { connection: from, commands: parsed.commands });
        },
        "plugin.answer": (from, call, answer) => {
          const w = typeof call === "number" ? this.waiting.get(call) : undefined;
          // Only the connection asked answers, once.
          if (!w || w.connection !== from) return;
          this.waiting.delete(call as number);
          clearTimeout(w.timer);
          const a = (answer ?? {}) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
          if (JSON.stringify(a)?.length > ANSWER_MAX) return w.reject(new ApiError("FAILED", `${w.plugin}'s service answered more than ${ANSWER_MAX} bytes`));
          if (a.error) {
            const code = typeof a.error.code === "string" && ERROR_CODES.has(a.error.code) ? a.error.code as ErrorCode : "FAILED";
            return w.reject(new ApiError(code, typeof a.error.message === "string" ? a.error.message.slice(0, 2000) : `${w.plugin}'s service failed`));
          }
          w.resolve(a.result ?? null);
        },
      },
      gone: (connection) => {
        for (const [plugin, s] of this.serving) if (s.connection === connection) this.serving.delete(plugin);
        for (const [plugin, conns] of this.listening) if (conns.delete(connection) && conns.size === 0) this.listening.delete(plugin);
        for (const [call, w] of this.waiting) {
          if (w.connection !== connection) continue;
          this.waiting.delete(call);
          clearTimeout(w.timer);
          w.reject(new ApiError("UNAVAILABLE", `${w.plugin}'s service stopped before it answered`));
        }
      },
    };
  }
}
