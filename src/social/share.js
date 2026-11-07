// Sharing a finished loop with friends, for the recorder to call.
//
//   const stills = await makeStills(clip);          // or frames, or a canvas
//   const result = await shareLoop(irlBytes, stills);
//   show(result.message);                           // always set
//
// The server checks the loop's Real Seal, runs the safety review on the three
// stills (start, middle, end), and answers with what happened. No imports,
// so it can be loaded on its own.

const MAX_STILL_BYTES = 160 * 1024; // the server's limit per still
const MAX_SIDE = 720;
const QUALITIES = [0.85, 0.72, 0.6, 0.48];

/** BT.709 limited-range I420 (what the recorder keeps) to RGBA. */
function i420ToImageData(i420, width, height) {
  const out = new ImageData(width, height);
  const d = out.data;
  const cw = Math.ceil(width / 2);
  const uBase = width * height;
  const vBase = uBase + cw * Math.ceil(height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = (y >> 1) * cw + (x >> 1);
      const Y = 1.1644 * (i420[y * width + x] - 16);
      const U = i420[uBase + c] - 128;
      const V = i420[vBase + c] - 128;
      const i = (y * width + x) * 4;
      d[i] = Y + 1.7927 * V;
      d[i + 1] = Y - 0.2132 * U - 0.5329 * V;
      d[i + 2] = Y + 2.1124 * U;
      d[i + 3] = 255;
    }
  }
  return out;
}

function sizeOf(source) {
  return {
    width: source.displayWidth ?? source.videoWidth ?? source.naturalWidth ?? source.width,
    height: source.displayHeight ?? source.videoHeight ?? source.naturalHeight ?? source.height,
  };
}

/** Copy one frame onto its own canvas right away (the source may change). */
function snapshot(frame, size) {
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  if (ArrayBuffer.isView(frame)) {
    if (!size) throw new Error("makeStills needs the frame size for I420 frames.");
    canvas.width = canvas.height = size;
    g.putImageData(i420ToImageData(frame, size, size), 0, 0);
  } else if (frame instanceof ImageData) {
    canvas.width = frame.width;
    canvas.height = frame.height;
    g.putImageData(frame, 0, 0);
  } else {
    const { width, height } = sizeOf(frame);
    if (!(width > 0 && height > 0)) throw new Error("That frame has no picture yet.");
    canvas.width = width;
    canvas.height = height;
    g.drawImage(frame, 0, 0, width, height);
  }
  return canvas;
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** A JPEG of at most MAX_STILL_BYTES: lower quality first, then smaller. */
async function jpeg(source) {
  let scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  for (;;) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const g = canvas.getContext("2d");
    g.fillStyle = "#000";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of QUALITIES) {
      const blob = await toBlob(canvas, quality);
      if (!blob || blob.type !== "image/jpeg") throw new Error("This browser can’t make JPEG stills.");
      if (blob.size <= MAX_STILL_BYTES) return new Uint8Array(await blob.arrayBuffer());
    }
    scale *= 0.7;
  }
}

export function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Three JPEG stills (start, middle, end) as base64, each 160 KB at most.
 *
 * `source` can be:
 *  - the recorder's clip, { frames, size }, whose frames are square I420;
 *  - an array of frames: canvases, ImageBitmaps, VideoFrames, images,
 *    ImageData, or I420 buffers (pass { size } for those);
 *  - one canvas (or other image), copied three times. Frames are better:
 *    the safety review looks at the start, middle and end.
 */
export async function makeStills(source, { size } = {}) {
  let frames = source;
  if (source && !Array.isArray(source) && Array.isArray(source.frames)) {
    frames = source.frames;
    size ??= source.size;
  }
  if (!Array.isArray(frames)) frames = [frames, frames, frames];
  if (!frames.length) throw new Error("There are no frames to make stills from.");
  const last = frames.length - 1;
  const picks = [frames[0], frames[Math.floor(last / 2)], frames[last]].map((f) => snapshot(f, size));
  const stills = [];
  for (const canvas of picks) stills.push(toBase64(await jpeg(canvas)));
  return stills;
}

/**
 * Share a loop (its .irl bytes) with your friends.
 * Resolves to the server's { id, status, message, supportResources }, where
 * status is "visible", "held" or "removed". If the share didn't go through,
 * status is "error" and message says why. Never throws.
 * When supportResources is true, show the person where to find support.
 */
export async function shareLoop(irlBytes, stills) {
  const bytes = irlBytes instanceof Uint8Array ? irlBytes : new Uint8Array(irlBytes instanceof Blob ? await irlBytes.arrayBuffer() : irlBytes);
  let res;
  try {
    res = await fetch("/api/auth/irl/loops/share", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loop: toBase64(bytes), thumbs: stills }),
    });
  } catch {
    return { status: "error", message: "You’re offline. Try again.", supportResources: false };
  }
  const body = (await res.json().catch(() => null)) ?? {};
  if (!res.ok) {
    const message = body.message || (res.status === 401 ? "Sign in to share." : res.status === 429 ? "Too many tries. Wait a minute and try again." : "Couldn’t share. Try again.");
    return { status: "error", message, supportResources: false, httpStatus: res.status };
  }
  return { id: body.id, status: body.status, message: body.message, supportResources: Boolean(body.supportResources) };
}
