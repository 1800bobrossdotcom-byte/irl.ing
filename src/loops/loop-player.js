// Plays a parsed .irl v2 loop: WebCodecs decode, streamed a few frames
// ahead (not the whole clip in memory), then the Finisher pipeline.
// Timestamps keep growing across loops so the decoder never sees time go
// backwards. Missing GOPs just hold the last good frame.

import { Finisher } from "./finish-gl.js";

export const ASSEMBLE_MS = 1700;
const FADE_MS = 700;

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export class LoopPlayer {
  constructor(canvas) {
    this.finisher = new Finisher(canvas);
    this.canvas = canvas;
    this.options = { finish: true, sharpen: 0.5, grain: 1, look: 0, grid: 72, hardness: 0.25 };
    this.onLoop = null;
    this.onError = null;
    this.running = false;
  }

  async load(parsed) {
    this.stop();
    const { meta, frames } = parsed;
    if (!frames.length) throw new Error("none of this loop’s video arrived intact");
    this.meta = meta;
    this.frames = frames;
    this.size = meta.width;
    this.durationUs = Math.round((meta.frameCount * 1e6) / meta.fps);
    const config = {
      codec: meta.codec,
      codedWidth: meta.width,
      codedHeight: meta.height,
      ...(meta.description && { description: fromBase64(meta.description) }),
    };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!support.supported) throw new Error(`this phone can’t decode ${meta.codecName ?? meta.codec}`);
    this.config = config;
    this.finisher.setGrain(meta.grain ?? null);
    this.sizeCanvas();
    this.startDecoder();
  }

  startDecoder() {
    this.decoder?.state !== "closed" && this.decoder?.close();
    this.ready = [];
    this.fed = 0;
    this.received = 0;
    this.consumed = 0;
    this.feedIndex = 0;
    this.feedLoop = 0;
    this.t0 = null;
    this.lastLoop = 0;
    this.frameNo = 0;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.received++;
        if (this.t0 === null) this.t0 = performance.now() - frame.timestamp / 1000;
        this.ready.push(frame);
      },
      error: (e) => this.onError?.(e),
    });
    this.decoder.configure(this.config);
  }

  sizeCanvas() {
    const css = this.canvas.getBoundingClientRect().width || 360;
    const out = Math.max(this.size, Math.min(1080, Math.round(css * (window.devicePixelRatio || 1))));
    this.finisher.resize(out);
  }

  feed() {
    // Bound decoded-but-unshown frames too: decoding outpaces real time.
    while (this.decoder.state === "configured" && this.fed - this.consumed < 10 && this.decoder.decodeQueueSize < 4) {
      const f = this.frames[this.feedIndex];
      this.decoder.decode(
        new EncodedVideoChunk({
          type: f.key ? "key" : "delta",
          timestamp: f.timestamp + this.feedLoop * this.durationUs,
          data: f.data,
        }),
      );
      this.fed++;
      if (++this.feedIndex === this.frames.length) {
        this.feedIndex = 0;
        this.feedLoop++;
      }
    }
  }

  play() {
    this.running = true;
    this.assembleAt = performance.now();
    const tick = () => {
      if (!this.running) return;
      this.feed();
      this.present(performance.now());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Fly the smart pixels in again. */
  assemble() {
    this.assembleAt = performance.now();
  }

  present(now) {
    if (this.t0 === null) return;
    const elapsedUs = (now - this.t0) * 1000;
    let pick = -1;
    for (let i = 0; i < this.ready.length && this.ready[i].timestamp <= elapsedUs; i++) pick = i;
    if (pick >= 0) {
      const frame = this.ready[pick];
      this.finisher.upload(frame, this.size);
      for (let i = 0; i <= pick; i++) this.ready[i].close();
      this.ready.splice(0, pick + 1);
      this.consumed += pick + 1;
      this.frameNo++;
    }
    const loop = Math.floor(elapsedUs / this.durationUs);
    if (loop !== this.lastLoop) {
      this.lastLoop = loop;
      this.onLoop?.(loop);
    }
    const since = now - this.assembleAt;
    const assemble = Math.min(1, since / ASSEMBLE_MS);
    const fade = assemble < 1 ? 1 : Math.max(0, 1 - (since - ASSEMBLE_MS) / FADE_MS);
    this.finisher.render({ ...this.options, assemble, look: Math.max(this.options.look, fade), frameNo: this.frameNo });
  }

  /** Seconds into the loop currently on screen. */
  get position() {
    return this.t0 === null ? 0 : (((performance.now() - this.t0) * 1000) % this.durationUs) / 1e6;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ready?.forEach((f) => f.close());
    this.ready = [];
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
  }

  destroy() {
    this.stop();
    this.finisher.destroy();
  }
}
