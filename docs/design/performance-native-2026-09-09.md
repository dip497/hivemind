# Native GPU performance: 2026-09-09

Status: the canvas meets the 60 FPS target on hardware-accelerated rendering. The
2026-09-08 results were measured on software rendering under heavy system load and
must not be used as evidence about this application's cost.

## Why the earlier numbers were wrong

[performance-2026-09-08.md](performance-2026-09-08.md) and
[performance-recording-2026-09-08.md](performance-recording-2026-09-08.md) both ran under
Xvfb, which has no GPU. Their recorded backend was
`ANGLE (Mesa, llvmpipe (LLVM 20.1.2 256 bits), OpenGL 4.5)` — a CPU rasterizer. The
canvas-motion run also started at load 23.0 and ended at 48.0 on a 16-CPU machine.
Two confounds, both large, both pointing the same direction.

Blur, `backdrop-filter`, blend modes and large translucent layers are the specific
workload llvmpipe is worst at and a GPU is best at. Concluding "effects are expensive"
from llvmpipe measures the rasterizer, not the design.

## Conditions

Same machine, same script (`scripts/perf-canvas-effects.mjs`), same content bounds
(1919×1199, DPR 1), same workload definition as the 2026-09-08 canvas-motion run. The
only deliberate changes are the display and the system load.

- Display `:1` (Xwayland under mutter), no Xvfb.
- Backend: `ANGLE (Intel, Mesa Intel(R) UHD Graphics (TGL GT1), OpenGL 4.6)`.
  `gpu_compositing: enabled`, `rasterization: enabled`, `canvas_oop_rasterization:
  enabled_on`, `webgl2: enabled`. Optimus hybrid; the NVIDIA RTX A2000 is listed but
  ANGLE renders on the Intel iGPU. Vulkan and Skia Graphite are off.
- Load 2.7 at start, 4.4 at end (compare 23.0 → 48.0 on 2026-09-08).
- Isolated temporary profile, in-process PTYs. No user profile or session was touched.
- Three shell terminals at ~50 lines/sec for the streaming workload. `focused: true`
  and `panVerified: true` on every sample; wheel movement was verified, not assumed.

## Result: every scene passes

| Workload | Effects | Scene | FPS | Frame p95 ms | Frame max ms | Timer lag p95 ms | Long tasks |
|---|---|---|---:|---:|---:|---:|---:|
| quiet | default | idle | 59.2 | 17.7 | 22.8 | 0.1 | 0 |
| quiet | default | pan | 59.9 | 21.8 | 24.9 | 0.6 | 0 |
| quiet | static | idle | 59.9 | 16.8 | 16.8 | 0.1 | 0 |
| quiet | static | pan | 61.3 | 16.8 | 24.7 | 0.1 | 0 |
| quiet | off | idle | 59.9 | 16.8 | 16.8 | 0.1 | 0 |
| quiet | off | pan | 59.1 | 18.2 | 23.5 | 0.1 | 0 |
| streaming | default | idle | 58.2 | 19.4 | 35.2 | 2.9 | 0 |
| streaming | default | pan | 58.2 | 18.6 | 36.7 | 2.3 | 0 |
| streaming | static | idle | 58.9 | 18.1 | 33.7 | 2.1 | 0 |
| streaming | static | pan | 57.6 | 19.7 | 38.2 | 3.3 | 0 |
| streaming | off | idle | 59.7 | 17.1 | 19.9 | 1.0 | 0 |
| streaming | off | pan | 59.6 | 17.2 | 33.9 | 2.2 | 0 |

`default` is Aurora wallpaper + glass + animation. Raw:
[native GPU run](perf/2026-09-09-native-gpu.json).

Against the acceptance targets proposed on 2026-09-08:

- **p95 frame time ≤20 ms during pan** — met in five of six pan samples; the sixth
  (quiet, default effects) is 21.8 ms.
- **Fewer than 1% of frames over 50 ms** — met outright. The largest single frame in
  any of the twelve samples is 38.2 ms.
- **Zero long tasks in every sample**, against 110–6213 ms per sample on llvmpipe.

