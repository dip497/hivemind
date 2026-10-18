// Reading test runners' output and adding runs up. No imports: the tests load it as it is.

/** A command line as a program and its arguments, keeping "quoted words" together. No shell. */
export function splitCommand(line) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) words.push(m[1] ?? m[2] ?? m[3]);
  return words.length ? { bin: words[0], args: words.slice(1) } : null;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TIME = /\s+(\[\d+(\.\d+)?\s*m?s\]|\(\d+(\.\d+)?\s*m?s\)|\d+(\.\d+)?\s*m?s)\s*$/;

/**
 * Each test's outcome in one run, from what the runner printed: bun `(pass) name`, TAP and
 * node's test runner `ok 1 - name`, pytest -v `file::name PASSED`, and the check marks jest,
 * vitest and node's spec reporter print, and cargo test's `test name ... ok`. A test named twice
 * failed if either failed.
 */
export function parseRun(output) {
  const outcomes = new Map();
  const put = (name, passed) => {
    name = name.replace(TIME, "").trim();
    if (!name) return;
    outcomes.set(name, outcomes.get(name) === false ? false : passed);
  };
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m;
    if ((m = /^\((pass|fail)\) (.+)$/.exec(line))) put(m[2], m[1] === "pass");
    else if ((m = /^\s*(not ok|ok) \d+(?: -)? ?(.*)$/.exec(line))) {
      if (!/#\s*(SKIP|TODO)\b/i.test(m[2])) put(m[2], m[1] === "ok");
    } else if ((m = /^(\S+::\S+(?:\[[^\]]*\])?)\s+(PASSED|FAILED|ERROR|XPASS|XFAIL)\b/.exec(line))) put(m[1], m[2] === "PASSED" || m[2] === "XFAIL");
    else if ((m = /^(FAILED|ERROR) (\S+::\S+?(?:\[[^\]]*\])?)(?: - .*)?$/.exec(line))) put(m[2], false);
    else if ((m = /^test (\S+) \.\.\. (ok|FAILED)$/.exec(line))) put(m[1], m[2] === "ok");
    else if ((m = /^\s*([✓✔√]|[✕✖×✗✘])\s+(.+)$/.exec(line))) {
      // A file's summary line ("✓ a.test.ts (3 tests) 5ms") is not a test.
      if (!/\(\d+ tests?\b/.test(m[2])) put(m[2], /[✓✔√]/.test(m[1]));
    }
  }
  return outcomes;
}

/** Every test across the runs: how often it passed and failed, and whether it is flaky. */
export function summarize(runs) {
  const tests = new Map();
  runs.forEach((run, i) => {
    for (const [name, passed] of run) {
      const t = tests.get(name) ?? { name, passed: 0, failed: 0, history: Array(runs.length).fill(null) };
      if (passed) t.passed++; else t.failed++;
      t.history[i] = passed;
      tests.set(name, t);
    }
  });
  const rank = (t) => (t.flaky ? 0 : t.failed ? 1 : 2);
  return [...tests.values()].map((t) => ({
    ...t, runs: t.passed + t.failed, passRate: t.passed / (t.passed + t.failed),
    flaky: t.passed > 0 && t.failed > 0,
  })).sort((a, b) => rank(a) - rank(b) || a.passRate - b.passRate || a.name.localeCompare(b.name));
}
