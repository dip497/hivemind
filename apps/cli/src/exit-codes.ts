/**
 * How every `hive` command ends, written once: the exit code for each error code, what each means,
 * and how a failure is printed. `--help` shows the same table, so the two never disagree.
 *
 * A success prints its result on stdout: with `--json`, one JSON object on one line. A failure
 * prints on stderr: with `--json`, `{"error":{"code","message","fix"?}}` on one line; without it,
 * `error [CODE] message` and the fix on the next line. Every failure exits non-zero.
 */

const EXIT_CODES = [
  { name: "ok", exit: 0, codes: [], meaning: "it worked" },
  { name: "error", exit: 1, codes: ["FAILED"], meaning: "it failed for another reason: read the message" },
  { name: "usage", exit: 2, codes: ["USAGE", "BAD_REQUEST", "UNKNOWN_METHOD"], meaning: "the command was written wrong: see its --help" },
  { name: "unavailable", exit: 3, codes: ["UNAVAILABLE"], meaning: "no hivemind app or `hive host` answers" },
  { name: "timeout", exit: 4, codes: ["TIMEOUT"], meaning: "the wait ran out" },
  { name: "notFound", exit: 5, codes: ["NOT_FOUND", "NO_AGENT", "NO_ROOT"], meaning: "what it names is not there, or was closed: a tile, agent, frame, issue or workspace; or the tile runs no agent" },
  { name: "unauthorized", exit: 6, codes: ["FORBIDDEN", "PERSON_ONLY"], meaning: "not yours to do: a bad token, or only the person may: ask them" },
  { name: "refused", exit: 7, codes: ["RATE_LIMITED", "DEPTH_EXCEEDED", "UNSUPPORTED", "OCCLUDED", "PART_OF_A_PACKAGE", "SYNC_LOCKED", "NEEDS_CONFIRM"], meaning: "refused for now, or the agent cannot do it: idle with nothing to read; something covers the tile `tile look` would picture; the plugin changes only with its package; another sync of that source is running; or starting this work needs the person to confirm (see `warnings`)" },
  { name: "waiting", exit: 8, codes: ["WAITING"], meaning: "the agent stopped to wait on an answer" },
  { name: "asleep", exit: 9, codes: ["ASLEEP"], meaning: "the agent is asleep: wake it with `hive ctl wake <tile>`" },
] as const;

type ExitName = (typeof EXIT_CODES)[number]["name"];

/** Each exit code by name: `EXIT.notFound` is 5. */
export const EXIT = Object.fromEntries(EXIT_CODES.map((r) => [r.name, r.exit])) as { readonly [K in ExitName]: Extract<(typeof EXIT_CODES)[number], { name: K }>["exit"] };

/** The exit code for an error code; one the table does not list is 1. */
export function exitCodeFor(code: string): number {
  return EXIT_CODES.find((r) => (r.codes as readonly string[]).includes(code))?.exit ?? EXIT.error;
}

/** The table as `--help` ends with it. */
export function exitCodesHelp(): string {
  const rows = EXIT_CODES.map((r) => `  ${String(r.exit).padEnd(3)}${(r.codes.join(", ") || "-").padEnd(44)}${r.meaning}`);
  return ["EXIT CODES", "", ...rows, "", "With --json, a failure is {\"error\":{\"code\",\"message\",\"fix\"?}} on stderr."].join("\n");
}

/** The help command for what is being run, set once its command is known: a usage error's fix. */
let helpCommand = "hive --help";
export const setHelpCommand = (command: string): void => { helpCommand = command; };
export const helpFor = (): string => helpCommand;

export interface Failure {
  code: string;
  message: string;
  /** What to run or do next. */
  fix?: string;
  /** NEEDS_CONFIRM: each finding of the start-work guard, and what can be done about it. */
  warnings?: { check: string; severity: string; message: string; actions: string[] }[];
}

/** Print `failure` on stderr, as JSON or as text, and exit with its code (from the table unless
 *  given). */
export function printFailure(json: boolean, failure: Failure, exit = exitCodeFor(failure.code)): never {
  const { code, message, fix, warnings } = failure;
  if (json) process.stderr.write(`${JSON.stringify({ error: { code, message, ...(fix ? { fix } : {}), ...(warnings ? { warnings } : {}) } })}\n`);
  else process.stderr.write(`error [${code}] ${message}\n${fix ? `fix: ${fix}\n` : ""}`);
  process.exit(exit === EXIT.ok ? EXIT.error : exit);
}
