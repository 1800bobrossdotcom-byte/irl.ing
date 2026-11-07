// irl.ing landing page: two live loops rendered with the same on-phone
// finishing pipeline as the loops lab (FSR 1 upscale + sharpen, grain,
// dither, smart pixels), a hold-to-record demo, and the transit diagram.

import { Finisher } from "../loops/finish-gl.js";
import { drawScene } from "../loops/scene.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LOOP_MS = 6000;
const SRC = 360;
const ASSEMBLE_MS = 1700;
const FADE_MS = 700;
const GRAIN = { strength: [2.2, 2.4, 2.6, 2.6, 2.4, 2.2, 2, 1.8], corr: 0.35 };

/** A drawn loop, finished in WebGL2 where available, plain canvas otherwise. */
class LiveScene {
  constructor(host, { grid = 72, hardness = 0.2 } = {}) {
    this.host = host;
    this.grid = grid;
    this.hardness = hardness;
    this.src = document.createElement("canvas");
    this.src.width = this.src.height = SRC;
    this.sctx = this.src.getContext("2d");
    this.canvas = document.createElement("canvas");
    host.append(this.canvas);
    try {
      this.finisher = new Finisher(this.canvas);
      this.finisher.setGrain(GRAIN);
    } catch {
      this.finisher = null;
      this.canvas.remove();
      this.canvas = document.createElement("canvas");
      host.append(this.canvas);
      this.ctx = this.canvas.getContext("2d");
    }
    this.ms = 0;
    this.look = 0;
    this.frameNo = 0;
    this.visible = false;
    this.assembleAt = reduced ? -1e9 : null; // starts when first seen
    new IntersectionObserver(
      ([entry]) => {
        this.visible = entry.isIntersecting;
        if (this.visible && this.assembleAt === null) this.assembleAt = performance.now();
      },
      { threshold: 0.15 },
    ).observe(host);
  }

  assemble() {
    if (!reduced) this.assembleAt = performance.now();
  }

  outputSize() {
    const css = this.host.clientWidth || SRC;
    return Math.max(SRC, Math.min(1080, Math.round(css * Math.min(window.devicePixelRatio || 1, 2.5))));
  }

  draw(now, lookTarget) {
    drawScene(this.sctx, SRC, (this.ms % LOOP_MS) / LOOP_MS);
    const since = this.assembleAt === null ? 0 : now - this.assembleAt;
    const assemble = this.assembleAt === null ? 0 : Math.min(1, since / ASSEMBLE_MS);
    const fade = assemble < 1 ? 1 : Math.max(0, 1 - (since - ASSEMBLE_MS) / FADE_MS);
    this.look += (lookTarget - this.look) * (reduced ? 1 : 0.12);
    if (this.finisher) {
      this.finisher.resize(this.outputSize());
      this.finisher.upload(this.src, SRC);
      this.finisher.render({
        finish: true,
        sharpen: 1,
        grain: 0.8,
        look: Math.max(this.look, fade),
        grid: this.grid,
        hardness: this.hardness,
        assemble,
        frameNo: this.frameNo++,
      });
    } else {
      const size = this.outputSize();
      if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
      this.ctx.drawImage(this.src, 0, 0, size, size);
    }
  }
}

// ---- hero: hold to record a take ----------------------------------------

const hero = new LiveScene($("hero-stage"));
const card = $("try");
const hold = $("hold");
let mode = reduced ? "still" : "loop"; // loop | still | hold | paused
let recorded = 0; // ms in the demo take so far
let holdBase = 0; // recorded time when the current hold began
let holdStartedAt = 0; // clock time when the current hold began
let takes = [];
let holdPointer = null;

function say(html) {
  // One span, so the caption stays a single line box inside its flex row.
  $("try-caption").innerHTML = `<span>${html}</span>`;
}

