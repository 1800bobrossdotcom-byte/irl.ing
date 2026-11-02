// Draws a dots recipe as a living loop: every dot glides from its cell on
// one keyframe to its cell on the next. WebGL points when available, a 2D
// canvas fallback otherwise.

import { computePaths } from "./dots-codec.js";

const VERTEX = `
attribute vec2 a_pos;
attribute vec3 a_color;
uniform float u_size;
varying vec3 v_color;
void main() {
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
  gl_PointSize = u_size;
  v_color = a_color;
}`;

const FRAGMENT = `
precision mediump float;
uniform float u_round;
varying vec3 v_color;
void main() {
  if (u_round > 0.5 && length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(v_color, 1.0);
}`;

const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);

/** Position along the loop: "settle" holds on each keyframe, "flow" never stops. */
export function easeFor(motion) {
  if (motion === "flow") return (u) => u;
  return (u) => (u < 0.4 ? 0 : smoother((u - 0.4) / 0.6));
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

const active = new Set();
let ticking = false;
function tick(now) {
  for (const renderer of active) renderer.draw(now);
  if (active.size) requestAnimationFrame(tick);
  else ticking = false;
}

export class DotsRenderer {
  constructor(canvas, { pixels = 720 } = {}) {
    this.canvas = canvas;
    canvas.width = pixels;
    canvas.height = pixels;
    this.gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true, alpha: false });
    if (this.gl) this.setupGL();
    else this.ctx = canvas.getContext("2d");
    this.motion = "settle";
    this.round = true;
    this.onLoop = null;
  }

  setupGL() {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    this.program = program;
    this.posBuffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this.loc = {
      pos: gl.getAttribLocation(program, "a_pos"),
      color: gl.getAttribLocation(program, "a_color"),
      size: gl.getUniformLocation(program, "u_size"),
      round: gl.getUniformLocation(program, "u_round"),
    };
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
  }

  load(recipe, paths = computePaths(recipe)) {
    this.recipe = recipe;
    this.paths = paths;
    const { grid } = recipe;
    const cells = grid * grid;
    this.cells = cells;
    this.xy = new Float32Array(cells * 2);
    this.cellX = new Float32Array(cells);
    this.cellY = new Float32Array(cells);
    for (let c = 0; c < cells; c++) {
      this.cellX[c] = ((c % grid) + 0.5) / grid;
      this.cellY[c] = (Math.floor(c / grid) + 0.5) / grid;
    }
    if (this.gl) {
      const gl = this.gl;
      const colors = new Float32Array(cells * 3);
      for (let i = 0; i < colors.length; i++) colors[i] = recipe.colors[i] / 255;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.loc.color);
      gl.vertexAttribPointer(this.loc.color, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.xy.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.loc.pos);
      gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
    } else {
      this.fills = [];
      for (let d = 0; d < cells; d++) {
        const [r, g, b] = recipe.colors.subarray(d * 3, d * 3 + 3);
        this.fills.push(`rgb(${r},${g},${b})`);
      }
    }
    this.startedAt = performance.now();
    this.lastLoop = 0;
    this.draw(this.startedAt);
  }

  get durationMs() {
    return this.recipe ? (this.recipe.frameCount * 1000) / this.recipe.fps : 0;
  }

  play() {
    if (!this.recipe) return;
    this.startedAt = performance.now();
    this.lastLoop = 0;
    active.add(this);
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(tick);
    }
  }

  stop() {
    active.delete(this);
  }

  destroy() {
    this.stop();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Layout of every dot at a moment in the loop, in 0–1 coordinates. */
  layout(ms) {
    const { frameCount, fps } = this.recipe;
    const t = (((ms * fps) / 1000) % frameCount + frameCount) % frameCount;
    const i = Math.floor(t);
    const u = easeFor(this.motion)(t - i);
    const a = i * this.cells;
    const b = ((i + 1) % frameCount) * this.cells;
    const { paths, cellX, cellY, xy } = this;
    for (let d = 0; d < this.cells; d++) {
      const from = paths[a + d];
      const to = paths[b + d];
      xy[d * 2] = cellX[from] + (cellX[to] - cellX[from]) * u;
      xy[d * 2 + 1] = cellY[from] + (cellY[to] - cellY[from]) * u;
    }
    return xy;
  }

  draw(now) {
    if (!this.recipe) return;
    const elapsed = now - this.startedAt;
    const loop = Math.floor(elapsed / this.durationMs);
    if (loop !== this.lastLoop) {
      this.lastLoop = loop;
      this.onLoop?.();
    }
    const xy = this.layout(elapsed);
    const size = this.canvas.width / this.recipe.grid;
    if (this.gl) {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.08, 0.1, 0.09, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, xy);
      gl.uniform1f(this.loc.size, Math.min(this.maxPoint, size * (this.round ? 1.18 : 1.02)));
      gl.uniform1f(this.loc.round, this.round ? 1 : 0);
      gl.drawArrays(gl.POINTS, 0, this.cells);
    } else {
      const ctx = this.ctx;
      const w = this.canvas.width;
      ctx.fillStyle = "#141a17";
      ctx.fillRect(0, 0, w, w);
      for (let d = 0; d < this.cells; d++) {
        ctx.fillStyle = this.fills[d];
        ctx.fillRect(xy[d * 2] * w - size / 2, xy[d * 2 + 1] * w - size / 2, size + 0.5, size + 0.5);
      }
    }
  }
}
