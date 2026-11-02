// Hold to record, let go to pause, up to six seconds in one clip.
// While recording it keeps (1) the raw clip, which stays on this phone,
// (2) the sound on its own, and (3) square 30 fps I420 frames for the
// loop encoder. Frames are stamped on recorded time, so takes join up.

import { i420Size, rgbaToI420 } from "./yuv.js";

export const MAX_MS = 6000;
export const CAPTURE_FPS = 30;
const MAX_FRAMES = (MAX_MS / 1000) * CAPTURE_FPS;

/** Encode size: smaller on low-memory phones (frames are held until encoded). */
export function captureSize() {
  return (navigator.deviceMemory ?? 4) <= 2 ? 288 : 360;
}

function pickType(candidates) {
  if (typeof MediaRecorder === "undefined") return "";
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

// MP4 first: Android messaging apps accept it more widely than WebM.
const VIDEO_TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"];

function stopped(recorder) {
  if (!recorder || recorder.state === "inactive") return Promise.resolve(null);
  return new Promise((resolve) => {
    const parts = [];
    recorder.ondataavailable = (event) => event.data.size && parts.push(event.data);
    recorder.onstop = () => resolve(new Blob(parts, { type: recorder.mimeType }));
    recorder.stop();
  });
}

export class LoopRecorder {
  constructor(video, { onProgress, size = captureSize() } = {}) {
    this.video = video;
    this.onProgress = onProgress;
    this.size = size;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.facing = "user";
    this.reset();
  }

  reset() {
    this.frames = [];
    this.takes = [];
    this.recordedMs = 0;
    this.takeStart = 0;
    this.recording = false;
    this.nextCapture = 0;
    this.videoRecorder = null;
    this.audioRecorder = null;
  }

  get hasTakes() {
    return this.takes.length > 0;
  }

  get full() {
    return this.recordedMs >= MAX_MS;
  }

  elapsed(now = performance.now()) {
    return Math.min(MAX_MS, this.recordedMs + (this.recording ? now - this.takeStart : 0));
  }

  async open(facing = this.facing) {
    this.close();
    this.facing = facing;
    const video = { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      this.hasAudio = true;
    } catch (error) {
      if (error.name !== "NotAllowedError" && error.name !== "NotFoundError") throw error;
      // Microphone refused or missing: keep going with a silent loop.
      this.stream = await navigator.mediaDevices.getUserMedia({ video });
      this.hasAudio = false;
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play();
  }

  close() {
    this.recording = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get mirrored() {
    return this.facing === "user";
  }

  /** Finger down. */
  begin() {
    if (!this.stream || this.recording || this.full) return false;
    if (!this.videoRecorder) {
      const videoType = pickType(VIDEO_TYPES);
      this.videoRecorder = new MediaRecorder(this.stream, videoType ? { mimeType: videoType, videoBitsPerSecond: 2_500_000 } : {});
      this.videoRecorder.start();
      const audioTracks = this.stream.getAudioTracks();
      if (audioTracks.length) {
        const audioType = pickType(AUDIO_TYPES);
        this.audioRecorder = new MediaRecorder(new MediaStream(audioTracks), {
          ...(audioType && { mimeType: audioType }),
          audioBitsPerSecond: 24_000,
        });
        this.audioRecorder.start();
      }
    } else {
      this.videoRecorder.resume();
      this.audioRecorder?.resume();
    }
    this.recording = true;
    this.takeStart = performance.now();
    this.loop();
    return true;
  }

  /** Finger up. */
  end() {
    if (!this.recording) return;
    this.capture(performance.now());
    const now = performance.now();
    const total = this.elapsed(now);
    this.takes.push(total - this.recordedMs);
    this.recordedMs = total;
    this.recording = false;
    this.videoRecorder.pause();
    this.audioRecorder?.pause();
    this.onProgress?.(this.recordedMs);
  }

  loop() {
    if (!this.recording) return;
    const now = performance.now();
    this.capture(now);
    this.onProgress?.(this.elapsed(now));
    if (this.elapsed(now) >= MAX_MS) {
      this.end();
      this.onFull?.();
      return;
    }
    requestAnimationFrame(() => this.loop());
  }

  capture(now) {
    const video = this.video;
    if (!video.videoWidth) return;
    const size = this.size;
    while (this.nextCapture <= this.elapsed(now) && this.frames.length < MAX_FRAMES) {
      const side = Math.min(video.videoWidth, video.videoHeight);
      const sx = (video.videoWidth - side) / 2;
      const sy = (video.videoHeight - side) / 2;
      const ctx = this.ctx;
      ctx.save();
      if (this.mirrored) {
        ctx.translate(size, 0);
        ctx.scale(-1, 1);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
      ctx.restore();
      this.frames.push(rgbaToI420(ctx.getImageData(0, 0, size, size).data, size, size, new Uint8Array(i420Size(size, size))));
      this.nextCapture += 1000 / CAPTURE_FPS;
    }
  }

  /** Close out the clip. Raw video and sound come back as Blobs. */
  async finish() {
    if (this.recording) this.end();
    const [raw, audio] = await Promise.all([stopped(this.videoRecorder), stopped(this.audioRecorder)]);
    return {
      frames: this.frames,
      size: this.size,
      durationMs: this.recordedMs,
      takes: this.takes.slice(),
      raw,
      audio,
      mirrored: this.mirrored,
    };
  }
}