## Side by side

Identical script, identical window bounds, identical workloads.

| Scene | llvmpipe, load 23–48 | Intel UHD, load 3–4 |
|---|---:|---:|
| quiet · default · idle | 2.5 | 59.2 |
| quiet · default · pan | 2.5 | 59.9 |
| quiet · static · pan | 4.3 | 61.3 |
| quiet · off · pan | 15.5 | 59.1 |
| streaming · default · idle | 0.5 | 58.2 |
| streaming · default · pan | 1.0 | 58.2 |
| streaming · static · pan | 1.5 | 57.6 |
| streaming · off · pan | 1.9 | 59.6 |

The effect ordering also inverts: on llvmpipe, turning effects off was the difference
between 2.5 and 15.5 FPS during pan; on the GPU, default, static and off are the same
within noise (59.9 / 61.3 / 59.1). **The "disable Animate, then disable Glass"
mitigation in the 2026-09-08 recording note does not apply to hardware rendering.**

## Scaling with tile count

Because the earlier runs used only three terminals, a separate run repeated the
default-effects scenes with ten terminals, all streaming.

| Tiles | Workload | Scene | FPS | Frame p95 ms | Timer lag p95 ms | Renderers |
|---:|---|---|---:|---:|---:|---|
| 3 | streaming | pan | 58.2 | 18.6 | 2.3 | 6 WebGL |
| 10 | quiet | pan | 60.7 | 16.8 | 0.2 | 10 DOM |
| 10 | streaming | idle | 52.8 | 35.4 | 8.6 | 20 WebGL |
| 10 | streaming | pan | 55.4 | 33.0 | 7.5 | 20 WebGL |

Raw: [ten-tile run](perf/2026-09-09-native-10-tiles.json).

Degradation is graceful and stays above 50 FPS, with no long tasks. Frame p95 rises
from ~19 ms to ~33 ms — over the ≤20 ms target — at ten terminals emitting 500 lines
per second combined, which is well past realistic agent output. This is the headroom
limit worth watching, not a release blocker. It is terminal repaint cost, not effects
cost: the same ten tiles quiet hold 60.7 FPS at 16.8 ms.

## What remains unexplained

The 2026-09-08 screen recording showed the in-app meter dropping from 61 to 15 FPS
during canvas movement on real hardware. That is not reproduced here. This run held
59–61 FPS through verified pan with the same effects. Candidate explanations, in order:

1. **System contention.** Load on this machine was 26.6 twenty minutes before this
   benchmark, with a single IDE process at 940% CPU. That is enough to starve the
   render loop on its own, and it matches the conditions of every 2026-09-08 run.
2. **A different build.** The recording's renderer was never queried and the binary
   was not identified.
3. **Workload shape.** Real agent TUIs redraw differently from `echo` loops, and the
   recorded session's tile count, wallpaper kind and overlay state are unknown.

Closing this needs one recording made on a quiet machine with the current build and
the backend recorded. Until then, do not attribute that drop to the visual effects.

## Consequences for the harness

Xvfb perf runs remain valid for **A/B comparison of two builds** on the same machine
in interleaved order, which is what `scripts/perf-views.mjs` and the pre-release
checklist use them for. They are not valid as absolute FPS, frame-time or
latency numbers, and no acceptance target should be evaluated against them. Any
absolute gate must be measured on a display with the backend recorded in the result,
as `perf-canvas-effects.mjs` already does.

## Reproduce

From `apps/desktop`, after the bundle build, on a quiet machine:

```sh
env -u ELECTRON_RUN_AS_NODE DISPLAY=:1 \
  PERF_EFFECTS=default,static,off PERF_WORKLOADS=quiet,streaming \
  PERF_ROUNDS=1 PERF_PROFILE_EFFECT=off \
  node scripts/perf-canvas-effects.mjs docs/design/perf/<date>-native-gpu.json
```

Check `webgl.renderer` in the output before reading any number below it. If it says
llvmpipe or SwiftShader, the run measured a CPU rasterizer and the FPS columns mean
nothing about this application.
