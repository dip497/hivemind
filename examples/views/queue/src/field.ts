/**
 * The quiet state's field: a grid of dots whose pulse follows how much of the workspace is
 * working. It is the only motion in this view, it runs only while nothing needs you and no
 * terminal is docked, and it draws at most thirty frames a second.
 *
 * One triangle covers the screen and the fragment shader does the rest, so the cost is the
 * number of pixels and nothing else — which is why the pixel ratio is capped.
 */
const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uEnergy;
uniform float uCell;
uniform vec3 uDot;
uniform vec3 uLit;
out vec4 o;
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 id = floor(frag / uCell);
  vec2 local = fract(frag / uCell) - 0.5;
  vec2 centre = floor(uRes / uCell * 0.5);
  float r = length(id - centre);
  // A wave leaves the centre; more agents working, faster and brighter it travels.
  float wave = sin(r * 0.42 - uTime * (0.5 + uEnergy * 1.9));
  float grain = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
  float pulse = smoothstep(0.55, 1.0, wave) * (0.25 + uEnergy * 0.75) * (0.7 + grain * 0.3);
  float radius = mix(0.075, 0.17, pulse);
  float aa = 1.5 / uCell;
  float dotMask = 1.0 - smoothstep(radius - aa, radius + aa, length(local));
  vec2 uv = frag / uRes - 0.5;
  float vignette = smoothstep(0.78, 0.18, length(uv * vec2(uRes.x / uRes.y, 1.0)) );
  float a = dotMask * mix(0.16, 0.85, pulse) * vignette;
  o = vec4(mix(uDot, uLit, pulse) * a, a);
}`;

export interface Field {
  setColors(dot: string, lit: string): void;
  setEnergy(energy: number): void;
  setActive(active: boolean): void;
  onFrame(cb: () => void): void;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [0.5, 0.5, 0.5];
};

export function createField(canvas: HTMLCanvasElement): Field | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;

  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  // One oversized triangle instead of a quad: three vertices, no seam down the diagonal.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = u("uRes"), uTime = u("uTime"), uEnergy = u("uEnergy"), uCell = u("uCell"), uDot = u("uDot"), uLit = u("uLit");

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let active = false, energy = 0, shown = 0, raf = 0, last = 0, started = performance.now();
  let frameCb: () => void = () => {};

  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uCell, 15 * dpr);
  };

  const draw = (now: number) => {
    size();
    // Energy eases toward its target, so a change in the workspace swells rather than jumps.
    shown += (energy - shown) * 0.06;
    gl.uniform1f(uTime, reduce.matches ? 2.4 : (now - started) / 1000);
    gl.uniform1f(uEnergy, shown);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frameCb();
  };

  // It moves only while it has somewhere to go: a breath when it appears, then easing to a new
  // energy. When the workspace stops changing, so does the field — it never idles at 30 fps.
  const BREATH_MS = 1600;
  let settleFrom = 0;
  const loop = (now: number) => {
    raf = 0;
    if (!active) return;
    if (now - last >= 33) { last = now; draw(now); }
    const moving = now - settleFrom < BREATH_MS || Math.abs(energy - shown) > 0.004;
    if (moving && !reduce.matches) raf = requestAnimationFrame(loop);
  };
  const wake = () => { settleFrom = performance.now(); if (active && !raf) raf = requestAnimationFrame(loop); };

  return {
    setColors(dot, lit) { gl.uniform3f(uDot, ...hexToRgb(dot)); gl.uniform3f(uLit, ...hexToRgb(lit)); if (active) draw(performance.now()); },
    setEnergy(e) {
      const next = Math.max(0, Math.min(1, e));
      if (next === energy) return;
      energy = next;
      // Without motion there is no loop to ease it, so the one still frame is redrawn instead.
      if (reduce.matches) { shown = energy; if (active) draw(performance.now()); }
      else wake();
    },
    setActive(on) {
      if (on === active) return;
      active = on;
      canvas.toggleAttribute("data-on", on);
      if (on) { last = 0; wake(); }
      else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    onFrame(cb) { frameCb = cb; },
  };
}
