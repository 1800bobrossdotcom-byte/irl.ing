import { encodeFrames, parse, pickKeyframes, resampleSquare, serialize } from "./dots-codec.js";
import { DotsRenderer } from "./dots-renderer.js";
import { CAPTURE_FPS, CAPTURE_SIZE, LoopRecorder, MAX_MS } from "./loop-recorder.js";
import { sampleClip } from "./sample-clip.js";

const $ = (id) => document.getElementById(id);
const OPTIONS = {
  grid: [24, 32, 48, 64, 96, 128, 160].map((v) => [v, `${v}²`]),
  fps: [4, 6, 8, 12].map((v) => [v, String(v)]),
  buckets: [8, 16, 32, 64].map((v) => [v, String(v)]),
  motion: [["settle", "Settle"], ["flow", "Flow"]],
  shape: [["round", "Round"], ["square", "Square"]],
  sound: [["on", "On"], ["off", "Off"]],
};
const LADDER = [32, 48, 64, 96, 128];
const MIN_MS = 500;

const settings = { grid: 64, fps: 6, buckets: 16, motion: "settle", shape: "round", sound: "on" };
const live = $("live");
const recorder = new LoopRecorder(live, { onProgress: showProgress });
const renderer = new DotsRenderer($("dots"));
const audio = new Audio();
let clip = null; // { frames, durationMs, raw, audio } — null for an opened file
let opened = null; // a parsed .irl recipe when viewing someone's file
let current = null; // { recipe, bytes }
let ladder = [];
let buildToken = 0;
let urls = [];

function status(text) {
  $("status").textContent = text;
}

