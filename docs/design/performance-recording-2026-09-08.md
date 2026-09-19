# Canvas FPS investigation — recording at 18:05, 2026-09-08

> **Superseded, 2026-09-09.** Every measurement below was taken under Xvfb on the
> `llvmpipe` CPU rasterizer, at system load 23–48 on a 16-CPU machine. Repeating the
> same script at the same window size on the real display (`ANGLE (Intel, Mesa Intel(R)
> UHD Graphics (TGL GT1), OpenGL 4.6)`) at load 3 gives 53–61 FPS in every scene with
> zero long tasks, including with full effects. See
> [performance-native-2026-09-09.md](performance-native-2026-09-09.md). Read the FPS
> tables below as evidence about software rendering, not about this application.


Status: performance fails the intended 60 FPS experience. No FPS fix or native-GPU
improvement is claimed by this investigation.

## Recording

Reviewed `~/Videos/Screencasts/Screencast from 2026-09-08 18-05-07.mp4`
(1920×1200, 22.21 seconds). The visible application meter starts at 61 FPS and
shows 15–25 FPS during much of the first eight seconds of canvas movement,
with brief recovery into the 30s. The lowest observed half-second sample is 15.
That is a 59–75% drop from 61, corresponding roughly to 40–67 ms per frame
instead of 16 ms. The meter updates twice per second, so this is not a full
frame-time trace and can miss shorter stalls.

[Sampled FPS meter](perf/2026-09-08-recording-fps.jpg).

The variable-rate video averages about 13.3 captured frames/sec. Recording rate
is not application FPS; the numbers above come from the visible app meter.
The later Settings/Windows scenes do not provide a comparable visible FPS series.

## Benchmark conditions

Current dirty working-tree desktop bundle, including the toolbar refactor.
Three shell terminals, then three loops producing approximately 50 lines/sec each.
This is synthetic output, not a full agent TUI replay. Xvfb, isolated temporary
profile, in-process PTYs, actual content bounds 1919×1199, DPR 1. No user's app
profile or sessions were changed. No build/test workload was intentionally run
alongside the benchmark.

The WebGL renderer was explicitly queried:
`ANGLE (Mesa, llvmpipe (LLVM 20.1.2 256 bits), OpenGL 4.5)`.
This is software rendering. The machine also has Intel/NVIDIA devices, but their
presence and Electron's `gpu_compositing: enabled` do not make this run a
hardware-accelerated benchmark. The recording's actual renderer was not queried.

CPU: i7-11850H, 16 logical CPUs. System load was about 23 at start and 48 at end;
other desktop applications remained running. These are diagnostic measurements,
not an isolated native-GPU regression score or evidence of a particular hardware
FPS improvement.

## Completed run

All six pan cases verified a changed viewport transform halfway through a
symmetric wheel sequence. All returned to the same viewport transform afterwards.
No per-frame screenshots were taken. Profiling ran after timed comparisons.

- `default`: Aurora + glass + animation.
- `static`: same appearance, animation disabled.
- `off`: glass disabled, wallpaper absent, animation disabled.

| Workload | Effects | Scene | FPS | Frame p95 ms | Timer lag p95 ms |
|---|---|---|---:|---:|---:|
| quiet | static | idle | 60.0 | 16.7 | 0.6 |
| quiet | static | pan | 4.3 | 683.4 | 5.7 |
| quiet | default | idle | 2.5 | 566.6 | 6.5 |
| quiet | default | pan | 2.5 | 783.4 | 4.7 |
| quiet | off | idle | 60.0 | 16.8 | 0.8 |
| quiet | off | pan | 15.5 | 216.6 | 3.9 |
| streaming | static | idle | 2.6 | 449.9 | 6.1 |
| streaming | static | pan | 1.5 | 1200.0 | 7.1 |
| streaming | default | idle | 0.5 | 1899.9 | 20.3 |
| streaming | default | pan | 1.0 | 1466.6 | 7.4 |
| streaming | off | idle | 7.0 | 216.7 | 35.1 |
| streaming | off | pan | 1.9 | 999.9 | 13.6 |

[Raw completed run](perf/2026-09-08-canvas-motion.json).

FPS is measured from rAF intervals; timer drift is an event-loop proxy, not actual
key-to-pixel latency. This completed matrix is one pass. Severe stalls leave very
few intervals in the three-second idle samples: the default streaming idle sample
has only one usable interval, so its percentile is not a stable estimate.
Native input delivery stretched pan samples from roughly 8 to 92 seconds; compare
this as responsiveness under the same event sequence, not an equal-duration
throughput test. Aurora's idle guard paused the wallpaper during the longest pan
samples, despite continued wheel input, so those are not pure animation-on trials.

## What the evidence supports

1. **Effects materially increase rendering cost.** Quiet idle was 2.5 FPS with
   animation and 60 FPS with static wallpaper or effects off. Earlier forward/
   reverse quiet-only comparisons also reached 60 with animation stopped.
2. **Animation is not the whole pan problem.** With verified movement, static
   wallpaper still produced 4.3 FPS; removing effects reached 15.5 FPS. Rendering
   moving tool surfaces remains expensive in this software-rendered environment.
3. **Terminal output adds another cost.** Even with effects off, streaming idle
   reached only 7 FPS and streaming pan 1.9 FPS. A wallpaper toggle is not a full
   performance fix.
4. **The visual pipeline is the leading bottleneck candidate.** Frame stalls of
   hundreds of milliseconds coexist with much smaller p95 timer drift. This points
   toward raster/compositing pressure, but does not isolate a specific GPU task.
   A renderer CPU profile alone cannot account for GPU-process time.

