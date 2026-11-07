// A QR code for an invite link, drawn on this device as SVG (no request
// leaves irl.ing). Always dark on light with a quiet zone, in both themes,
// because that's what every camera scans reliably.

import qrcode from "qrcode-generator";

const QUIET = 4; // modules of margin the QR standard asks for

export function qrSvg(text, label) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + QUIET * 2;
  let d = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.classList.add("qr");
  svg.innerHTML = `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#111110" d="${d}"/>`;
  return svg;
}