function kb(bytes) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${(bytes / 1000).toFixed(1)} KB`;
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

function showProgress(ms) {
  $("fill").style.width = `${(ms / MAX_MS) * 100}%`;
  $("progress").setAttribute("aria-valuenow", (ms / 1000).toFixed(1));
  $("done").disabled = ms < MIN_MS;
  $("flip").disabled = recorder.hasTakes || recorder.recording;
  $("rec-dot").hidden = !recorder.recording;
  const left = Math.max(0, (MAX_MS - ms) / 1000).toFixed(1);
  if (recorder.recording) status(`Recording… ${left}s left`);
  else if (recorder.hasTakes) status(`Paused. ${left}s left. Hold to keep going, or tap Done.`);
}

function drawTicks(takes) {
  const ticks = $("ticks");
  ticks.replaceChildren();
  let at = 0;
  for (const take of takes.slice(0, -1)) {
    at += take;
    const tick = document.createElement("i");
    tick.style.left = `${(at / MAX_MS) * 100}%`;
    ticks.append(tick);
  }
}

function setStage(mode) {
  $("live").hidden = mode !== "live";
  $("dots").hidden = mode !== "dots";
  $("raw").hidden = mode !== "raw";
  $("stage-hint").hidden = mode !== "hint";
  $("stage").classList.toggle("mirrored", mode === "live" && recorder.mirrored);
  $("stage").classList.toggle("holdable", mode === "live");
}

// ---- camera and hold-to-record ------------------------------------------

async function cameraOn() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status("This browser can’t record video here. Try Chrome on Android, or use the sample.");
    return;
  }
  status("Starting the camera…");
  try {
    await recorder.open();
  } catch (error) {
    status(
      error.name === "NotAllowedError"
        ? "Camera blocked. Allow camera access for this site in your browser settings, then try again."
        : `The camera didn’t start (${error.name || error.message}). You can still try the sample.`,
    );
    return;
  }
  $("setup-controls").hidden = true;
  $("record-controls").hidden = false;
  setStage("live");
  showProgress(0);
  drawTicks([]);
  status(recorder.hasAudio ? "Hold the button, or the picture, to record." : "Hold to record. No microphone, so this loop will be silent.");
}

let holdPointer = null;

function holdStart(event) {
  if (event.button > 0 || $("record-controls").hidden || clip || holdPointer !== null) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture?.(event.pointerId);
  if (recorder.begin()) {
    holdPointer = event.pointerId;
    $("record").classList.add("on");
  }
}

function pointerEnd(event) {
  if (event.pointerId !== holdPointer) return;
  // A late "capture lost" from the previous hold can arrive after the next
  // press has already captured the pointer again; that hold is still going.
  if (event.type === "lostpointercapture" && event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
  holdEnd();
}

function holdEnd() {
  holdPointer = null;
  if (!recorder.recording) return;
  recorder.end();
  $("record").classList.remove("on");
  drawTicks([...recorder.takes, 0]);
}

for (const el of [$("record"), $("stage")]) {
  el.addEventListener("pointerdown", holdStart);
  el.addEventListener("pointerup", pointerEnd);
  el.addEventListener("pointercancel", pointerEnd);
  el.addEventListener("lostpointercapture", pointerEnd);
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}
$("record").addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    event.preventDefault();
    if (recorder.begin()) $("record").classList.add("on");
  }
});
$("record").addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") holdEnd();
});
recorder.onFull = () => {
  holdPointer = null;
  $("record").classList.remove("on");
  finishRecording();
};

async function finishRecording() {
  if (clip) return;
  $("done").disabled = true;
  status("Making your loop…");
  const result = await recorder.finish();
  drawTicks(result.takes);
  recorder.close();
  $("record-controls").hidden = true;
  if (result.frames.length < 2) {
    status("That was too short to loop. Hold a little longer.");
    again();
    return;
  }
  useClip(result);
}

$("camera-on").addEventListener("click", cameraOn);
$("done").addEventListener("click", finishRecording);
$("flip").addEventListener("click", async () => {
  try {
    await recorder.open(recorder.facing === "user" ? "environment" : "user");
    setStage("live");
  } catch {
    status("Couldn’t switch cameras on this device.");
  }
});
$("try-sample").addEventListener("click", () => {
  $("setup-controls").hidden = true;
  useClip(sampleClip());
});

// ---- building and showing dots ------------------------------------------

function useClip(result) {
  clip = result;
  opened = null;
  if (clip.raw) $("raw").src = objectUrl(clip.raw);
  $("view-raw").disabled = !clip.raw;
  $("build").hidden = false;
  $("again").hidden = false;
  showProgress(clip.durationMs);
  setControlsEnabled(true);
  rebuild();
}

function recipeFromClip() {
  const picks = pickKeyframes(clip.frames.length, CAPTURE_FPS, settings.fps);
  const frames = picks.map((i) => resampleSquare(clip.frames[i], CAPTURE_SIZE, settings.grid));
  return encodeFrames(frames, settings);
}

async function withAudio(recipe) {
  if (clip?.audio && settings.sound === "on") {
    recipe.audio = { mime: clip.audio.type || "audio/webm", bytes: new Uint8Array(await clip.audio.arrayBuffer()) };
  }
  return recipe;
}

async function rebuild() {
  const token = ++buildToken;
  status("Arranging dots…");
  await new Promise((resolve) => setTimeout(resolve)); // let the status paint
  const recipe = opened ?? (await withAudio(recipeFromClip()));
  const bytes = await serialize(recipe);
  if (token !== buildToken) return;
  current = { recipe, bytes };
  renderer.motion = settings.motion;
  renderer.round = settings.shape === "round";
  renderer.load(recipe);
  showReadout();
  playDots();
  if (!$("ladder").hidden && !opened) compare();
  status(opened ? "Opened loop. This is everything the file holds." : "Here’s your loop. Try other builds below.");
}

function showReadout() {
  const { recipe, bytes } = current;
  $("size-recipe").textContent = kb(bytes.length);
  $("size-raw").textContent = clip?.raw ? kb(clip.raw.size) : clip?.sample ? "sample" : "not included";
  $("size-ratio").textContent = clip?.raw ? `${Math.round(clip.raw.size / bytes.length)}×` : "—";
  const n = recipe.grid * recipe.grid;
  $("dot-count").textContent = `${n.toLocaleString()} · ${recipe.frameCount} keys`;
}

function playDots() {
  setStage("dots");
  $("raw").pause();
  setPressed("view", "dots");
  renderer.play();
  playLoopAudio();
}

function playLoopAudio() {
  audio.pause();
  const sound = current?.recipe.audio;
  if (!sound) return;
  audio.src = objectUrl(new Blob([sound.bytes], { type: sound.mime }));
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

renderer.onLoop = () => {
  if (!current?.recipe.audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => {});
};

function setPressed(group, value) {
  document.querySelectorAll(`[data-${group}]`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[group] === value)));
}

document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.view === "raw" && clip?.raw) {
      renderer.stop();
      audio.pause();
      setStage("raw");
      setPressed("view", "raw");
      $("raw").currentTime = 0;
      $("raw").play().catch(() => {});
    } else playDots();
  }),
);

function setControlsEnabled(encodable) {
  for (const key of ["grid", "fps", "buckets", "sound"]) {
    document.querySelectorAll(`[data-setting="${key}"] button`).forEach((b) => {
      b.disabled = !encodable || (key === "sound" && !clip?.audio);
    });
  }
  $("compare").disabled = !encodable;
}

function renderOptions() {
  document.querySelectorAll("[data-setting]").forEach((group) => {
    const key = group.dataset.setting;
    group.replaceChildren(
      ...OPTIONS[key].map(([value, label]) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.dataset.value = value;
        button.setAttribute("aria-pressed", String(settings[key] === value));
        button.addEventListener("click", () => choose(key, value));
        return button;
      }),
    );
  });
}

function choose(key, value) {
  settings[key] = value;
  document
    .querySelectorAll(`[data-setting="${key}"] button`)
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(value))));
  if (key === "motion" || key === "shape") {
    renderer.motion = settings.motion;
    renderer.round = settings.shape === "round";
    for (const rung of ladder) {
      rung.renderer.motion = renderer.motion;
      rung.renderer.round = renderer.round;
    }
    return;
  }
  rebuild();
}

async function compare() {
  if (!clip) return;
  const box = $("ladder");
  box.hidden = false;
  ladder.forEach((rung) => rung.renderer.destroy());
  ladder = [];
  box.replaceChildren();
  for (const grid of LADDER) {
    const picks = pickKeyframes(clip.frames.length, CAPTURE_FPS, settings.fps);
    const recipe = encodeFrames(
      picks.map((i) => resampleSquare(clip.frames[i], CAPTURE_SIZE, grid)),
      { ...settings, grid },
    );
    const bytes = await serialize(recipe);
    const card = document.createElement("button");
    card.className = "rung";
    card.setAttribute("aria-pressed", String(grid === settings.grid));
    card.setAttribute("aria-label", `${grid} by ${grid} dots, ${kb(bytes.length)} without sound. Use this resolution.`);
    const canvas = document.createElement("canvas");
    const label = document.createElement("span");
    label.innerHTML = `<b>${grid}²</b> ${kb(bytes.length)}`;
    card.append(canvas, label);
    card.addEventListener("click", () => choose("grid", grid));
    box.append(card);
    const rung = { renderer: new DotsRenderer(canvas, { pixels: 240 }) };
    rung.renderer.motion = settings.motion;
    rung.renderer.round = settings.shape === "round";
    rung.renderer.load(recipe);
    rung.renderer.play();
    ladder.push(rung);
  }
}

$("compare").addEventListener("click", compare);

// ---- sharing and opening -------------------------------------------------

function loopFile() {
  return new File([current.bytes], `irl-loop-${current.recipe.grid}.irl`, { type: "application/octet-stream" });
}

function download() {
  const a = document.createElement("a");
  a.href = objectUrl(loopFile());
  a.download = loopFile().name;
  a.click();
}

$("download").addEventListener("click", download);
$("share").addEventListener("click", async () => {
  const file = loopFile();
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "irl.ing loop" });
    } catch (error) {
      if (error.name !== "AbortError") status("Sharing didn’t work on this device. Downloading instead.");
      if (error.name !== "AbortError") download();
    }
  } else {
    download();
    status("This browser can’t share files directly, so the loop was downloaded.");
  }
});

$("open-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const recipe = await parse(await file.arrayBuffer());
    if (recorder.recording) holdEnd();
    recorder.close();
    $("setup-controls").hidden = true;
    $("record-controls").hidden = true;
    clip = null;
    opened = recipe;
    $("view-raw").disabled = true;
    $("build").hidden = false;
    $("ladder").hidden = true;
    setControlsEnabled(false);
    for (const key of ["grid", "fps", "buckets"]) {
      settings[key] = recipe[key];
      document
        .querySelectorAll(`[data-setting="${key}"] button`)
        .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(recipe[key]))));
    }
    await rebuild();
    $("size-raw").textContent = "not included";
  } catch (error) {
    status(`That file isn’t a loop this page can open (${error.message}).`);
  }
});

function again() {
  buildToken++;
  renderer.stop();
  audio.pause();
  $("raw").pause();
  ladder.forEach((rung) => rung.renderer.destroy());
  ladder = [];
  $("ladder").hidden = true;
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls = [];
  clip = null;
  opened = null;
  current = null;
  recorder.reset();
  for (const id of ["size-recipe", "size-raw", "size-ratio", "dot-count"]) $(id).textContent = "—";
  $("build").hidden = true;
  $("record-controls").hidden = true;
  $("setup-controls").hidden = false;
  showProgress(0);
  drawTicks([]);
  setStage("hint");
}
$("again").addEventListener("click", () => {
  again();
  status("Ready for another.");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && recorder.recording) holdEnd();
});

renderOptions();
setStage("hint");
showProgress(0);
