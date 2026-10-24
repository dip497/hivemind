# Upstream issue: WriteBuffer.flushSync parses chunks a second time

Text for an issue at github.com/xtermjs/xterm.js. Not filed. Our fix is the pnpm patches
`patches/@xterm__headless@6.1.0-beta.313.patch` and `patches/@xterm__xterm@6.1.0-beta.315.patch`
(`patchedDependencies` in `pnpm-workspace.yaml`). Drop them once a release carries the fix.

---

**Title:** `resize()` during an async write burst parses already-written chunks again (and an
empty write drops what follows)

**Versions:** `@xterm/xterm` 6.1.0-beta.315 and `@xterm/headless` 6.1.0-beta.313 (the same
`src/common/input/WriteBuffer.ts`). Node 24 and Electron 44.

**Repro** (node, `@xterm/headless`; the same with `@xterm/xterm`):

```js
const { Terminal } = require("@xterm/headless");
const t = new Terminal({ cols: 80, rows: 24, scrollback: 1000 });
const heavy = (i) => "\x1b[2K".repeat(50000) + `chunk ${i}\r\n`; // ~20 ms each to parse
const calls = new Array(10).fill(0);
for (let i = 0; i < 10; i++) t.write(heavy(i), () => {
  if (++calls[i] === 1 && i === 0) setTimeout(() => t.resize(100, 30), 0); // in the first pause
});
setTimeout(() => console.log(calls), 2000); // [2, 1, 1, …]: "chunk 0" is also on screen twice
```

Two smaller cases fail the same way:

- `write("a", () => t.resize(90, 24)); write("b")`: `a` is parsed and called back twice.
- `write("a"); write(""); write("b", cb); resize(90, 24)`: `b` is never parsed and `cb` never runs.

**Cause.** `_innerWrite` keeps chunks it has parsed in `_writeBuffer`, with `_bufferOffset`
pointing at the next one, and trims them only past `WRITE_BUFFER_LENGTH_THRESHOLD` (50). When it
yields (`WRITE_TIMEOUT_MS`) with work left, the parsed chunks are still at the front of the array.
`flushSync()`, which `resize()` calls, drains with `while (chunk = this._writeBuffer.shift())` from
index 0, so it parses them, and calls their callbacks, again. Also:

1. `_innerWrite` calls a chunk's callback before `_bufferOffset++`, so a callback that resizes
   makes `flushSync` take that chunk as unparsed too.
2. The loop's test is the chunk's truthiness: an empty string ends it, and the reset after the loop
   (`_writeBuffer.length = 0`) throws away that chunk, its callback and every write behind it.

`writeSync` has the same `shift()` loop; we do not use it.

**Proposed fix** (what our patch does):

```diff
 public flushSync(): void {
   …
-  while (chunk = this._writeBuffer.shift()) {
+  // chunks before _bufferOffset were parsed by _innerWrite already
+  this._writeBuffer.splice(0, this._bufferOffset);
+  this._callbacks.splice(0, this._bufferOffset);
+  while (this._writeBuffer.length) {
+    chunk = this._writeBuffer.shift()!;
     didProcess = true;
     this._action(chunk);
```

```diff
       const cb = this._callbacks[this._bufferOffset];
-      if (cb) cb();
       this._bufferOffset++;
       this._pendingData -= data.length;
+      if (cb) cb();   // a callback may resize (flushSync): count this chunk as parsed first
```

After a flush `_bufferOffset` is `0x7FFFFFFF`, so the loop in an `_innerWrite` that called the
callback ends, and its `else` branch resets the buffer as before. A chunk paused on an async
handler (a promise) is not counted until it resolves, so a flush still parses it again from the
start; the method's comment already says flushSync is unreliable with async handlers.

**Cost.** Two `splice` calls per flush (a resize); nothing per write.
