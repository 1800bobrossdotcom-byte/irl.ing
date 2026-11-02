// Honest Zoom benchmark: does the integrity lock cost quality, and how often
// do ordinary upscalers contradict the pixels that were actually sent?
//
// Ground truth is a real 720×720 talking-head crop (Xiph "KristenAndSara").
// It is shrunk to 360², encoded with AV1 at loop budgets using Chrome's
// real-time settings, decoded, and upscaled back to 720² by several methods,
// each with and without the lock. Every result is scored against the 720²
// truth, and checked for faithfulness to the decoded 360² frames.
//
//   node scripts/bench/honest-zoom-bench.mjs [work-dir]
//
// Needs ffmpeg with libaom-av1 and network access to media.xiph.org once
// (only the first ~166 MB of the clip is fetched, with an HTTP range request).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bilinear2x, blockMismatches, easu2x, lockFrame, planes } from "../../src/loops/honest-zoom.js";

const work = process.argv[2] ?? join(process.env.TMPDIR ?? "/tmp", "irl-honest-zoom-bench");
mkdirSync(work, { recursive: true });
const at = (f) => join(work, f);
const ff = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 1 << 30 });

const SRC_FRAMES = 120; // 2 s at 60 fps, kept at 30 fps → 60 frames
const FRAME_BYTES = 6 + 1280 * 720 * 1.5;
if (!existsSync(at("kas_head.y4m"))) {
  execFileSync("curl", ["-sSf", "-r", `0-${200 + SRC_FRAMES * FRAME_BYTES}`, "-o", at("kas_head.y4m"), "https://media.xiph.org/video/derf/y4m/KristenAndSara_1280x720_60.y4m"]);
}
const raw = ["-f", "rawvideo", "-pix_fmt", "yuv420p"];
ff("-i", at("kas_head.y4m"), "-frames:v", String(SRC_FRAMES), "-vf", "crop=720:720:280:0,fps=30", ...raw, at("ref720.yuv"));
ff(...raw, "-s", "720x720", "-r", "30", "-i", at("ref720.yuv"), "-vf", "scale=360:360:flags=area", ...raw, at("low360.yuv"));

const S = 360;
const LOW = S * S * 1.5;
const HIGH = LOW * 4;
const frameCount = readFileSync(at("low360.yuv")).length / LOW;
const seconds = frameCount / 30;

function metrics(file) {
  // ffmpeg prints PSNR and SSIM summaries on stderr.
  const text = spawnSync(
    "ffmpeg",
    ["-hide_banner", ...raw, "-s", "720x720", "-i", file, ...raw, "-s", "720x720", "-i", at("ref720.yuv"), "-lavfi", "[0:v]split[a][b];[1:v]split[c][d];[a][c]psnr;[b][d]ssim", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  ).stderr;
  return {
    psnrY: Number(text.match(/PSNR y:([\d.]+)/)?.[1]),
    psnr: Number(text.match(/PSNR .*average:([\d.]+)/)?.[1]),
    ssim: Number(text.match(/SSIM .*All:([\d.]+)/)?.[1]),
  };
}
function faithfulness(upFile, decoded) {
  const up = readFileSync(upFile);
  let blocks = 0;
  let bad = 0;
  for (let f = 0; f < frameCount; f++) {
    const u = planes(up.subarray(f * HIGH, (f + 1) * HIGH), 2 * S);
    const d = planes(decoded.subarray(f * LOW, (f + 1) * LOW), S);
    bad += blockMismatches(u.y, d.y, S, S) + blockMismatches(u.u, d.u, S / 2, S / 2) + blockMismatches(u.v, d.v, S / 2, S / 2);
    blocks += S * S * 1.5;
  }
  return bad / blocks;
}
function locked(inFile, outFile, decoded) {
  const up = Buffer.from(readFileSync(inFile));
  for (let f = 0; f < frameCount; f++) lockFrame(up.subarray(f * HIGH, (f + 1) * HIGH), decoded.subarray(f * LOW, (f + 1) * LOW), S);
  writeFileSync(outFile, up);
}
function easuFile(decoded, outFile) {
  const out = Buffer.alloc(frameCount * HIGH);
  for (let f = 0; f < frameCount; f++) {
    const d = planes(decoded.subarray(f * LOW, (f + 1) * LOW), S);
    const o = out.subarray(f * HIGH, (f + 1) * HIGH);
    o.set(easu2x(d.y, S, S), 0);
    o.set(bilinear2x(d.u, S / 2, S / 2), 4 * S * S);
    o.set(bilinear2x(d.v, S / 2, S / 2), 5 * S * S);
  }
  writeFileSync(outFile, out);
}

const rows = [];
for (const perLoopKB of [100, 200]) {
  const budget = Math.round((perLoopKB * 1000 * seconds) / 6);
  const bitrate = Math.round((budget * 8) / seconds);
  const tag = `${perLoopKB}k`;
  ff(...raw, "-s", "360x360", "-r", "30", "-i", at("low360.yuv"), "-c:v", "libaom-av1", "-usage", "realtime", "-cpu-used", "7", "-lag-in-frames", "0", "-b:v", String(bitrate), "-maxrate", String(bitrate), "-minrate", String(bitrate), "-bufsize", String(bitrate * 2), at(`av1_${tag}.webm`));
  ff("-i", at(`av1_${tag}.webm`), ...raw, at(`dec_${tag}.yuv`));
  const decoded = readFileSync(at(`dec_${tag}.yuv`));
  const bytes = readFileSync(at(`av1_${tag}.webm`)).length;

  const methods = {
    nearest: () => ff(...raw, "-s", "360x360", "-i", at(`dec_${tag}.yuv`), "-vf", "scale=720:720:flags=neighbor", ...raw, at(`nearest_${tag}.yuv`)),
    bicubic: () => ff(...raw, "-s", "360x360", "-i", at(`dec_${tag}.yuv`), "-vf", "scale=720:720:flags=bicubic", ...raw, at(`bicubic_${tag}.yuv`)),
    lanczos: () => ff(...raw, "-s", "360x360", "-i", at(`dec_${tag}.yuv`), "-vf", "scale=720:720:flags=lanczos", ...raw, at(`lanczos_${tag}.yuv`)),
    easu: () => easuFile(decoded, at(`easu_${tag}.yuv`)),
  };
  for (const [name, make] of Object.entries(methods)) {
    make();
    const plain = at(`${name}_${tag}.yuv`);
    const honest = at(`${name}_${tag}_locked.yuv`);
    locked(plain, honest, decoded);
    rows.push({ budget: `${perLoopKB} KB/loop (${(bytes / 1000).toFixed(1)} KB for ${seconds} s)`, method: name, lock: "off", ...metrics(plain), unfaithful: faithfulness(plain, decoded) });
    rows.push({ budget: "", method: name, lock: "on", ...metrics(honest), unfaithful: faithfulness(honest, decoded) });
  }
}

console.log("budget".padEnd(36), "upscaler".padEnd(9), "lock", "PSNR-Y".padStart(8), "PSNR".padStart(7), "SSIM".padStart(7), "blocks contradicting sent pixels".padStart(34));
for (const r of rows) {
  console.log(
    r.budget.padEnd(36),
    r.method.padEnd(9),
    r.lock.padEnd(4),
    r.psnrY.toFixed(2).padStart(8),
    r.psnr.toFixed(2).padStart(7),
    r.ssim.toFixed(4).padStart(7),
    `${(r.unfaithful * 100).toFixed(1)}%`.padStart(34),
  );
}
