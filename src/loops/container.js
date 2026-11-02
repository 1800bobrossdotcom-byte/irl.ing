// .irl v2 container: a loop as a list of independent, checksummed chunks.
//
//   file   = "IRL2" u8 version(2) u8[3] reserved
//   chunk  = "IRLC" sync, type (4 ASCII), u32 length, payload, u32 CRC-32
//            CRC covers type + length + payload. All integers little-endian.
//
// Why chunks: a damaged chunk is detected by its CRC and skipped; the sync
// word lets the reader find the next chunk even if a length is corrupted;
// a truncated file still yields every chunk before the cut. Chunks are
// written in priority order (description, signature, base video layer,
// sound, enhancement layer) so cutting a file from the end drops the
// least important data first. A relay can drop whole chunks without
// decoding anything, and the signature still verifies what remains,
// because it signs every chunk's hash individually.

export const VERSION = 2;
const FILE_MAGIC = [0x49, 0x52, 0x4c, 0x32]; // IRL2
const SYNC = [0x49, 0x52, 0x4c, 0x43]; // IRLC
const HEADER = 8;
const CHUNK_OVERHEAD = 16;
export const TYPE = { META: "META", VIDEO: "VID ", AUDIO: "AUDI", SIGN: "SIGN" };
const ED25519 = 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const fromAscii = (b) => String.fromCharCode(...b);
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One framed chunk: sync, type, length, payload, CRC. */
export function frameChunk(type, payload) {
  const out = new Uint8Array(CHUNK_OVERHEAD + payload.length);
  const view = new DataView(out.buffer);
  out.set(SYNC, 0);
  out.set(ascii(type), 4);
  view.setUint32(8, payload.length, true);
  out.set(payload, 12);
  view.setUint32(12 + payload.length, (crc32(out.subarray(4, 12 + payload.length)) ^ 0xffffffff) >>> 0, true);
  return out;
}

export function fileHeader() {
  return Uint8Array.from([...FILE_MAGIC, VERSION, 0, 0, 0]);
}

/**
 * Read every intact chunk. Never throws on damage: corrupt chunks are
 * counted and skipped, and a cut-off final chunk is reported as truncated.
 */
