// Turn a loop into an ordinary MP4 that plays anywhere: galleries,
// messaging apps, desktop players. The .irl file stays the format loops
// travel in between irl.ing users; this is the format people keep.
//
// Each frame is decoded and finished exactly as playback finishes it. With the
// lifelike look, the Honest Zoom frame (2× the loop's size, 720² for a 360²
// loop) is checked block by block against the received frame and handed to
// the encoder as-is; with smart pixels showing, the styled canvas is recorded
// instead (and is not called faithful). H.264 first because nearly
// everything can play it, then VP9 or AV1. Sound is re-encoded as AAC where
// the browser can, otherwise Opus. Mediabunny (MPL-2.0) writes the MP4 and is
// only loaded when someone actually saves or shares a video.

import { Finisher } from "./finish-gl.js";
import { framePlanes } from "./frame-planes.js";
import { verifyFrame } from "./honest-zoom.js";
import { COLOR_SPACE } from "./yuv.js";

export const EXPORT_SIZE = 720;

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Decoded frames in presentation order, a few at a time. */
function decodedFrames(meta, frames) {
  const queue = [];
  let error = null;
  let wake = null;
  let fed = 0;
  let flushed = false;
  const decoder = new VideoDecoder({
    output(frame) {
      queue.push(frame);
      wake?.();
    },
    error(e) {
      error = e;
      wake?.();
    },
  });
  decoder.configure({
    codec: meta.codec,
    codedWidth: meta.width,
    codedHeight: meta.height,
    ...(meta.description && { description: fromBase64(meta.description) }),
  });
  const settle = () =>
    new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, 40); // never wait forever on a decoder holding frames
    });
  return {
    async next() {
      for (;;) {
        if (error) throw error;
        if (queue.length) return queue.shift();
        if (fed < frames.length) {
          const f = frames[fed++];
          decoder.decode(new EncodedVideoChunk({ type: f.key ? "key" : "delta", timestamp: f.timestamp, data: f.data }));
          if (decoder.decodeQueueSize > 2) await settle();
          continue;
        }
        if (!flushed) {
          flushed = true;
          await decoder.flush();
          continue;
        }
        return null;
      }
    },
    close() {
      queue.forEach((f) => f.close());
      if (decoder.state !== "closed") decoder.close();
    },
  };
}

async function decodeSound(audio, seconds) {
  try {
    const context = new OfflineAudioContext(1, 1, 48000);
    const buffer = await context.decodeAudioData(audio.data.slice().buffer);
    const length = Math.min(buffer.length, Math.round(seconds * buffer.sampleRate));
    if (length === buffer.length) return buffer;
    const trimmed = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) trimmed.copyToChannel(buffer.getChannelData(ch).subarray(0, length), ch);
    return trimmed;
  } catch {
    return null; // Unreadable sound shouldn't stop the video.
  }
}

/**
 * Render a parsed loop to an MP4 Blob.
 * look: the playback options ({ finish, sharpen, grain, look, grid, hardness }).
 * Returns { blob, videoCodec, audioCodec, honest: { frames, faithful } | null }.
 */
export async function exportVideo(parsed, look, { onProgress } = {}) {
  const mb = await import("mediabunny");
  const { meta, frames } = parsed;
  if (!frames.length) throw new Error("none of this loop’s video arrived");
  const fps = meta.fps;
  const total = meta.frameCount;
  const seconds = total / fps;

  const honest = look.finish && !(look.look > 0.001);
  const size = honest ? meta.width * 2 : EXPORT_SIZE;
  const videoCodec = await mb.getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width: size, height: size });
  if (!videoCodec) throw new Error("this browser can’t encode a video file");
  const sound = parsed.audio ? await decodeSound(parsed.audio, seconds) : null;
  const audioCodec = sound
    ? await mb.getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: sound.numberOfChannels, sampleRate: sound.sampleRate })
    : null;

  const canvas = document.createElement("canvas");
  const finisher = new Finisher(canvas);
  finisher.resize(size);
  finisher.setGrain(meta.grain ?? null);

  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
  const encoding = { codec: videoCodec, bitrate: mb.QUALITY_HIGH, keyFrameInterval: 2 };
  const video = honest ? new mb.VideoSampleSource(encoding) : new mb.CanvasSource(canvas, encoding);
  output.addVideoTrack(video, { frameRate: fps });
  let audioTrack = null;
  if (sound && audioCodec) {
    audioTrack = new mb.AudioBufferSource({ codec: audioCodec, bitrate: mb.QUALITY_HIGH });
    output.addAudioTrack(audioTrack);
  }
  await output.start();

  const stream = decodedFrames(meta, frames);
  const audit = { frames: 0, faithful: 0 };
  const planesOf = async (frame) => {
    if (!frame) return null;
    try {
      return { timestamp: frame.timestamp, i420: await framePlanes(frame) };
    } finally {
      frame.close();
    }
  };
  try {
    let current = await planesOf(await stream.next());
    let next = await planesOf(await stream.next());
    for (let i = 0; i < total; i++) {
      const us = (i * 1e6) / fps;
      // Hold the latest frame at or before this moment; lost pieces hold still.
      while (next && next.timestamp <= us) {
        current = next;
        next = await planesOf(await stream.next());
      }
      finisher.uploadI420(current.i420, meta.width);
      if (honest) finisher.zoomOnly({ ...look, frameNo: i });
      else finisher.render({ ...look, assemble: 1, frameNo: i });
      if (honest) {
        const zoomed = finisher.readZoom();
        audit.frames++;
        if (verifyFrame(zoomed, current.i420, meta.width).mismatched === 0) audit.faithful++;
        const sample = new mb.VideoSample(zoomed, {
          format: "I420",
          codedWidth: size,
          codedHeight: size,
          timestamp: i / fps,
          duration: 1 / fps,
          colorSpace: COLOR_SPACE,
        });
        await video.add(sample);
        sample.close();
      } else {
        await video.add(i / fps, 1 / fps);
      }
      if (i % 10 === 0) onProgress?.(i / total);
    }
  } finally {
    stream.close();
    finisher.destroy();
  }
  if (audioTrack) await audioTrack.add(sound);
  await output.finalize();
  onProgress?.(1);
  return { blob: new Blob([output.target.buffer], { type: "video/mp4" }), videoCodec, audioCodec, size, honest: honest ? audit : null };
}
