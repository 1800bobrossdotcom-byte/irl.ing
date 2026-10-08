const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// Change physical-size metadata without decoding, resampling, or changing pixels.
export function setPngDensity(bytes, dpi) {
  if (!(bytes instanceof Uint8Array) || !SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    throw new Error("The download is not a valid PNG image.");
  }
  if (!Number.isFinite(dpi) || dpi < 1 || dpi > 9600) throw new Error("PNG density must be between 1 and 9600 DPI.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks = [];
  let offset = 8, outputLength = 8 + 21, sawData = false, endedData = false, sawEnd = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("The PNG contains an incomplete chunk.");
    const length = view.getUint32(offset), end = offset + length + 12;
    if (length > 0x7fffffff || end > bytes.length) throw new Error("The PNG contains an invalid chunk length.");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) {
      throw new Error("The PNG contains a damaged chunk.");
    }
    if (!chunks.length) {
      if (type !== "IHDR" || length !== 13) throw new Error("The PNG is missing its image header.");
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16], color = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth) ||
          bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) {
        throw new Error("The PNG image header is invalid.");
      }
    } else if (type === "IHDR") throw new Error("The PNG contains repeated image headers.");
    if (type === "IDAT") {
      if (endedData) throw new Error("The PNG image data is out of order.");
      sawData = true;
    } else if (sawData) endedData = true;
    if (type === "IEND") {
      if (length !== 0 || !sawData || end !== bytes.length) throw new Error("The PNG has an invalid ending.");
      sawEnd = true;
    }
    const chunk = { type, bytes: bytes.subarray(offset, end) };
    chunks.push(chunk);
    if (type !== "pHYs") outputLength += chunk.bytes.length;
    offset = end;
  }
  if (!sawEnd) throw new Error("The PNG is missing its ending.");
  const density = new Uint8Array(21), densityView = new DataView(density.buffer);
  densityView.setUint32(0, 9); density.set([112, 72, 89, 115], 4);
  const pixelsPerMeter = Math.round(dpi / .0254);
  densityView.setUint32(8, pixelsPerMeter); densityView.setUint32(12, pixelsPerMeter); density[16] = 1;
  densityView.setUint32(17, crc32(density.subarray(4, 17)));
  const output = new Uint8Array(outputLength);
  output.set(SIGNATURE); offset = 8;
  for (const chunk of chunks) {
    if (chunk.type === "pHYs") continue;
    output.set(chunk.bytes, offset); offset += chunk.bytes.length;
    if (chunk.type === "IHDR") { output.set(density, offset); offset += density.length; }
  }
  return output;
}
