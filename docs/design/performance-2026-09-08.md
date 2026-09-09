# Performance check: 2026-09-08

> **Superseded, 2026-09-09.** Every measurement below was taken under Xvfb on the
> `llvmpipe` CPU rasterizer, at system load 23–48 on a 16-CPU machine. Repeating the
> same script at the same window size on the real display (`ANGLE (Intel, Mesa Intel(R)
> UHD Graphics (TGL GT1), OpenGL 4.6)`) at load 3 gives 53–61 FPS in every scene with
> zero long tasks, including with full effects. See
> [performance-native-2026-09-09.md](performance-native-2026-09-09.md). Read the FPS
> tables below as evidence about software rendering, not about this application.


Status: functional gates pass; performance is not release-ready.

The measured build includes per-workspace tile-surface reuse and serialized settings
writes. Desktop build/typechecks, 445 desktop unit tests, 40 targeted core/CLI tests,
and 30 focused Electron tests passed. These checks establish behavior, not FPS.

## Conditions

Four shell terminals, each printing about 50 lines/second, in an isolated Electron
profile. Xvfb at 1600×1000, using the existing `scripts/perf-views.mjs` harness. Other
desktop applications were running. No parallel build/test workloads were intentionally
scheduled during these measurements. The actual GL renderer was not recorded.
These Xvfb results are neither a verified hardware-accelerated benchmark nor an
isolated before/after test of tile reuse.

FPS comes from requestAnimationFrame intervals. Timer lag is the p95 drift of a 16 ms
timer, an event-loop responsiveness proxy; it is not measured key-to-paint latency.

## Full diagnostic run

| Scene | FPS | p95 frame interval | p95 timer lag |
|---|---:|---:|---:|
| Canvas, quiet | 29.6 | 159.4 ms | 1.9 ms |
| Canvas, streaming | 3.8 | 329.5 ms | 7.6 ms |
| Canvas, streaming + typing | 2.8 | 597.4 ms | 31.2 ms |
| World, quiet | 60.3 | 17.5 ms | 0.3 ms |
| World, docked + typing | 4.8 | 265.3 ms | 35.9 ms |
| Community, quiet | 60.3 | 17.3 ms | 0.2 ms |
| Community, docked + typing | 5.6 | 239.5 ms | 33.2 ms |
| CPU-heavy plugin, docked + typing | 1.4 | 1359.8 ms | 34.0 ms |

World-to-Canvas median transition: 2484 ms. The largest recorded long-task total for
a World switch was 2620 ms. Community-to-Canvas after undocking took 1964 ms, with
1745 ms of long tasks. All switch groups retained four xterm instances, and all three
docked typing scenes confirmed terminal focus.

The docked timer-lag deltas stayed within Canvas +5 ms in this run. That does **not**
make it a passing performance result: Canvas itself was slow, frame intervals were
poor, and transitions took seconds. Relative input gates need absolute frame-time
and latency budgets alongside them.

Raw results: [full run](perf/2026-09-08-refactor.json).

## Effects comparison

A second probe used the same harness through the Canvas typing scene, skipping
World/community scenes. It ran sequentially with default effects, then with
`appearance.glass.enabled=false`, `appearance.glass.animate=false`, and
`appearance.wallpaper.kind="none"`. Each probe read the effective settings back from
the app; both used isolated profiles and four terminals.

| Scene | Default effects FPS | Effects disabled FPS |
|---|---:|---:|
| Quiet Canvas | 30.8 | 60.2 |
| Streaming | 4.5 | 11.7 |
| Streaming + typing | 2.3 | 11.4 |

Typing timer lag did not improve: p95 was 14.4 ms with defaults and 35.6 ms with
effects disabled. Disabling effects improved frame delivery in this setup, but is
not a complete latency fix. These single sequential samples do not establish native
GPU performance or isolate blur from wallpaper/animation individually.

Raw results: [default effects](perf/2026-09-08-effects-default.json),
[effects disabled](perf/2026-09-08-effects-off.json).

## Next work

1. Collect a hardware-accelerated baseline with a recorded GPU/driver and controlled
   background load. Repeat the same workload and confirm actual terminal input latency.
2. Profile terminal streaming, compositor work, resize/reflow, and the undock-to-Canvas
   transition. Quiet scene views reaching 60 FPS while docked views degrade makes
   terminal/compositing work a candidate, not proof of a specific root cause.
3. Define a host performance/quality policy before exposing more plugin settings.
   Keep visual effects configurable, with a cheap baseline and explicit expensive
   options. Do not change existing user preferences based solely on this headless run.

The tile-reuse change has reference-invalidation tests, including changed callbacks;
this run cannot quantify its improvement without an otherwise identical baseline.
Do not describe the app as zero-lag or the performance refactor as finished.

## Follow-up: renderer scheduling

A view commit previously reconciled all terminal clients for each surface event.
Reconciliation now runs once in a microtask after those DOM mutations. A unit test
with eight clients and repeated notifications checks one priority read per client,
no acquisition for terminals removed before the pass, and no context churn when a
park/adopt sequence ends with the same visible terminals. A separate budget test
checks that displaced contexts are released before replacements are acquired.
Unmount still releases its context immediately.

Preserved terminals now subscribe to the effective surface policy separately from
the saved theme. The runtime view gate can change while the theme object retains
its identity; the old subscription missed that update.

These changes remove redundant work and fix stale transparency. No before/after FPS
improvement has been established. An exploratory `--disable-webgl` probe still had
three WebGL terminals, so it cannot support a DOM-versus-WebGL comparison.

Verification for this follow-up: desktop typecheck and bundle build passed, all 449
unit tests passed, and all 28 targeted Electron cases passed across Appearance,
view preservation, Windows, World, and host chrome. The Appearance regression's
first attempt used a non-JSON string argument for `hive config set`; after correcting
the test input, all four Appearance cases passed in a fresh isolated profile. The
other 24 cases passed in the original run.

## Recording and verified motion follow-up

See [the 18:05 recording investigation](performance-recording-2026-09-08.md) for
the observed 61-to-15 FPS drop, recorded llvmpipe backend, verified movement
benchmarks, and the limits of earlier fixed-pointer measurements.
