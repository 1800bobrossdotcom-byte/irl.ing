import { buildLoop, parseLoop, readChunks, readVideoPayload, TYPE, trimLayers, verify } from "./container.js";
import { deviceKey } from "./device-key.js";
import { encodeClip, FPS, GOP_FRAMES, measure } from "./loop-encoder.js";
import { exportVideo } from "./export-video.js";
import { LoopPlayer } from "./loop-player.js";
import { captureSize, LoopRecorder, MAX_MS } from "./loop-recorder.js";
import { sampleClip } from "./sample-clip.js";

const $ = (id) => document.getElementById(id);
const OPTIONS = {
  budget: [[50, "50 KB"], [100, "100 KB"], [200, "200 KB"]],
  finish: [["on", "On"], ["off", "Off"]],
  sharpen: [["off", "Off"], ["soft", "Soft"], ["crisp", "Crisp"]],
  grain: [["on", "On"], ["off", "Off"]],
  grid: [[96, "Fine"], [72, "Medium"], [48, "Bold"]],
  hardness: [["soft", "Soft"], ["hard", "Crisp"]],
  transit: [["original", "As sent"], ["relay", "Relay trim"], ["damaged", "Damaged chunk"], ["cut", "Cut at 60%"]],
};
const SHARPEN = { off: null, soft: 1, crisp: 0.2 };
const HARDNESS = { soft: 0.2, hard: 0.9 };
const MIN_MS = 500;

const settings = { budget: 100, finish: "on", sharpen: "soft", grain: "on", grid: 72, hardness: "soft", transit: "original" };
const recorder = new LoopRecorder($("live"), { onProgress: showProgress });
let player = null;
const audio = new Audio();
let clip = null; // recorded or sample source frames
let original = null; // bytes of the loop as encoded here, or as opened
let currentBytes = null;
let encodeToken = 0;
let showToken = 0;
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

function getPlayer() {
  if (!player) {
    player = new LoopPlayer($("player"));
    player.onLoop = () => {
      if (!audio.src) return;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    };
    player.onError = (e) => status(`Playback hit a problem (${e.message}).`);
    player.onAudit = describeZoom;
  }
  applyPlayback();
  return player;
}

function applyPlayback() {
  if (!player) return;
  Object.assign(player.options, {
    finish: settings.finish === "on",
    sharpen: SHARPEN[settings.sharpen],
    grain: settings.grain === "on" ? 1 : 0,
    grid: settings.grid,
    hardness: HARDNESS[settings.hardness],
    look: Number($("look").value) / 100,
  });
  describeZoom(player.audit);
}

/** The Honest Zoom line: what was checked, or why it's paused. */
function describeZoom(audit) {
  if (!player || !currentBytes) return;
  const o = player.options;
  let text;
  if (!o.finish) text = "Honest Zoom off: finishing is off, so this is a plain upscale.";
  else if (o.look > 0.001) text = "Honest Zoom paused: smart pixels are a style, not a faithful picture.";
  else if (!audit?.checked) text = "Honest Zoom on: checking frames against what was sent…";
  else if (audit.faithful === audit.checked)
    text = `Honest Zoom verified: ${audit.checked} of ${audit.checked} checked frames match what was sent, every 2×2 block.`;
  else text = `Honest Zoom found ${audit.mismatched} blocks that don’t match what was sent (${audit.checked - audit.faithful} of ${audit.checked} frames).`;
  $("zoom").textContent = text;
}

// ---- recording -----------------------------------------------------------

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
  $("player").hidden = mode !== "loop";
  $("raw").hidden = mode !== "raw";
  $("stage-hint").hidden = mode !== "hint";
  $("stage-tag").hidden = mode !== "loop" || !$("stage-tag").textContent;
  $("stage").classList.toggle("mirrored", mode === "live" && recorder.mirrored);
  $("stage").classList.toggle("holdable", mode === "live");
}

async function cameraOn() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.VideoEncoder) {
    status("This browser can’t record video here yet. Try another up-to-date browser, or use the sample.");
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
  const result = await recorder.finish();
  drawTicks(result.takes);
  recorder.close();
  $("record-controls").hidden = true;
  if (result.frames.length < FPS / 2) {
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
  if (!window.VideoEncoder) {
    status("This browser can’t encode video here yet (it needs WebCodecs). Try another up-to-date browser.");
    return;
  }
  $("setup-controls").hidden = true;
  status("Drawing the sample…");
  setTimeout(() => useClip(sampleClip(captureSize())));
});

