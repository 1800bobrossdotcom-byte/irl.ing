// On-phone finishing for decoded loops, in WebGL2.
//
//   1. EASU — edge-adaptive upscale (port of AMD FidelityFX FSR 1; MIT,
//      Copyright (c) 2021 Advanced Micro Devices, Inc. — full notice in
//      public/third-party-notices.txt):
//      12 taps around the sample, a Lanczos-2 approximation stretched along
//      the local edge direction, clamped to the nearest 2×2 to avoid ringing.
//   2. RCAS — contrast-adaptive sharpening (FSR 1), with its noise guard.
//   3. Grain — AV1-style parametric grain: a fixed template scaled by an
//      8-band brightness curve measured at encode time.
//   4. Dither — interleaved gradient noise, ±½ code value, against banding.
//   5. Smart pixels — oriented splats that sample the frame, lean along its
//      edges, and can fly in from scattered positions to assemble the loop.
//
// Image space is top-first throughout; only the final draw flips to GL's
// bottom-first framebuffer.

import { grainTemplate } from "./grain.js";

const FULLSCREEN = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const EASU = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 inSize;
uniform vec2 outSize;
out vec4 color;
vec3 tap(ivec2 p) { return texelFetch(src, clamp(p, ivec2(0), ivec2(inSize) - 1), 0).rgb; }
float luma2(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }
void setF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  float lenX = 1.0 / max(max(abs(lD - lC), abs(lC - lB)), 1.0 / 32768.0);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  len += lenX * lenX * w;
  float lenY = 1.0 / max(max(abs(lE - lC), abs(lC - lA)), 1.0 / 32768.0);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  len += lenY * lenY * w;
}
void tapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, -off.x * dir.y + off.y * dir.x) * len;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB = 1.5625 * wB * wB - 0.5625;
  float w = wB * wA * wA;
  aC += c * w;
  aW += w;
}
void main() {
  vec2 pp = (floor(gl_FragCoord.xy) + 0.5) * (inSize / outSize) - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 o = ivec2(fp);
  vec3 b = tap(o + ivec2(0, -1)), c = tap(o + ivec2(1, -1));
  vec3 e = tap(o + ivec2(-1, 0)), f = tap(o), g = tap(o + ivec2(1, 0)), h = tap(o + ivec2(2, 0));
  vec3 i = tap(o + ivec2(-1, 1)), j = tap(o + ivec2(0, 1)), k = tap(o + ivec2(1, 1)), l = tap(o + ivec2(2, 1));
  vec3 n = tap(o + ivec2(0, 2)), q = tap(o + ivec2(1, 2));
  float bL = luma2(b), cL = luma2(c), eL = luma2(e), fL = luma2(f), gL = luma2(g), hL = luma2(h);
  float iL = luma2(i), jL = luma2(j), kL = luma2(k), lL = luma2(l), nL = luma2(n), qL = luma2(q);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  setF(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  setF(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  setF(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  setF(dir, len, pp.x * pp.y, gL, jL, kL, lL, qL);
  float dirR = dot(dir, dir);
  bool zro = dirR < 1.0 / 32768.0;
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  len *= 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;
  vec3 mn = min(min(f, g), min(j, k));
  vec3 mx = max(max(f, g), max(j, k));
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  tapF(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  tapF(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  tapF(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  tapF(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  tapF(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, f);
  tapF(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  tapF(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  tapF(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  tapF(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  tapF(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  tapF(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, q);
  tapF(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  color = vec4(min(mx, max(mn, aC / aW)), 1.0);
}`;

const FINAL = `#version 300 es
precision highp float;
uniform sampler2D img;
uniform sampler2D grainTex;
uniform int mode;
uniform vec2 inSize;
uniform vec2 outSize;
uniform float sharp;
uniform float grainAmount;
uniform float grainCurve[8];
uniform vec2 grainOffset;
uniform float grainSize;
uniform float frameNo;
uniform float dither;
out vec4 color;
vec3 px(ivec2 p) { return texelFetch(img, clamp(p, ivec2(0), ivec2(outSize) - 1), 0).rgb; }
float luma2(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }
void main() {
  vec2 fc = gl_FragCoord.xy;
  ivec2 p = ivec2(int(fc.x), int(outSize.y) - 1 - int(fc.y));
  vec3 col;
  if (mode == 0) {
    col = texture(img, (vec2(p) + 0.5) / outSize).rgb;
  } else {
    vec3 e = px(p);
    col = e;
    if (sharp > 0.0) {
      vec3 b = px(p + ivec2(0, -1)), d = px(p + ivec2(-1, 0)), f = px(p + ivec2(1, 0)), h = px(p + ivec2(0, 1));
      vec3 mn4 = min(min(b, d), min(f, h));
      vec3 mx4 = max(max(b, d), max(f, h));
      vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1e-5));
      vec3 hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3(-1e-5));
      vec3 lobeRGB = max(-hitMin, hitMax);
      float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharp;
      float bL = luma2(b), dL = luma2(d), eL = luma2(e), fL = luma2(f), hL = luma2(h);
      float range = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
      float nz = clamp(abs(0.25 * (bL + dL + fL + hL) - eL) / max(range, 1e-5), 0.0, 1.0);
      lobe *= 1.0 - 0.5 * nz;
      col = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
    }
    if (grainAmount > 0.0) {
      float yCode = 16.0 + 219.0 * dot(col, vec3(0.2126, 0.7152, 0.0722));
      float band = clamp(yCode / 32.0 - 0.5, 0.0, 7.0);
      int i0 = int(floor(band));
      int i1 = min(i0 + 1, 7);
      float strength = mix(grainCurve[i0], grainCurve[i1], fract(band));
      vec2 gp = (vec2(p) + 0.5) * (inSize / outSize) + grainOffset;
      float g = (texture(grainTex, gp / grainSize).r * 255.0 - 128.0) / 40.0;
      col += g * strength / 219.0 * grainAmount;
    }
  }
  float ign = fract(52.9829189 * fract(dot(fc + frameNo * 5.588238, vec2(0.06711056, 0.00583715))));
  col += (ign - 0.5) / 255.0 * dither;
  color = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const BACKDROP = `#version 300 es
precision mediump float;
uniform float alpha;
out vec4 color;
void main() { color = vec4(0.078, 0.102, 0.09, alpha); }`;

const SPLAT_VS = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 inSize;
uniform float grid;
uniform float cellPx;
uniform float assemble;
out vec3 vColor;
out vec2 vAxis;
out float vStretch;
float hash(float n) { return fract(sin(n) * 43758.5453123); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  float id = float(gl_VertexID);
  vec2 cell = vec2(mod(id, grid), floor(id / grid));
  vec2 jitter = vec2(hash(id * 1.7 + 0.3), hash(id * 3.1 + 0.7)) - 0.5;
  vec2 home = (cell + 0.5 + jitter * 0.6) / grid;
  vec2 start = vec2(hash(id * 5.3 + 1.1), hash(id * 7.9 + 2.3)) * 1.6 - 0.3;
  float t = clamp((assemble - hash(id * 11.3 + 0.5) * 0.45) / 0.55, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  vec2 pos = mix(start, home, t);
  vec2 dx = vec2(1.5 / inSize.x, 0.0), dy = vec2(0.0, 1.5 / inSize.y);
  vColor = textureLod(src, home, 0.0).rgb;
  float gx = luma(textureLod(src, home + dx, 0.0).rgb) - luma(textureLod(src, home - dx, 0.0).rgb);
  float gy = luma(textureLod(src, home + dy, 0.0).rgb) - luma(textureLod(src, home - dy, 0.0).rgb);
  float gm = length(vec2(gx, gy));
  // Lean along the edge: perpendicular to the brightness gradient.
  vAxis = gm > 1e-4 ? vec2(-gy, gx) / gm : vec2(1.0, 0.0);
  vStretch = 1.0 + 1.6 * smoothstep(0.03, 0.25, gm);
  gl_PointSize = cellPx * 2.6 * vStretch;
  gl_Position = vec4(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
uniform float hardness;
uniform float mixAmt;
in vec3 vColor;
in vec2 vAxis;
in float vStretch;
out vec4 color;
void main() {
  // Radius ~0.75 cell so neighbours overlap into a continuous surface.
  vec2 q = (gl_PointCoord - 0.5) * 2.6 * vStretch;
  float along = dot(q, vAxis) / (0.75 * vStretch);
  float across = dot(q, vec2(-vAxis.y, vAxis.x)) / 0.75;
  float d2 = along * along + across * across;
  float a = mix(exp(-1.1 * d2), 1.0 - smoothstep(0.7, 1.0, d2), hardness);
  if (a < 0.01) discard;
  color = vec4(vColor, a * mixAmt);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

function texture(gl, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export const GRAIN_TEMPLATE = 256;

export class Finisher {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.canvas = canvas;
    this.easu = program(gl, FULLSCREEN, EASU);
    this.final = program(gl, FULLSCREEN, FINAL);
    this.backdrop = program(gl, FULLSCREEN, BACKDROP);
    this.splat = program(gl, SPLAT_VS, SPLAT_FS);
    this.vao = gl.createVertexArray();
    this.source = texture(gl, gl.LINEAR);
    this.upscaled = texture(gl, gl.NEAREST);
    this.fbo = gl.createFramebuffer();
    this.grainTex = texture(gl, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.inSize = 0;
    this.outSize = 0;
    this.grain = null;
    this.hasFrame = false;
  }

  resize(outSize) {
    if (outSize === this.outSize) return;
    const gl = this.gl;
    this.outSize = outSize;
    this.canvas.width = this.canvas.height = outSize;
    gl.bindTexture(gl.TEXTURE_2D, this.upscaled);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, outSize, outSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.upscaled, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** grain: { strength: number[8], corr } or null. */
  setGrain(grain) {
    this.grain = grain;
    if (!grain) return;
    const t = grainTemplate(grain.corr, GRAIN_TEMPLATE);
    const bytes = Uint8Array.from(t, (v) => Math.max(0, Math.min(255, Math.round(128 + v * 40))));
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.grainTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, GRAIN_TEMPLATE, GRAIN_TEMPLATE, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }

  /** Upload a decoded VideoFrame (or any image source) as the current frame. */
  upload(frame, size) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    this.inSize = size;
    this.hasFrame = true;
  }

  /**
   * options: finish (bool), sharpen (RCAS stops or null), grain (0–1),
   * look (0 lifelike – 1 smart pixels), grid, hardness, assemble (0–1), frameNo.
   */
  render(o) {
    if (!this.hasFrame) return;
    const gl = this.gl;
    const out = this.outSize;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    if (o.finish) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, out, out);
      gl.useProgram(this.easu.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.source);
      gl.uniform1i(this.easu.u.src, 0);
      gl.uniform2f(this.easu.u.inSize, this.inSize, this.inSize);
      gl.uniform2f(this.easu.u.outSize, out, out);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, out, out);
    const f = this.final;
    gl.useProgram(f.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, o.finish ? this.upscaled : this.source);
    gl.uniform1i(f.u.img, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.grainTex);
    gl.uniform1i(f.u.grainTex, 1);
    gl.uniform1i(f.u.mode, o.finish ? 1 : 0);
    gl.uniform2f(f.u.inSize, this.inSize, this.inSize);
    gl.uniform2f(f.u.outSize, out, out);
    gl.uniform1f(f.u.sharp, o.finish && o.sharpen != null ? 2 ** -o.sharpen : 0);
    const grainOn = o.finish && this.grain && o.grain > 0;
    gl.uniform1f(f.u.grainAmount, grainOn ? o.grain : 0);
    if (grainOn) {
      gl.uniform1fv(f.u.grainCurve, this.grain.strength);
      gl.uniform2f(f.u.grainOffset, Math.random() * GRAIN_TEMPLATE, Math.random() * GRAIN_TEMPLATE);
      gl.uniform1f(f.u.grainSize, GRAIN_TEMPLATE);
    }
    gl.uniform1f(f.u.frameNo, o.frameNo % 64);
    gl.uniform1f(f.u.dither, o.finish ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (o.look > 0.001) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.backdrop.p);
      gl.uniform1f(this.backdrop.u.alpha, o.look);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const s = this.splat;
      gl.useProgram(s.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.source);
      gl.uniform1i(s.u.src, 0);
      gl.uniform2f(s.u.inSize, this.inSize, this.inSize);
      gl.uniform1f(s.u.grid, o.grid);
      gl.uniform1f(s.u.cellPx, out / o.grid);
      gl.uniform1f(s.u.assemble, o.assemble);
      gl.uniform1f(s.u.hardness, o.hardness);
      gl.uniform1f(s.u.mixAmt, o.look);
      gl.drawArrays(gl.POINTS, 0, o.grid * o.grid);
      gl.disable(gl.BLEND);
    }
  }

  destroy() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