export function readChunks(bytes) {
  if (bytes.length < HEADER || FILE_MAGIC.some((m, i) => bytes[i] !== m)) throw new Error("not an irl.ing v2 loop");
  if (bytes[4] !== VERSION) throw new Error(`unsupported loop version ${bytes[4]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let damaged = 0;
  let truncated = false;
  let at = HEADER;
  const isSync = (p) => SYNC.every((s, i) => bytes[p + i] === s);
  while (at + 4 <= bytes.length) {
    if (!isSync(at)) {
      // Lost framing: hunt for the next sync word.
      let next = at + 1;
      while (next + 4 <= bytes.length && !isSync(next)) next++;
      if (next + 4 > bytes.length) break;
      at = next;
      continue;
    }
    if (at + CHUNK_OVERHEAD > bytes.length) {
      truncated = true;
      break;
    }
    const length = view.getUint32(at + 8, true);
    const end = at + 12 + length;
    if (end + 4 > bytes.length) {
      // Either the file was cut here, or this length is corrupt; look for a
      // later sync word before deciding.
      let next = at + 4;
      while (next + 4 <= bytes.length && !isSync(next)) next++;
      if (next + 4 > bytes.length) {
        truncated = true;
        break;
      }
      damaged++;
      at = next;
      continue;
    }
    const expected = view.getUint32(end, true);
    const actual = (crc32(bytes.subarray(at + 4, end)) ^ 0xffffffff) >>> 0;
    if (expected !== actual) {
      damaged++;
      at += 4;
      continue;
    }
    chunks.push({ type: fromAscii(bytes.subarray(at + 4, at + 8)), payload: bytes.subarray(at + 12, end), offset: at, raw: bytes.subarray(at, end + 4) });
    at = end + 4;
  }
  return { chunks, damaged, truncated };
}

// ---- payloads -------------------------------------------------------------

/** frames: [{ timestamp (µs), key, data }] belonging to one GOP and layer. */
export function videoPayload(gop, layer, frames) {
  const parts = [new Uint8Array(6)];
  const head = new DataView(parts[0].buffer);
  head.setUint16(0, gop, true);
  head.setUint8(2, layer);
  head.setUint16(4, frames.length, true);
  for (const f of frames) {
    const h = new Uint8Array(9);
    const v = new DataView(h.buffer);
    v.setUint32(0, f.timestamp, true);
    v.setUint8(4, f.key ? 1 : 0);
    v.setUint32(5, f.data.length, true);
    parts.push(h, f.data);
  }
  return concat(parts);
}

export function readVideoPayload(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const gop = view.getUint16(0, true);
  const layer = view.getUint8(2);
  const count = view.getUint16(4, true);
  const frames = [];
  let at = 6;
  for (let i = 0; i < count; i++) {
    const timestamp = view.getUint32(at, true);
    const key = view.getUint8(at + 4) === 1;
    const size = view.getUint32(at + 5, true);
    frames.push({ timestamp, key, data: payload.subarray(at + 9, at + 9 + size), gop, layer });
    at += 9 + size;
  }
  if (at !== payload.length) throw new Error("malformed video chunk");
  return { gop, layer, frames };
}

export function audioPayload(mime, data) {
  const m = utf8.encode(mime);
  return concat([Uint8Array.of(m.length), m, data]);
}

function readAudioPayload(payload) {
  const length = payload[0];
  return { mime: fromUtf8.decode(payload.subarray(1, 1 + length)), data: payload.subarray(1 + length) };
}

// ---- signing --------------------------------------------------------------

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** A chunk's identity: SHA-256 of its type and payload. */
export async function chunkHash(type, payload) {
  return sha256(concat([ascii(type), payload]));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sign the hashes of the given chunks with an Ed25519 key pair.
 * SIGN payload: u8 alg, u8[32] public key, u16 n, n × u8[32] hashes, u8[64] signature.
 */
export async function signPayload(chunks, keyPair) {
  const hashes = await Promise.all(chunks.map((c) => chunkHash(c.type, c.payload)));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const count = new Uint8Array(2);
  new DataView(count.buffer).setUint16(0, hashes.length, true);
  const body = concat([Uint8Array.of(ED25519), publicKey, count, ...hashes]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, body));
  return concat([body, signature]);
}

/** Loop identity: SHA-256 of the signed manifest (algorithm, key, hashes). */
export async function loopId(signPayloadBytes) {
  return hex(await sha256(signPayloadBytes.subarray(0, signPayloadBytes.length - 64)));
}

/**
 * Check a parsed loop's signature and which signed chunks are present.
 * Returns { signed, valid, present, total, id, key, foreign }.
 */
export async function verify(chunks) {
  const sign = chunks.find((c) => c.type === TYPE.SIGN);
  if (!sign) return { signed: false };
  const p = sign.payload;
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const total = view.getUint16(33, true);
  const bodyLength = 35 + 32 * total;
  if (p[0] !== ED25519 || p.length !== bodyLength + 64) return { signed: true, valid: false, present: 0, total };
  const body = p.subarray(0, bodyLength);
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", p.slice(1, 33), { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, p.slice(bodyLength), body.slice());
  } catch {
    valid = false;
  }
  const signed = new Set();
  for (let i = 0; i < total; i++) signed.add(hex(p.subarray(35 + i * 32, 67 + i * 32)));
  let present = 0;
  let foreign = 0;
  for (const c of chunks) {
    if (c.type === TYPE.SIGN) continue;
    if (signed.has(hex(await chunkHash(c.type, c.payload)))) present++;
    else foreign++;
  }
  return { signed: true, valid, present, total, foreign, id: await loopId(p), key: hex(p.subarray(1, 33)) };
}

// ---- whole loops ----------------------------------------------------------

/**
 * Build a loop file.
 * meta: JSON-serializable description; frames: [{ timestamp, key, layer, data }]
 * in decode order; gopFrames: frames per closed GOP; audio: { mime, data } | null.
 */
export async function buildLoop({ meta, frames, gopFrames, audio = null, keyPair = null }) {
  const base = [];
  const enhancement = [];
  const gops = Math.ceil(frames.length / gopFrames);
  for (let g = 0; g < gops; g++) {
    const inGop = frames.slice(g * gopFrames, (g + 1) * gopFrames);
    const layers = [...new Set(inGop.map((f) => f.layer))].sort((a, b) => a - b);
    for (const layer of layers) {
      const chunk = { type: TYPE.VIDEO, payload: videoPayload(g, layer, inGop.filter((f) => f.layer === layer)) };
      (layer === 0 ? base : enhancement).push(chunk);
    }
  }
  const chunks = [{ type: TYPE.META, payload: utf8.encode(JSON.stringify(meta)) }, ...base];
  if (audio) chunks.push({ type: TYPE.AUDIO, payload: audioPayload(audio.mime, audio.data) });
  chunks.push(...enhancement);
  if (keyPair) chunks.splice(1, 0, { type: TYPE.SIGN, payload: await signPayload(chunks, keyPair) });
  return concat([fileHeader(), ...chunks.map((c) => frameChunk(c.type, c.payload))]);
}

/**
 * Parse a loop, tolerating damage. Returns the description, decodable video
 * frames in presentation order, sound, and a report of what was missing.
 */
export function parseLoop(bytes) {
  const { chunks, damaged, truncated } = readChunks(bytes);
  const metaChunk = chunks.find((c) => c.type === TYPE.META);
  if (!metaChunk) throw new Error("this loop’s description is missing or damaged");
  const meta = JSON.parse(fromUtf8.decode(metaChunk.payload));
  const byGop = new Map();
  for (const c of chunks) {
    if (c.type !== TYPE.VIDEO) continue;
    const v = readVideoPayload(c.payload);
    if (!byGop.has(v.gop)) byGop.set(v.gop, new Map());
    byGop.get(v.gop).set(v.layer, v.frames);
  }
  const gopCount = Math.ceil(meta.frameCount / meta.gopFrames);
  const frames = [];
  const missingGops = [];
  let layersPresent = Infinity;
  for (let g = 0; g < gopCount; g++) {
    const layers = byGop.get(g);
    // Higher layers depend on the base layer; without it the GOP is lost.
    if (!layers?.has(0) || !layers.get(0)[0]?.key) {
      missingGops.push(g);
      continue;
    }
    let usable = 0;
    while (layers.has(usable)) usable++;
    layersPresent = Math.min(layersPresent, usable);
    for (let l = 0; l < usable; l++) frames.push(...layers.get(l));
  }
  frames.sort((a, b) => a.timestamp - b.timestamp);
  const audioChunk = chunks.find((c) => c.type === TYPE.AUDIO);
  return {
    meta,
    frames,
    audio: audioChunk ? readAudioPayload(audioChunk.payload) : null,
    chunks,
    report: {
      damaged,
      truncated,
      missingGops,
      gops: gopCount,
      layers: meta.layers ?? 1,
      layersPresent: layersPresent === Infinity ? 0 : layersPresent,
    },
  };
}

/**
 * What a relay does under a tight link budget: drop enhancement layers
 * above maxLayer by copying chunks verbatim. No decoding, no re-signing.
 */
export function trimLayers(bytes, maxLayer) {
  const { chunks } = readChunks(bytes);
  const kept = chunks.filter((c) => c.type !== TYPE.VIDEO || readVideoPayload(c.payload).layer <= maxLayer);
  return concat([fileHeader(), ...kept.map((c) => c.raw)]);
}