// ---- encoding ------------------------------------------------------------

function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function useClip(result) {
  clip = result;
  if (clip.raw) $("raw").src = objectUrl(clip.raw);
  $("view-raw").disabled = !clip.raw;
  $("build").hidden = false;
  showProgress(clip.durationMs);
  setEncodable(true);
  encodeAndPlay();
}

async function encodeAndPlay() {
  const token = ++encodeToken;
  const { frames, size } = clip;
  try {
    const encoded = await encodeClip(frames, size, settings.budget * 1000, { onStage: status });
    if (token !== encodeToken) return;
    status("Checking quality and grain…");
    const measured = await measure(frames, encoded, size);
    if (token !== encodeToken) return;
    const sound = clip.audio ? { mime: clip.audio.type || "audio/webm", data: new Uint8Array(await clip.audio.arrayBuffer()) } : null;
    const meta = {
      v: 2,
      codec: encoded.choice.codec,
      codecName: encoded.choice.name,
      width: size,
      height: size,
      fps: FPS,
      frameCount: encoded.frames.length,
      gopFrames: GOP_FRAMES,
      layers: encoded.choice.layers,
      ...(encoded.description && { description: toBase64(encoded.description) }),
      grain: measured.grain,
      quality: { psnrY: Math.round(measured.psnrY * 100) / 100, measuredOn: "encoding device" },
      synthesizedOnPlayback: ["upscale", "sharpen", ...(measured.grain ? ["grain"] : []), "dither", "smart-pixels"],
      encoder: { bitrate: Math.round(encoded.bitrate), passes: encoded.passes },
    };
    const keyPair = await deviceKey();
    original = await buildLoop({ meta, frames: encoded.frames, gopFrames: GOP_FRAMES, audio: sound, keyPair });
    if (token !== encodeToken) return;
    choose("transit", "original", { quiet: true });
    await showBytes(original);
  } catch (error) {
    if (token === encodeToken) status(`Couldn’t make the loop (${error.message}).`);
  }
}

// ---- showing a loop ------------------------------------------------------

async function showBytes(bytes, note = "") {
  // The newest request wins if loads overlap (quick taps between tests).
  const token = ++showToken;
  currentBytes = bytes;
  let parsed;
  try {
    parsed = parseLoop(bytes);
  } catch (error) {
    status(`This loop can’t play: ${error.message}.`);
    return;
  }
  const checked = await verify(parsed.chunks);
  if (token !== showToken) return;
  const p = getPlayer();
  try {
    await p.load(parsed);
  } catch (error) {
    if (token === showToken) status(`This loop can’t play: ${error.message}.`);
    return;
  }
  if (token !== showToken) return;
  audio.pause();
  audio.removeAttribute("src");
  if (parsed.audio) audio.src = objectUrl(new Blob([parsed.audio.data], { type: parsed.audio.mime }));
  setStage("loop");
  setPressed("view", "loop");
  $("share").textContent = "Share video";
  p.play();
  if (parsed.audio) audio.play().catch(() => {});
  describe(parsed, checked, bytes, note);
  describeZoom(null);
}

