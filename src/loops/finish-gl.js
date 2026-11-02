// On-phone finishing for loops, in WebGL2, working on the decoded YUV planes
// so the result can be held to what was actually sent.
//
//   1. EASU — edge-adaptive 2× upscale of luma (port of AMD FidelityFX FSR 1;
//      MIT, Copyright (c) 2021 Advanced Micro Devices, Inc. — full notice in
//      public/third-party-notices.txt).
//   2. RCAS — contrast-adaptive sharpening (FSR 1) with its noise guard, then
//      True Grain: AV1-style parametric grain measured at encode time.
//   3. Honest Zoom — an integer lock that makes every 2×2 block of the 2×
//      luma average exactly to the received pixel (see honest-zoom.js; the
//      GPU runs the same block algorithm). Color planes are upscaled and
//      locked the same way. Nothing added can contradict what was sent.
//   4. Display — YUV→RGB (BT.709 limited), scaled to the screen, ±½ code
//      value of interleaved-gradient dither against banding.
//   5. Smart pixels — oriented splats that sample the received frame, lean
//      along its edges, and can fly in to assemble the loop. A style: when
//      shown, the picture is no longer the faithful one.
//
// Image space is top-first throughout; only the final draw flips to GL's
// bottom-first framebuffer. 8-bit planes live in R8 textures: a value v is
// stored as v/255, which round-trips exactly, so integer math is exact.

import { grainTemplate } from "./grain.js";

