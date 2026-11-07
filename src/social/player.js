// Tap-to-play for loops on the social screens. One LoopPlayer (one WebGL
// canvas) is shared and moved to whichever loop is playing, so a long feed
// never runs out of GPU contexts. Sound plays from a blob URL alongside.

import { parseLoop } from "../loops/container.js";
import { ASSEMBLE_MS, LoopPlayer } from "../loops/loop-player.js";

let player = null;
let canvas = null;
let audio = null;
let audioUrl = null;
let silentUrl = null;
let current = null; // the frame element that's playing or loading
let token = 0;

/**
 * A tenth of a second of silence, played straight from the tap, so the
 * audio element may play the loop's sound once it has downloaded.
 */
function primeAudio() {
  if (!silentUrl) {
    const n = 800;
    const wav = new Uint8Array(44 + n).fill(128);
    const v = new DataView(wav.buffer);
    [..."RIFF....WAVEfmt "].forEach((c, i) => (wav[i] = c.charCodeAt(0)));
    [..."data"].forEach((c, i) => (wav[36 + i] = c.charCodeAt(0)));
    v.setUint32(4, 36 + n, true);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, 8000, true);
    v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    v.setUint32(40, n, true);
    silentUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  }
  audio ??= new Audio();
  audio.src = silentUrl;
  audio.play().catch(() => {});
}

async function fetchBytes(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: "omit" });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

function setState(frame, state) {
  if (state) frame.dataset.state = state;
  else delete frame.dataset.state;
  frame.toggleAttribute("aria-busy", state === "loading");
  frame.dispatchEvent(new CustomEvent("loopstate", { bubbles: true }));
}

/** Stop whatever is playing and put its poster back. */
export function stopLoop() {
  token++;
  player?.stop();
  audio?.pause();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  canvas?.remove();
  if (current) {
    delete current.dataset.sound;
    setState(current, null);
  }
  current = null;
}

export const isPlaying = (frame) => current === frame;

/**
 * Play a loop inside `frame`. `link(fresh)` gives the loop's signed URL.
 * Links expire after 10 minutes, so after a failed fetch it's asked again
 * with fresh = true and should come back with a new link (or null if the
 * loop is gone). Resolves to null, or a message to show.
 */
export async function playLoop(frame, link) {
  stopLoop();
  primeAudio();
  const mine = ++token;
  current = frame;
  setState(frame, "loading");
  try {
    let bytes = await fetchBytes(await link(false));
    if (!bytes && mine === token) {
      const fresh = await link(true);
      if (!fresh) throw new Error("This loop isn’t available any more.");
      bytes = await fetchBytes(fresh);
    }
    if (mine !== token) return null;
    if (!bytes) throw new Error("This loop didn’t load. Try again.");
    const parsed = parseLoop(bytes);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "loop-canvas";
    }
    frame.append(canvas); // laid out before load, so it sizes for this screen
    if (!player) {
      player = new LoopPlayer(canvas);
      player.onLoop = () => {
        if (!audioUrl) return;
        audio.currentTime = 0;
        audio.play().catch(() => {});
      };
      player.onError = (error) => {
        const frame = current;
        stopLoop();
        frame?.dispatchEvent(new CustomEvent("looperror", { bubbles: true, detail: `This loop can’t play: ${error.message}.` }));
      };
    }
    await player.load(parsed);
    if (mine !== token) return null;
    audio.pause();
    if (parsed.audio) {
      audioUrl = URL.createObjectURL(new Blob([parsed.audio.data], { type: parsed.audio.mime }));
      audio.src = audioUrl;
      audio.play().then(() => mine === token && (frame.dataset.sound = "on"), () => {});
    } else {
      audio.removeAttribute("src");
    }
    player.play();
    // Reduced motion: no fly-in, just the loop.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) player.assembleAt = performance.now() - ASSEMBLE_MS - 1000;
    setState(frame, "playing");
    return null;
  } catch (error) {
    if (mine !== token) return null;
    stopLoop();
    // Our own messages are sentences; the player's are fragments.
    const text = error?.message || "This loop can’t play here.";
    return /\.$/.test(text) ? text : `This loop can’t play: ${text}.`;
  }
}

document.addEventListener("visibilitychange", () => document.hidden && stopLoop());
