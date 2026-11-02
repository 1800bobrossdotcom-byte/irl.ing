# Honest Zoom: upscaling that can’t contradict what was sent

## The guarantee

A loop arrives at 360² and is shown at 720² or larger. Every upscaler invents the missing detail; normally nothing stops that invention from also *changing* what was sent.

Honest Zoom adds an integer **lock** after upscaling. Every 2×2 block of the 2× frame is adjusted so its four values sum to exactly four times the received pixel. That holds for brightness (Y) and both color planes (U, V).

Shrink the output back down with a 2×2 average and you get the received frame bit for bit. All added detail lives only in what the received pixels can’t see.

Three properties follow:

- **It works with any upscaler.** The lock comes after the upscaler, so the guarantee doesn’t depend on it. Today it follows FSR 1 EASU, RCAS sharpening and True Grain; a learned upscaler can be dropped in later under the same guarantee.
- **Anyone can check it.** AV1 decoding is bit-exact by specification, and the received chunks are covered by the Real Seal. Anyone holding the loop can confirm that a zoomed frame averages back to the signed frame.
- **It is stated in YUV**, the form video is decoded in. Conversion to RGB for the screen happens afterwards and is not part of the claim.

## How it works

### The lock

`lockBlock()` appears twice with the same algorithm: in `src/loops/honest-zoom.js`, the reference, and in `src/loops/finish-gl.js`, on the GPU.

1. **Find the gap.** Compute `diff = 4·received − (a + b + c + d)`.
2. **Spread it.** Divide `diff` as evenly as possible over the values that can still move. The block-dependent rotation of who takes the remainder avoids a fixed pattern.
3. **Repeat if needed.** A value can pin at 0 or 255, so the spreading is repeated. Each round either finishes or pins at least one value, so four rounds always reach the target.

On the GPU, planes live in R8 textures, where *v*/255 round-trips exactly. Each fragment recomputes its whole block with integer math and keeps its own value.

### Checking

- **During playback,** about one frame per second is read back (packed four values per texel on the GPU) and checked block by block against the received frame. The lab shows the running count.
- **Video export (lifelike look):** every frame is checked before it’s handed to the H.264 encoder. The MP4 itself is then compressed, so the claim covers the frames given to the encoder, not the compressed file.
- **Smart pixels:** when the look is showing, the picture is a style. Honest Zoom says it is paused rather than calling the picture faithful.

## Measured

`scripts/bench/honest-zoom-bench.mjs` sets up a ground truth and a received version:

- **Ground truth:** a real 720×720 talking-head crop of Xiph *KristenAndSara*, 2 s at 30 fps.
- **Received version:** the truth shrunk to 360², encoded with AV1 using Chrome’s real-time settings at loop budgets (100 KB and 200 KB per six seconds), and decoded.

It then upscales the received version back to 720² with several methods, with and without the lock, and scores each against the 720² truth.

| Upscaler | Loop budget | PSNR-Y, no lock | PSNR-Y, locked | SSIM, no lock → locked | Blocks contradicting the sent pixels, no lock → locked |
| --- | --- | ---: | ---: | --- | --- |
| Nearest | 100 KB | 29.09 | 29.09 | 0.9208 → 0.9208 | 0% → 0% |
| Bicubic | 100 KB | 31.01 | **31.32** | 0.9320 → 0.9332 | 38.3% → **0%** |
| Lanczos | 100 KB | 31.25 | **31.47** | 0.9325 → 0.9331 | 37.9% → **0%** |
| FSR 1 EASU | 100 KB | 31.30 | **31.62** | 0.9341 → 0.9351 | 43.5% → **0%** |
| Bicubic | 200 KB | 31.50 | **31.87** | 0.9442 → 0.9458 | 39.8% → **0%** |
| Lanczos | 200 KB | 31.78 | **32.04** | 0.9449 → 0.9458 | 39.6% → **0%** |
| FSR 1 EASU | 200 KB | 31.83 | **32.24** | 0.9462 → 0.9479 | 45.2% → **0%** |

Three things stand out:

1. **Ordinary upscalers contradict the received pixels in 38–45% of blocks.**
2. **The lock removes that entirely and *improves* quality, by 0.2–0.4 dB.** Pulling each block back to what was sent also pulls it toward the real camera.
3. **FSR 1 EASU with the lock is the best result at both budgets.**

Nearest-neighbor is faithful by construction but blocky, so faithful alone isn’t enough; the lock makes *good* upscalers faithful.

In the browser (headless Chromium with software WebGL), the GPU lock verified every checked playback frame and all 180 exported frames of the sample. Exporting took about 28 s there; phone GPU timings have not been measured.

## Prior art and what’s new

**Prior art:**

- **The lock idea:** consistency with the low-resolution input appears in iterative back-projection (Irani & Peleg, 1991) and in the consistency-enforcing module of *Explorable Super-Resolution* (Bahat & Michaeli, CVPR 2020).
- **Base plus enhancement layers:** MPEG-5 LCEVC.
- **Bounded-error coding:** JPEG-LS near-lossless mode.

**What we haven’t seen shipped:**

- an exact integer lock that works after any upscaler,
- run on phones for playback and export,
- checked against cryptographically signed source frames,
- and reported to the viewer as it plays.

## Next

- **A sender-side correction layer** for a ±k-per-pixel bound to the real camera (level 2). This needs a patent check against LCEVC before shipping.
- **A learned upscaler**, constrained the same way.
- **A per-pixel map** of how much detail was added.
- **Phone timings**, and a cheaper audit cadence if readback causes jank.