function describe(parsed, checked, bytes, note) {
  const { meta, report, frames } = parsed;
  const videoBytes = frames.reduce((n, f) => n + f.data.length, 0);
  $("size-loop").textContent = kb(bytes.length);
  $("size-raw").textContent = clip?.raw ? kb(clip.raw.size) : clip?.sample ? "sample" : "not included";
  $("size-ratio").textContent = clip?.raw ? `${Math.round(clip.raw.size / bytes.length)}×` : "—";
  $("quality").textContent = meta.quality ? `${meta.quality.psnrY.toFixed(1)} dB` : "—";
  $("quality").title = "Luma PSNR of the decoded loop against what the camera captured, measured where it was encoded";
  // Each missing temporal layer halves the frame rate; lost GOPs don't change it.
  const fps = Math.round(meta.fps / 2 ** (report.layers - report.layersPresent));
  $("facts").textContent =
    `${meta.codecName ?? meta.codec} · ${meta.width}² · ${fps} fps · ${report.layersPresent} of ${report.layers} layer${report.layers > 1 ? "s" : ""} · ` +
    `video ${kb(videoBytes)}${parsed.audio ? ` + sound ${kb(parsed.audio.data.length)}` : ""}` +
    (meta.grain ? " · grain measured" : " · no grain measured");
  $("trust").textContent = !checked.signed
    ? "Unsigned: this browser couldn’t create a signing key."
    : !checked.valid
      ? "Signature invalid: this loop has been altered."
      : `Signed by device ${checked.key.slice(0, 8)} · loop ID ${checked.id.slice(0, 12)} · ` +
        `${checked.present} of ${checked.total} signed parts present${checked.foreign ? `, ${checked.foreign} unsigned part ignored` : ", all authentic"}`;
  const seconds = meta.gopFrames / meta.fps;
  const lost = report.missingGops.map((g) => `${g * seconds}–${Math.min((g + 1) * seconds, meta.frameCount / meta.fps)} s`);
  $("transit-report").textContent = [
    note,
    report.damaged ? `${report.damaged} damaged chunk${report.damaged > 1 ? "s" : ""} caught by checksum and skipped.` : "",
    report.truncated ? "The file ends early; everything before the cut plays." : "",
    lost.length ? `Lost in transit: ${lost.join(", ")} (holds the last good frame).` : "",
    !parsed.audio && clip?.audio ? "Sound didn’t arrive." : "",
  ]
    .filter(Boolean)
    .join(" ");
  $("stage-tag").textContent = lost.length ? "PART LOST IN TRANSIT" : report.layersPresent < report.layers ? `${fps} FPS · RELAYED` : "";
  $("stage-tag").hidden = !$("stage-tag").textContent;
  status(clip ? "Here’s your loop." : "Opened loop. This is everything the file holds.");
}

function setPressed(group, value) {
  document.querySelectorAll(`[data-${group}]`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[group] === value)));
}

document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.view === "raw" && clip?.raw) {
      player?.stop();
      audio.pause();
      setStage("raw");
      setPressed("view", "raw");
      $("raw").currentTime = 0;
      $("raw").play().catch(() => {});
    } else if (currentBytes) {
      $("raw").pause();
      showBytes(currentBytes);
    }
  }),
);

// ---- in-transit tests ----------------------------------------------------

function damagedCopy(bytes) {
  const copy = bytes.slice();
  const base = readChunks(bytes).chunks.filter((c) => c.type === TYPE.VIDEO && readVideoPayload(c.payload).layer === 0);
  const target = base[Math.min(1, base.length - 1)];
  copy[target.offset + 12 + Math.floor(target.payload.length / 2)] ^= 0x5a;
  return copy;
}

function transit(kind) {
  if (!original) return;
  if (kind === "relay") {
    const trimmed = trimLayers(original, 0);
    const saved = Math.round((1 - trimmed.length / original.length) * 100);
    return showBytes(trimmed, `A relay dropped the enhancement layer without decoding or re-signing: ${saved}% smaller.`);
  }
  if (kind === "damaged") return showBytes(damagedCopy(original), "One byte was flipped in transit.");
  if (kind === "cut") return showBytes(original.subarray(0, Math.floor(original.length * 0.6)), "The link dropped after 60% of the file.");
  return showBytes(original);
}

// ---- settings ------------------------------------------------------------

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

function choose(key, value, { quiet = false } = {}) {
  settings[key] = value;
  document
    .querySelectorAll(`[data-setting="${key}"] button`)
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(value))));
  if (quiet) return;
  if (key === "budget") {
    if (clip) encodeAndPlay();
  } else if (key === "transit") transit(value);
  else applyPlayback();
}

function setEncodable(encodable) {
  document.querySelectorAll('[data-setting="budget"] button').forEach((b) => (b.disabled = !encodable));
}

$("look").addEventListener("input", applyPlayback);
$("assemble").addEventListener("click", () => player?.assemble());

// ---- saving and sharing --------------------------------------------------

function saveFile(file) {
  const a = document.createElement("a");
  a.href = objectUrl(file);
  a.download = file.name;
  a.click();
}

/** The .irl itself: tiny and sealed, but only irl.ing can play it. */
$("download").addEventListener("click", () => {
  if (currentBytes) saveFile(new File([currentBytes], "irl-loop.irl", { type: "application/octet-stream" }));
});