function drawTicks() {
  const box = $("meter-ticks");
  box.replaceChildren();
  let at = 0;
  for (const take of takes) {
    at += take;
    if (at >= LOOP_MS) break;
    const tick = document.createElement("i");
    tick.style.left = `${(at / LOOP_MS) * 100}%`;
    box.append(tick);
  }
}

function start() {
  if (mode === "hold") return;
  if (mode !== "paused") {
    recorded = 0;
    takes = [];
    hero.ms = 0;
    drawTicks();
  }
  mode = "hold";
  holdBase = recorded;
  holdStartedAt = performance.now();
  card.classList.add("recording");
  card.classList.remove("looping");
  hold.classList.add("on");
  say("Recording. Let go to pause.");
}

function stop() {
  holdPointer = null;
  hold.classList.remove("on");
  if (mode !== "hold") return;
  recorded = Math.min(LOOP_MS, holdBase + performance.now() - holdStartedAt);
  takes.push(recorded - takes.reduce((a, b) => a + b, 0));
  mode = "paused";
  card.classList.remove("recording");
  drawTicks();
  say(`Paused at ${(recorded / 1000).toFixed(1)}s. Hold to keep going.`);
}

function finishTake() {
  takes.push(LOOP_MS - takes.reduce((a, b) => a + b, 0));
  holdPointer = null;
  hold.classList.remove("on");
  card.classList.remove("recording");
  mode = "loop";
  hero.ms = 0;
  hero.assemble();
  drawTicks();
  const n = takes.length;
  say(`That’s a loop: ${n} take${n > 1 ? "s" : ""}, six seconds. <a href="/loops/">Make a real one</a>`);
}

function onPointerDown(event) {
  if (event.button > 0 || holdPointer !== null) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture?.(event.pointerId);
  holdPointer = event.pointerId;
  start();
}

function onPointerEnd(event) {
  if (event.pointerId !== holdPointer) return;
  // A late "capture lost" from an earlier hold must not end the current one.
  if (event.type === "lostpointercapture" && event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
  stop();
}

for (const el of [hold, $("hero-stage")]) {
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointerup", onPointerEnd);
  el.addEventListener("pointercancel", onPointerEnd);
  el.addEventListener("lostpointercapture", onPointerEnd);
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}
$("hero-stage").style.touchAction = "none";
hold.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    event.preventDefault();
    start();
  }
});
hold.addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") stop();
});
document.addEventListener("visibilitychange", () => document.hidden && stop());

function updateMeter() {
  const demo = mode === "hold" || mode === "paused";
  const ms = demo ? recorded : hero.ms % LOOP_MS;
  $("meter-fill").style.width = `${(ms / LOOP_MS) * 100}%`;
  card.classList.toggle("looping", !demo);
  $("stage-label").textContent = mode === "hold" ? "RECORDING" : mode === "paused" ? `PAUSED · TAKE ${takes.length}` : "LIVE LOOP";
  $("stage-clock").textContent = `${(ms / 1000).toFixed(1)}s`;
  drawRing(ms);
}

// ---- the take ring: the logo, redrawn from your own takes ------------------
// The mark is three takes (2.6, 1.5, 1.9 s) around the record dot. Here the
// ring shows the takes of whatever is on screen: the mark's own until you
// record, then yours, with a gap wherever you let go.

const ring = $("take-ring");
const MARK_TAKES = [2600, 1500, 1900];
const R = 48;
const GAP = 20; // visible gap, degrees
const CAP = ((6 / R) * 180) / Math.PI; // a round cap (stroke 12) eats this much arc
let ringKey = "";