const FULLSCREEN = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
out vec4 color;
int code(float v) { return int(floor(v * 255.0 + 0.5)); }
`;

// Canvas or image source → Y, U, V planes (BT.709 limited range).
const RGB_TO_Y = `${HEADER}
uniform sampler2D rgb;
void main() {
  vec3 c = texelFetch(rgb, ivec2(gl_FragCoord.xy), 0).rgb;
  color = vec4(16.0 / 255.0 + dot(c, vec3(0.1826, 0.6142, 0.062)), 0.0, 0.0, 1.0);
}`;
const RGB_TO_UV = `${HEADER}
uniform sampler2D rgb;
uniform int plane;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec3 c = (texelFetch(rgb, p, 0).rgb + texelFetch(rgb, p + ivec2(1, 0), 0).rgb +
            texelFetch(rgb, p + ivec2(0, 1), 0).rgb + texelFetch(rgb, p + ivec2(1, 1), 0).rgb) * 0.25;
  float u = 128.0 / 255.0 + dot(c, vec3(-0.1006, -0.3386, 0.4392));
  float v = 128.0 / 255.0 + dot(c, vec3(0.4392, -0.3989, -0.0403));
  color = vec4(plane == 0 ? u : v, 0.0, 0.0, 1.0);
}`;

const YUV_TO_RGB_FN = `
vec3 yuvToRgb(float y, float u, float v) {
  float Y = 1.1644 * (y - 16.0 / 255.0);
  u -= 128.0 / 255.0;
  v -= 128.0 / 255.0;
  return clamp(vec3(Y + 1.7927 * v, Y - 0.2132 * u - 0.5329 * v, Y + 2.1124 * u), 0.0, 1.0);
}`;

// Received planes → RGB at source size (for smart pixels and plain display).
const SRC_RGB = `${HEADER}${YUV_TO_RGB_FN}
uniform sampler2D py, pu, pv;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  color = vec4(yuvToRgb(texelFetch(py, p, 0).r, texelFetch(pu, p / 2, 0).r, texelFetch(pv, p / 2, 0).r), 1.0);
}`;

const EASU_Y = `${HEADER}
uniform sampler2D src;
uniform vec2 inSize;
float tap(ivec2 p) { return texelFetch(src, clamp(p, ivec2(0), ivec2(inSize) - 1), 0).r; }
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
void tapF(inout float aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, float c) {
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
  vec2 pp = (floor(gl_FragCoord.xy) + 0.5) * 0.5 - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 o = ivec2(fp);
  float b = tap(o + ivec2(0, -1)), c = tap(o + ivec2(1, -1));
  float e = tap(o + ivec2(-1, 0)), f = tap(o), g = tap(o + ivec2(1, 0)), h = tap(o + ivec2(2, 0));
  float i = tap(o + ivec2(-1, 1)), j = tap(o + ivec2(0, 1)), k = tap(o + ivec2(1, 1)), l = tap(o + ivec2(2, 1));
  float n = tap(o + ivec2(0, 2)), q = tap(o + ivec2(1, 2));
  vec2 dir = vec2(0.0);
  float len = 0.0;
  // FSR's luma runs 0–2; one plane is its own luma, doubled.
  setF(dir, len, (1.0 - pp.x) * (1.0 - pp.y), 2.0 * b, 2.0 * e, 2.0 * f, 2.0 * g, 2.0 * j);
  setF(dir, len, pp.x * (1.0 - pp.y), 2.0 * c, 2.0 * f, 2.0 * g, 2.0 * h, 2.0 * k);
  setF(dir, len, (1.0 - pp.x) * pp.y, 2.0 * f, 2.0 * i, 2.0 * j, 2.0 * k, 2.0 * n);
  setF(dir, len, pp.x * pp.y, 2.0 * g, 2.0 * j, 2.0 * k, 2.0 * l, 2.0 * q);
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
  float aC = 0.0, aW = 0.0;
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
  float lo = min(min(f, g), min(j, k)), hi = max(max(f, g), max(j, k));
  color = vec4(clamp(aC / aW, lo, hi), 0.0, 0.0, 1.0);
}`;

// RCAS on luma, then True Grain (in luma code values).
const SHARPEN_GRAIN = `${HEADER}
uniform sampler2D img;
uniform sampler2D grainTex;
uniform vec2 size;
uniform float sharp;
uniform float grainAmount;
uniform float grainCurve[8];
uniform vec2 grainOffset;
uniform float grainSize;
float px(ivec2 p) { return texelFetch(img, clamp(p, ivec2(0), ivec2(size) - 1), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float e = px(p);
  float y = e;
  if (sharp > 0.0) {
    float b = px(p + ivec2(0, -1)), d = px(p + ivec2(-1, 0)), f = px(p + ivec2(1, 0)), h = px(p + ivec2(0, 1));
    float mn4 = min(min(b, d), min(f, h)), mx4 = max(max(b, d), max(f, h));
    float hitMin = min(mn4, e) / max(4.0 * mx4, 1e-5);
    float hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, -1e-5);
    float lobe = max(-0.1875, min(max(-hitMin, hitMax), 0.0)) * sharp;
    float range = max(max(max(b, d), max(e, f)), h) - min(min(min(b, d), min(e, f)), h);
    float nz = clamp(abs(0.25 * (b + d + f + h) - e) / max(range, 1e-5), 0.0, 1.0);
    lobe *= 1.0 - 0.5 * nz;
    y = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  }
  if (grainAmount > 0.0) {
    float band = clamp(y * 255.0 / 32.0 - 0.5, 0.0, 7.0);
    int i0 = int(floor(band));
    int i1 = min(i0 + 1, 7);
    float strength = mix(grainCurve[i0], grainCurve[i1], fract(band));
    vec2 gp = (vec2(p) + 0.5) * 0.5 + grainOffset;
    float g = (texture(grainTex, gp / grainSize).r * 255.0 - 128.0) / 40.0;
    y += g * strength / 255.0 * grainAmount;
  }
  color = vec4(clamp(y, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// The Honest Zoom lock, one output value per fragment. Every fragment of a
// 2×2 block recomputes the whole block identically and keeps its own value.
// Same algorithm as lockBlock() in honest-zoom.js.
const LOCK_FN = `
void lockBlock(inout int v[4], int target, int start) {
  int diff = 4 * target - (v[0] + v[1] + v[2] + v[3]);
  for (int pass = 0; pass < 5; pass++) {
    if (diff == 0) break;
    bool rise = diff > 0;
    int movable = 0;
    for (int k = 0; k < 4; k++) if (rise ? v[k] < 255 : v[k] > 0) movable++;
    if (movable == 0) break;
    int size = abs(diff);
    int share = size / movable;
    int extra = size - share * movable;
    int m = 0;
    for (int j = 0; j < 4; j++) {
      int k = (start + j) & 3;
      if (!(rise ? v[k] < 255 : v[k] > 0)) continue;
      int add = (share + (m < extra ? 1 : 0)) * (rise ? 1 : -1);
      m++;
      int next = clamp(v[k] + add, 0, 255);
      diff -= next - v[k];
      v[k] = next;
    }
  }
}`;

const LOCK_Y = `${HEADER}${LOCK_FN}
uniform sampler2D up;
uniform sampler2D src;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 b = p / 2;
  ivec2 o = b * 2;
  int v[4];
  v[0] = code(texelFetch(up, o, 0).r);
  v[1] = code(texelFetch(up, o + ivec2(1, 0), 0).r);
  v[2] = code(texelFetch(up, o + ivec2(0, 1), 0).r);
  v[3] = code(texelFetch(up, o + ivec2(1, 1), 0).r);
  lockBlock(v, code(texelFetch(src, b, 0).r), (b.x + 2 * b.y) & 3);
  color = vec4(float(v[(p.x & 1) + 2 * (p.y & 1)]) / 255.0, 0.0, 0.0, 1.0);
}`;

// Color: bilinear 2× (pixel-centre aligned, like bilinear2x) then the lock.
const LOCK_UV = `${HEADER}${LOCK_FN}
uniform sampler2D src;
uniform vec2 srcSize;
float bil(ivec2 P) {
  vec2 s = clamp((vec2(P) + 0.5) * 0.5 - 0.5, vec2(0.0), srcSize - 1.0);
  ivec2 a = ivec2(floor(s));
  ivec2 c = min(a + 1, ivec2(srcSize) - 1);
  vec2 f = s - vec2(a);
  float top = mix(texelFetch(src, a, 0).r, texelFetch(src, ivec2(c.x, a.y), 0).r, f.x);
  float bottom = mix(texelFetch(src, ivec2(a.x, c.y), 0).r, texelFetch(src, c, 0).r, f.x);
  return mix(top, bottom, f.y);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 b = p / 2;
  ivec2 o = b * 2;
  int v[4];
  v[0] = code(bil(o));
  v[1] = code(bil(o + ivec2(1, 0)));
  v[2] = code(bil(o + ivec2(0, 1)));
  v[3] = code(bil(o + ivec2(1, 1)));
  lockBlock(v, code(texelFetch(src, b, 0).r), (b.x + 2 * b.y) & 3);
  color = vec4(float(v[(p.x & 1) + 2 * (p.y & 1)]) / 255.0, 0.0, 0.0, 1.0);
}`;

// Planes → screen: YUV→RGB, scaled to the canvas, dithered.
const DISPLAY = `${HEADER}${YUV_TO_RGB_FN}
uniform sampler2D py, pu, pv;
uniform vec2 outSize;
uniform float frameNo;
uniform float dither;
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = vec2(fc.x, outSize.y - fc.y) / outSize;
  vec3 col = yuvToRgb(texture(py, uv).r, texture(pu, uv).r, texture(pv, uv).r);
  float ign = fract(52.9829189 * fract(dot(fc + frameNo * 5.588238, vec2(0.06711056, 0.00583715))));
  col += (ign - 0.5) / 255.0 * dither;
  color = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Pack four consecutive 8-bit values of a plane row into one RGBA texel, so
// readback is a quarter of the size and already in plain byte order.
const PACK = `${HEADER}
uniform sampler2D plane;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 o = ivec2(p.x * 4, p.y);
  color = vec4(texelFetch(plane, o, 0).r, texelFetch(plane, o + ivec2(1, 0), 0).r,
               texelFetch(plane, o + ivec2(2, 0), 0).r, texelFetch(plane, o + ivec2(3, 0), 0).r);
}`;

const BACKDROP = `${HEADER}
uniform float alpha;
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
  vAxis = gm > 1e-4 ? vec2(-gy, gx) / gm : vec2(1.0, 0.0);
  vStretch = 1.0 + 1.6 * smoothstep(0.03, 0.25, gm);
  gl_PointSize = cellPx * 2.6 * vStretch;
  gl_Position = vec4(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0);
}`;

const SPLAT_FS = `${HEADER}
uniform float hardness;
uniform float mixAmt;
in vec3 vColor;
in vec2 vAxis;
in float vStretch;
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
  const u = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

export const GRAIN_TEMPLATE = 256;

/** A texture plus a framebuffer that renders into it. */
class Target {
  constructor(gl, internal, format, filter) {
    this.gl = gl;
    this.internal = internal;
    this.format = format;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    this.size = 0;
    this.width = 0;
    this.height = 0;
  }
  ensure(width, height = width) {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    this.size = width;
    this.width = width;
    this.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.internal, width, height, 0, this.format, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  /** Read an RGBA8 target into `out` (bytes in row order). */
  readInto(out) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}

export class Finisher {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.canvas = canvas;
    this.p = {
      rgbToY: program(gl, FULLSCREEN, RGB_TO_Y),
      rgbToUV: program(gl, FULLSCREEN, RGB_TO_UV),
      srcRgb: program(gl, FULLSCREEN, SRC_RGB),
      easu: program(gl, FULLSCREEN, EASU_Y),
      sharpen: program(gl, FULLSCREEN, SHARPEN_GRAIN),
      lockY: program(gl, FULLSCREEN, LOCK_Y),
      lockUV: program(gl, FULLSCREEN, LOCK_UV),
      pack: program(gl, FULLSCREEN, PACK),
      display: program(gl, FULLSCREEN, DISPLAY),
      backdrop: program(gl, FULLSCREEN, BACKDROP),
      splat: program(gl, SPLAT_VS, SPLAT_FS),
    };
    this.vao = gl.createVertexArray();
    const r8 = (filter = gl.NEAREST) => new Target(gl, gl.R8, gl.RED, filter);
    this.t = {
      image: new Target(gl, gl.RGBA8, gl.RGBA, gl.NEAREST), // uploaded canvas/image
      rgb: new Target(gl, gl.RGBA8, gl.RGBA, gl.LINEAR), // received frame as RGB
      y: r8(gl.LINEAR),
      u: r8(gl.LINEAR),
      v: r8(gl.LINEAR),
      easu: r8(),
      sharp: r8(),
      zy: r8(gl.LINEAR), // Honest Zoom output planes
      zu: r8(gl.LINEAR),
      zv: r8(gl.LINEAR),
      pack: new Target(gl, gl.RGBA8, gl.RGBA, gl.NEAREST), // readback staging
    };
    this.grainTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.grainTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.inSize = 0;
    this.outSize = 0;
    this.grain = null;
    this.hasFrame = false;
    this.rgbStale = true;
  }

  resize(outSize) {
    if (outSize === this.outSize) return;
    this.outSize = outSize;
    this.canvas.width = this.canvas.height = outSize;
  }

  /** grain: { strength: number[8], corr } or null. */
  setGrain(grain) {
    this.grain = grain;
    if (!grain) return;
    const t = grainTemplate(grain.corr, GRAIN_TEMPLATE);
    const bytes = Uint8Array.from(t, (v) => Math.max(0, Math.min(255, Math.round(128 + v * 40))));
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.grainTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, GRAIN_TEMPLATE, GRAIN_TEMPLATE, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }

  sizePlanes(size) {
    this.inSize = size;
    for (const k of ["y", "rgb", "image"]) this.t[k].ensure(size);
    this.t.u.ensure(size / 2);
    this.t.v.ensure(size / 2);
    for (const k of ["easu", "sharp", "zy"]) this.t[k].ensure(size * 2);
    this.t.zu.ensure(size);
    this.t.zv.ensure(size);
  }

  /** Upload a received frame as I420 bytes (size × size). */
  uploadI420(i420, size) {
    const gl = this.gl;
    this.sizePlanes(size);
    const c = size / 2;
    const put = (target, data, n) => {
      gl.bindTexture(gl.TEXTURE_2D, target.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RED, gl.UNSIGNED_BYTE, data);
    };
    put(this.t.y, i420.subarray(0, size * size), size);
    put(this.t.u, i420.subarray(size * size, size * size + c * c), c);
    put(this.t.v, i420.subarray(size * size + c * c, size * size + 2 * c * c), c);
    this.hasFrame = true;
    this.rgbStale = true;
  }

  /** Upload a canvas or image (RGB) as the received frame; converted to I420 on the GPU. */
  upload(image, size) {
    const gl = this.gl;
    this.sizePlanes(size);
    gl.bindTexture(gl.TEXTURE_2D, this.t.image.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.pass(this.t.y, this.p.rgbToY, { rgb: this.t.image });
    this.pass(this.t.u, this.p.rgbToUV, { rgb: this.t.image }, { plane: 0 });
    this.pass(this.t.v, this.p.rgbToUV, { rgb: this.t.image }, { plane: 1 });
    this.hasFrame = true;
    this.rgbStale = true;
  }

  /** Draw a full-screen pass into a target (or the canvas when target is null). */
  pass(target, prog, textures = {}, ints = {}, floats = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.width : this.outSize, target ? target.height : this.outSize);
    gl.useProgram(prog.p);
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex ?? t);
      gl.uniform1i(prog.u[name], unit++);
    }
    for (const [name, v] of Object.entries(ints)) gl.uniform1i(prog.u[name], v);
    for (const [name, v] of Object.entries(floats)) {
      if (Array.isArray(v)) v.length === 2 ? gl.uniform2f(prog.u[name], v[0], v[1]) : gl.uniform1fv(prog.u[name], v);
      else gl.uniform1f(prog.u[name], v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The received frame as RGB, made only when something needs it. */
  sourceRgb() {
    if (this.rgbStale) {
      this.pass(this.t.rgb, this.p.srcRgb, { py: this.t.y, pu: this.t.u, pv: this.t.v });
      this.rgbStale = false;
    }
    return this.t.rgb;
  }

  /**
   * options: finish (bool), sharpen (RCAS stops or null), grain (0–1),
   * look (0 lifelike – 1 smart pixels), grid, hardness, assemble (0–1), frameNo.
   * Returns true when the frame on screen is the Honest Zoom (faithful) one.
   */
  render(o) {
    if (!this.hasFrame) return false;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    let planes = { py: this.t.y, pu: this.t.u, pv: this.t.v };
    if (o.finish) {
      this.zoom(o);
      planes = { py: this.t.zy, pu: this.t.zu, pv: this.t.zv };
    }
    this.pass(null, this.p.display, planes, {}, { outSize: [this.outSize, this.outSize], frameNo: o.frameNo % 64, dither: o.finish ? 1 : 0 });
    const look = o.look ?? 0;
    if (look > 0.001) {
      const src = this.sourceRgb();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.outSize, this.outSize);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.p.backdrop.p);
      gl.uniform1f(this.p.backdrop.u.alpha, look);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const s = this.p.splat;
      gl.useProgram(s.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(s.u.src, 0);
      gl.uniform2f(s.u.inSize, this.inSize, this.inSize);
      gl.uniform1f(s.u.grid, o.grid);
      gl.uniform1f(s.u.cellPx, this.outSize / o.grid);
      gl.uniform1f(s.u.assemble, o.assemble);
      gl.uniform1f(s.u.hardness, o.hardness);
      gl.uniform1f(s.u.mixAmt, look);
      gl.drawArrays(gl.POINTS, 0, o.grid * o.grid);
      gl.disable(gl.BLEND);
    }
    return o.finish && look <= 0.001;
  }

  /** Just the Honest Zoom planes, nothing drawn on screen (for export). */
  zoomOnly(o) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.zoom(o);
  }

  /** Upscale, sharpen, grain and lock into the zy/zu/zv planes. */
  zoom(o) {
    const S = this.inSize * 2;
    this.pass(this.t.easu, this.p.easu, { src: this.t.y }, {}, { inSize: [this.inSize, this.inSize] });
    const grainOn = this.grain && o.grain > 0;
    this.pass(
      this.t.sharp,
      this.p.sharpen,
      { img: this.t.easu, grainTex: this.grainTex },
      {},
      {
        size: [S, S],
        sharp: o.sharpen != null ? 2 ** -o.sharpen : 0,
        grainAmount: grainOn ? o.grain : 0,
        ...(grainOn && {
          grainCurve: this.grain.strength,
          grainOffset: [Math.random() * GRAIN_TEMPLATE, Math.random() * GRAIN_TEMPLATE],
          grainSize: GRAIN_TEMPLATE,
        }),
      },
    );
    this.pass(this.t.zy, this.p.lockY, { up: this.t.sharp, src: this.t.y });
    const c = this.inSize / 2;
    this.pass(this.t.zu, this.p.lockUV, { src: this.t.u }, {}, { srcSize: [c, c] });
    this.pass(this.t.zv, this.p.lockUV, { src: this.t.v }, {}, { srcSize: [c, c] });
  }

  /** Read an R8 plane (width a multiple of 4) into out at offset, packed on the GPU. */
  readPlane(target, out, offset) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.t.pack.ensure(target.width / 4, target.height);
    this.pass(this.t.pack, this.p.pack, { plane: target });
    this.t.pack.readInto(out.subarray(offset, offset + target.width * target.height));
  }

  /** The current Honest Zoom frame as I420 bytes (2·size), read back from the GPU. */
  readZoom() {
    const S = this.inSize * 2;
    const out = new Uint8Array(S * S * 1.5);
    this.readPlane(this.t.zy, out, 0);
    this.readPlane(this.t.zu, out, S * S);
    this.readPlane(this.t.zv, out, S * S * 1.25);
    return out;
  }

  /** The received planes as I420 bytes, read back (for canvas sources). */
  readSource() {
    const n = this.inSize;
    const out = new Uint8Array(n * n * 1.5);
    this.readPlane(this.t.y, out, 0);
    this.readPlane(this.t.u, out, n * n);
    this.readPlane(this.t.v, out, n * n * 1.25);
    return out;
  }

  destroy() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