let video = null; // { key, file, videoCodec, audioCodec } for the loop and look on screen
let exporting = null;

function videoKey() {
  return `${showToken}|${JSON.stringify(player?.options ?? {})}`;
}

function setBusy(busy) {
  for (const id of ["share", "save-video"]) $(id).disabled = busy;
}

/** An MP4 of the loop as it looks now, made once and reused. */
async function playableVideo() {
  const key = videoKey();
  if (video?.key === key) return video;
  if (exporting) return exporting;
  setBusy(true);
  status("Making your video… 0%");
  exporting = (async () => {
    const parsed = parseLoop(currentBytes);
    const made = await exportVideo(parsed, { ...player.options }, { onProgress: (p) => status(`Making your video… ${Math.round(p * 100)}%`) });
    video = { key, file: new File([made.blob], "irl-loop.mp4", { type: "video/mp4" }), ...made };
    return video;
  })();
  try {
    return await exporting;
  } finally {
    exporting = null;
    setBusy(false);
  }
}

function describeVideo(v) {
  const codec = { avc: "H.264", vp9: "VP9", av1: "AV1" }[v.videoCodec] ?? v.videoCodec;
  const sound = v.audioCodec ? `, ${v.audioCodec === "aac" ? "AAC" : "Opus"} sound` : ", no sound";
  const zoom = v.honest
    ? ` · Honest Zoom ${v.honest.faithful}/${v.honest.frames} frames verified before encoding`
    : " · smart-pixel style, not verified";
  return `MP4 · ${codec}${sound} · ${v.size}² · ${kb(v.file.size)}${zoom}`;
}

$("save-video").addEventListener("click", async () => {
  if (!currentBytes) return;
  try {
    const v = await playableVideo();
    saveFile(v.file);
    status(`Saved irl-loop.mp4 (${describeVideo(v)}).`);
  } catch (error) {
    status(`Couldn’t make the video (${error.message}).`);
  }
});

$("share").addEventListener("click", async () => {
  if (!currentBytes) return;
  const started = performance.now();
  let v;
  try {
    v = await playableVideo();
  } catch (error) {
    status(`Couldn’t make the video (${error.message}).`);
    return;
  }
  if (!navigator.canShare?.({ files: [v.file] })) {
    saveFile(v.file);
    status(`This browser can’t share files directly, so the video was saved (${describeVideo(v)}).`);
    return;
  }
  // Share sheets need a recent tap. If making the video took a while, ask
  // for one more tap rather than letting the browser refuse.
  if (performance.now() - started > 4000) {
    $("share").textContent = "Share video now";
    status(`Your video is ready (${describeVideo(v)}). Tap Share video now.`);
    return;
  }
  try {
    await navigator.share({ files: [v.file], title: "irl.ing loop" });
    $("share").textContent = "Share video";
  } catch (error) {
    if (error.name === "NotAllowedError") {
      $("share").textContent = "Share video now";
      status("Tap Share video now to open the share sheet.");
    } else if (error.name !== "AbortError") {
      saveFile(v.file);
      status("Sharing didn’t work on this device, so the video was saved instead.");
    }
  }
});

$("open-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    parseLoop(bytes);
  } catch (error) {
    status(`That file isn’t a loop this page can open (${error.message}).`);
    return;
  }
  if (recorder.recording) holdEnd();
  recorder.close();
  encodeToken++;
  $("setup-controls").hidden = true;
  $("record-controls").hidden = true;
  clip = null;
  original = bytes;
  $("view-raw").disabled = true;
  $("build").hidden = false;
  setEncodable(false);
  choose("transit", "original", { quiet: true });
  await showBytes(bytes);
});

function again() {
  encodeToken++;
  player?.stop();
  audio.pause();
  $("raw").pause();
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls = [];
  clip = null;
  original = null;
  currentBytes = null;
  recorder.reset();
  for (const id of ["size-loop", "size-raw", "size-ratio", "quality"]) $(id).textContent = "—";
  for (const id of ["facts", "trust", "zoom", "transit-report", "stage-tag"]) $(id).textContent = "";
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
window.addEventListener("resize", () => player?.sizeCanvas());

renderOptions();
setStage("hint");
showProgress(0);