function point(deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${(60 + R * Math.cos(a)).toFixed(2)} ${(60 + R * Math.sin(a)).toFixed(2)}`;
}

/** One take from a0 to a1 degrees; too short for an arc, it's a dot. */
function takePath(a0, a1) {
  if (a1 - a0 < 0.5) return `M${point(a0)}l0 0`;
  return `M${point(a0)}A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${point(a1)}`;
}

function drawRing(ms) {
  const live = mode === "hold";
  const list = takes.length || live ? [...takes, ...(live ? [recorded - takes.reduce((a, b) => a + b, 0)] : [])] : MARK_TAKES;
  const playing = mode === "loop" && !reduced ? ms : null;
  let at = 0;
  const parts = list.map((take, i) => {
    const last = i === list.length - 1;
    const a0 = (at / LOOP_MS) * 360 + GAP / 2 + CAP;
    let a1 = ((at + take) / LOOP_MS) * 360 - (live && last ? CAP : GAP / 2 + CAP);
    a1 = Math.max(a0, a1);
    const on = playing === null || (playing >= at && playing < at + take);
    at += take;
    const cls = live && last ? "live" : on ? "" : "dim";
    return `<path${cls ? ` class="${cls}"` : ""} d="${takePath(a0, a1)}"/>`;
  });
  const key = parts.join("");
  if (key !== ringKey) ring.innerHTML = ringKey = key;
}

// ---- smart pixels section -----------------------------------------------

const pixels = new LiveScene($("pixels-stage"), { grid: 64, hardness: 0.35 });
const slider = $("pixels-look");
let sliderTouched = false;
slider.addEventListener("input", () => (sliderTouched = true));
$("pixels-again").addEventListener("click", () => pixels.assemble());

// ---- one animation loop for both ----------------------------------------

let last = performance.now();
let lastSlider = 0;
function frame(now) {
  const dt = Math.min(64, now - last);
  last = now;
  if (mode === "loop") hero.ms = (hero.ms + dt) % LOOP_MS;
  if (mode === "hold") {
    // Real elapsed hold time, not summed frame steps: slow frames lose nothing.
    recorded = Math.min(LOOP_MS, holdBase + now - holdStartedAt);
    hero.ms = recorded;
    if (recorded >= LOOP_MS) finishTake();
  }
  if (hero.visible) hero.draw(now, mode === "paused" ? 0.42 : 0);
  updateMeter();

  if (!reduced) pixels.ms = (pixels.ms + dt) % LOOP_MS;
  let look = Number(slider.value) / 100;
  if (!sliderTouched && !reduced) {
    look = 0.5 - 0.5 * Math.cos((now / 8000) * 2 * Math.PI);
    if (now - lastSlider > 120) {
      slider.value = String(Math.round(look * 100));
      lastSlider = now;
    }
  }
  if (pixels.visible) pixels.draw(now, look);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
say("Hold to record. Let go to pause.");

// ---- transit diagram -----------------------------------------------------

const NOTES = {
  sent: "All six seconds arrive at <b>30 fps</b>, sealed.",
  relay: "A relay drops the in-between frames <b>without opening the file</b>. About half the size, still sealed.",
  flip: "A checksum catches the damage. <b>Seconds 2–4 hold still</b>; the rest play.",
  cut: "Important parts came first, so <b>all six seconds still play</b>, at 15 fps.",
};
const strip = $("strip");

function showTransit(kind) {
  document.querySelectorAll("[data-transit]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.transit === kind)));
  const blocks = [...strip.querySelectorAll(".blk")];
  blocks.forEach((b) => b.classList.remove("gone", "broken"));
  strip.classList.toggle("cut", kind === "cut");
  if (kind === "relay" || kind === "cut") blocks.filter((b) => b.classList.contains("extra")).forEach((b) => b.classList.add("gone"));
  if (kind === "flip") strip.querySelector("[data-flip]").classList.add("broken");
  if (kind === "cut") {
    const first = strip.querySelector(".extra");
    strip.querySelector(".cut-line").style.left = `${first.offsetLeft + first.offsetWidth * 0.35}px`;
  }
  $("chunks-note").innerHTML = NOTES[kind];
}
document.querySelectorAll("[data-transit]").forEach((b) => b.addEventListener("click", () => showTransit(b.dataset.transit)));
showTransit("sent");
