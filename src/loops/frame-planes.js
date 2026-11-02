// Copy a decoded VideoFrame out as tightly packed I420 bytes. Software
// decoders give I420; hardware decoders often give NV12 (U and V
// interleaved), which is split here. Only the visible rectangle is kept.

export async function framePlanes(frame) {
  const rect = frame.visibleRect ?? { width: frame.codedWidth, height: frame.codedHeight };
  const w = rect.width;
  const h = rect.height;
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const buffer = new Uint8Array(frame.allocationSize());
  const layout = await frame.copyTo(buffer);
  const out = new Uint8Array(w * h + 2 * cw * ch);
  const rows = (plane, width, height, to) => {
    for (let r = 0; r < height; r++) out.set(buffer.subarray(plane.offset + r * plane.stride, plane.offset + r * plane.stride + width), to + r * width);
  };
  rows(layout[0], w, h, 0);
  if (frame.format === "I420" || frame.format === "I420A") {
    rows(layout[1], cw, ch, w * h);
    rows(layout[2], cw, ch, w * h + cw * ch);
  } else if (frame.format === "NV12") {
    const { offset, stride } = layout[1];
    for (let r = 0; r < ch; r++) {
      for (let c = 0; c < cw; c++) {
        out[w * h + r * cw + c] = buffer[offset + r * stride + 2 * c];
        out[w * h + cw * ch + r * cw + c] = buffer[offset + r * stride + 2 * c + 1];
      }
    }
  } else {
    throw new Error(`unsupported decoded pixel format ${frame.format}`);
  }
  return out;
}