The post-comparison, effects-off streaming [CPU profile](perf/2026-09-08-canvas-streaming.cpuprofile)
contains roughly 130 ms self time in xterm `createRow`, 71 ms in `replaceChildren`,
56 ms in `_updateModel`, and 36.6 ms in application `setStatus`. Most sampled time
is `(idle)`/`(program)`; these samples do not prove that React reconciliation is
responsible for the frame stalls. They do confirm terminal DOM work is present.

## Code candidates to profile next

- `styles.css`: animated `.hm-wp-bloom` layers span up to 75vw, use a 60px blur,
  blend modes, and overlap translucent/backdrop-filtered panels. Removing only
  bloom blur or blend mode did not reliably recover quiet FPS in separate probes.
  Prefer a bounded, cached wallpaper representation and measure its appearance
  and frame cost together.
- `TerminalTile.tsx`: at low DPR, `wantsDom()` selects DOM for a selected or quiet
  terminal. Idle/output transitions can dispose and recreate the WebGL addon;
  release schedules two fits and a resize. Comments describe an agent exception
  that is not present in that predicate. Instrument renderer transitions, fits,
  and PTY resizes before choosing a stable renderer/hysteresis policy.
- Canvas movement: collect a compositor/raster trace with actual GPU acceleration,
  testing terminal surfaces separately from frame geometry and effects. Preserve
  live terminals; blanking tile content to increase FPS is not an acceptable fix.
- Wallpaper activity tracking: wheel activity can be stopped before its window
  bubble listener; the idle guard paused during long verified pan workloads.

## Benchmark corrections and limits

The first probe completed its quiet comparisons, then failed to focus a terminal.
Its fixed wheel point landed over a transparent Sonner container; those wheel
cases did not verify movement and must not be used as pan evidence.
[Quiet-only raw data](perf/2026-09-08-quiet-effects.json).
A second bloom-isolation probe also had unverified movement; use only its quiet
idle observations. [Bloom raw data](perf/2026-09-08-bloom-effects.json).

The final script sets the actual Electron content size, finds an exposed canvas
pane with `elementFromPoint`, verifies midpoint movement, and fails rather than
silently calling a stationary scene a pan. It records backend, load, focus,
renderer element counts, completion/error status, and persists each sample.

## Next gate

Prioritize performance before more optional UI features. First collect the same
verified workload on the real hardware backend; then measure individual changes
against that baseline. Proposed 60Hz budgets: p95 frame time ≤20 ms during normal
pan/drag, fewer than 1% of frames over 50 ms, and separately measured input-to-paint
latency. These are acceptance targets, not claims about the current build.

Immediate mitigation: disable Animate; if movement still stutters, disable Glass.
The benchmark demonstrates that neither option resolves the streaming case by itself.
Do not select a replacement UI stack from these software-rendered samples alone.

## Reproduce

From `apps/desktop`, after the bundle build:

```sh
env -u ELECTRON_RUN_AS_NODE \
  PERF_EFFECTS=static,default,off PERF_WORKLOADS=quiet,streaming \
  PERF_ROUNDS=1 PERF_PROFILE_EFFECT=off \
  xvfb-run -a --server-args='-screen 0 1920x1200x24' \
  node scripts/perf-canvas-effects.mjs /tmp/canvas-effects.json
```

Use forward/reverse repetitions (`PERF_ROUNDS=2`) for comparisons after confirming
the backend and controlling load. Keep native-GPU results separate from llvmpipe.

## Functional checks after measuring

The desktop typecheck/build, CLI typecheck, 117 core tests and 451 desktop unit
checks passed. All three new toolbar action e2e cases passed, as did Browser
activation, painted controls and Settings cases. The first wider Electron batch
finished with 16 passes and two World-startup timeouts under default animated
wallpaper; the World docking case subsequently loaded successfully.

The host-chrome fixture now disables animation only in its temporary profile,
while retaining glass and wallpaper mounting. Those tests verify ownership,
docking and settings recovery, not visual-effects throughput. This must not be
reported as fixing default-effects performance or passing the FPS gate.

All seven host-chrome cases then passed with animation disabled in that fixture.
The two startup timeout cases passed within their existing timeouts; no timeout
was relaxed. Default-effects performance remains unresolved.


## Settings follow-up

Fullscreen Settings now uses opaque palette surfaces, including when workspace
Glass is enabled. A transient external store pauses every Wallpaper instance
and overlay video while Settings covers the workspace; closing it releases that
pause without modifying the saved theme. Photos receive the same paused class
as gradients. Overlay elements are hidden while covered. Terminals and view
lifecycles are unchanged.

This removes unnecessary decoration work during Settings. It is not a measured
fix for the canvas pan/streaming FPS results above. Native GPU profiling remains
needed for that workload.

Validation for the Settings follow-up: desktop typecheck and bundle build passed;
451 unit tests passed; all 11 focused Settings/toolbar e2e tests passed with
`--retries=0`. The new isolated test uses a real VP8 fixture to verify native
wallpaper/overlay video pause and resume, unchanged animation preference,
terminal DOM identity, opaque Settings, and no horizontal overflow across seven
pages at a narrow test viewport. Desktop and narrow screenshots were inspected.
The scene test now waits for the iframe's hover response before clicking, matching
the existing community-view test; its previous fixed click retries could miss
before out-of-process hit-test data arrived. The initial browser-recorded video
fixture was rejected by Chromium and was replaced with a validated 3 KB WebM.
No native GPU FPS comparison was performed for this Settings change.
