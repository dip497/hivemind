// Jira's timestamp format and the time-zone arithmetic JQL date literals need. No dependency:
// Intl gives the zone offset at an instant, which is all the conversion takes.

const STAMP = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3})\d*)?(Z|[+-]\d\d:?\d\d)$/;

/** Parses `2026-10-22T09:14:00.000+0000` (and the `+01:00` / `Z` forms) to epoch ms. */
export function parseJiraTime(s: string): number {
  const m = STAMP.exec(s);
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, sec, ms = "0", zone] = m;
  const utc = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +sec!, +ms!.padEnd(3, "0"));
  if (zone === "Z") return utc;
  const sign = zone!.startsWith("-") ? -1 : 1;
  const digits = zone!.slice(1).replace(":", "");
  return utc - sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * 60_000;
}

/** Formats epoch ms as Jira does on Cloud: UTC with a `+0000` offset and milliseconds. */
export function formatJiraTime(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "+0000");
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at `instant`, in ms (positive east of Greenwich). */
export function zoneOffset(timeZone: string, instant: number): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** A wall-clock time in `timeZone` as epoch ms (the later instant when a DST gap makes it ambiguous). */
export function zonedToEpoch(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - zoneOffset(timeZone, wall);
  const second = wall - zoneOffset(timeZone, first);
  return second;
}
