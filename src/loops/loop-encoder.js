// Encode recorded I420 frames with the phone's own WebCodecs encoder.
// AV1 first (best quality per byte), then VP9, then H.264. Two temporal
// layers when supported, so a relay can halve the frame rate by dropping
// chunks. A closed GOP every two seconds bounds the damage of a lost chunk.
// After encoding, the result is decoded once to measure real quality and
// to estimate the grain the encoder smoothed away.

import { estimateGrain } from "./grain.js";
import { COLOR_SPACE, psnr } from "./yuv.js";

export const FPS = 30;
export const GOP_FRAMES = 60;

const CANDIDATES = [
  { name: "AV1", codec: "av01.0.04M.08" },
  { name: "VP9", codec: "vp09.00.21.08" },
  { name: "H.264", codec: "avc1.42E01E" },
];

/** First codec this browser can both encode and decode at this size. */
export async function pickCodec(size) {
  if (typeof VideoEncoder === "undefined") return null;
  for (const candidate of CANDIDATES) {
    for (const scalabilityMode of ["L1T2", undefined]) {
      const config = encoderConfig(candidate.codec, size, 100_000, scalabilityMode);
      try {
        const [enc, dec] = await Promise.all([
          VideoEncoder.isConfigSupported(config),
          VideoDecoder.isConfigSupported({ codec: candidate.codec, codedWidth: size, codedHeight: size }),
        ]);
        if (enc.supported && dec.supported) return { ...candidate, scalabilityMode, layers: scalabilityMode ? 2 : 1 };
      } catch {
        // Try the next option.
      }
    }
  }
  return null;
}

function encoderConfig(codec, size, bitrate, scalabilityMode) {
  return {
    codec,
    width: size,
    height: size,
    bitrate: Math.round(bitrate),
    bitrateMode: "variable",
    framerate: FPS,
    latencyMode: "quality",
    ...(scalabilityMode && { scalabilityMode }),
  };
}

function videoFrame(buffer, size, index) {
  return new VideoFrame(buffer, {
    format: "I420",
    codedWidth: size,
    codedHeight: size,
    timestamp: Math.round((index * 1e6) / FPS),
    duration: Math.round(1e6 / FPS),
    colorSpace: COLOR_SPACE,
  });
}

async function encodeOnce(frames, size, choice, bitrate) {
  const out = [];
  let description = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (metadata?.decoderConfig?.description) {
        const d = metadata.decoderConfig.description;
        description = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
      }
      out.push({ timestamp: chunk.timestamp, key: chunk.type === "key", layer: metadata?.svc?.temporalLayerId ?? 0, data });
    },
    error(e) {
      failure = e;
    },
  });
  encoder.configure(encoderConfig(choice.codec, size, bitrate, choice.scalabilityMode));
  for (let i = 0; i < frames.length; i++) {
    if (failure) break;
    while (encoder.encodeQueueSize > 6) await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }));
    const frame = videoFrame(frames[i], size, i);
    encoder.encode(frame, { keyFrame: i % GOP_FRAMES === 0 });
    frame.close();
  }
  await encoder.flush().catch((e) => (failure ??= e));
  encoder.close();
  if (failure) throw failure;
  return { frames: out, description, bytes: out.reduce((n, f) => n + f.data.length, 0) };
}

/**
 * Encode to a byte budget for the video track. One pass at the nominal
 * bitrate, then one corrective pass if the size missed by more than ~10%.
 */
export async function encodeClip(frames, size, budgetBytes, { onStage } = {}) {
  const choice = await pickCodec(size);
  if (!choice) throw new Error("This browser can’t encode video with WebCodecs.");
  const seconds = frames.length / FPS;
  const nominal = (budgetBytes * 8) / seconds;
  onStage?.(`Encoding ${choice.name}…`);
  let best = { ...(await encodeOnce(frames, size, choice, nominal * 0.95)), bitrate: nominal * 0.95 };
  const passes = [best];
  if (Math.abs(best.bytes - budgetBytes) / budgetBytes > 0.1) {
    onStage?.(`Encoding ${choice.name}, second pass…`);
    const bitrate = best.bitrate * (budgetBytes / best.bytes) * 0.97;
    const second = { ...(await encodeOnce(frames, size, choice, bitrate)), bitrate };
    passes.push(second);
    const miss = (r) => Math.abs(r.bytes - budgetBytes) + (r.bytes > budgetBytes * 1.1 ? budgetBytes : 0);
    if (miss(second) < miss(best)) best = second;
  }
  return { ...best, choice, passes: passes.length };
}

/** Copy the luma plane out of a decoded frame, whatever its pixel layout. */
async function lumaOf(frame, size) {
  const buffer = new Uint8Array(frame.allocationSize());
  const layout = await frame.copyTo(buffer);
  const y = new Uint8Array(size * size);
  const { offset, stride } = layout[0];
  for (let row = 0; row < size; row++) y.set(buffer.subarray(offset + row * stride, offset + row * stride + size), row * size);
  return y;
}

/**
 * Decode the encoded clip and compare it with the source: luma PSNR over
 * every frame, plus grain parameters from sampled frame pairs.
 */
export async function measure(sourceFrames, encoded, size) {
  const decoded = [];
  let failure = null;
  const pending = [];
  let outputs = 0;
  const decoder = new VideoDecoder({
    output(frame) {
      const index = outputs++; // copies finish out of order; keep output order
      pending.push(lumaOf(frame, size).then((y) => (decoded[index] = y)).finally(() => frame.close()));
    },
    error(e) {
      failure = e;
    },
  });
  decoder.configure({
    codec: encoded.choice.codec,
    codedWidth: size,
    codedHeight: size,
    ...(encoded.description && { description: encoded.description }),
  });
  for (const f of encoded.frames) {
    if (failure) break;
    while (decoder.decodeQueueSize > 6) await new Promise((r) => decoder.addEventListener("dequeue", r, { once: true }));
    decoder.decode(new EncodedVideoChunk({ type: f.key ? "key" : "delta", timestamp: f.timestamp, data: f.data }));
  }
  await decoder.flush().catch((e) => (failure ??= e));
  await Promise.all(pending);
  decoder.close();
  if (failure) throw failure;
  const n = Math.min(decoded.length, sourceFrames.length);
  let mse = 0;
  const lumaLength = size * size;
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const p = psnr(sourceFrames[i], decoded[i], lumaLength);
    mse += p === Infinity ? 0 : (255 * 255) / 10 ** (p / 10);
    if (i % 15 === 7) pairs.push({ source: sourceFrames[i].subarray(0, lumaLength), decoded: decoded[i] });
  }
  mse /= n;
  return {
    psnrY: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    decodedFrames: n,
    grain: estimateGrain(pairs, size, size),
  };
}
