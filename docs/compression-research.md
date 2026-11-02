# Tiny video for phones, relays and space links: findings and v2 plan

November 2026. This note records a red-team review of the loops dots format (v1), a survey of government, space-agency and industry compression work, and measured results. It sets the plan for v2.

## Requirements (the bar any version must clear)

1. **Quality at equal bytes**, measured against AV1 on standard test video.
2. **Bit errors and lost chunks** degrade part of a loop, never the whole file.
3. **Truncation**: a relay can cut a file shorter and the remainder still plays the whole loop at lower quality.
4. **Encoder cost** fits a phone or a low-power edge/spacecraft processor.
5. **Real-time decode** (≥ 30 fps) on a mid-range Android phone.
6. **Provenance**: anything the decoder synthesizes (grain, upscaled detail, generated texture) is declared, and every loop is content-addressed and signed.

## Measured: quality at equal bytes (requirement 1)

`scripts/bench/rd-bench.sh` encodes a 6-second, 288×288 crop of the Xiph *foreman* sequence (a face-to-camera handheld shot) and scores each result against the original frame by frame. PSNR is luma; SSIM is all channels.

| Method | Bytes | PSNR-Y | SSIM |
| --- | ---: | ---: | ---: |
| AV1 offline (libaom 2-pass) | 28 181 | 30.43 dB | 0.888 |
| AV1 offline | 53 352 | 33.39 dB | 0.929 |
| AV1 offline | 100 384 | 36.53 dB | 0.956 |
| AV1 offline | 197 138 | 39.37 dB | 0.972 |
| AV1 phone-like (libaom real-time, speed 7, no lookahead: Chrome's WebCodecs configuration) | 29 857 | 28.28 dB | 0.841 |
| AV1 phone-like | 107 591 | 33.70 dB | 0.923 |
| AV1 phone-like | 207 673 | 36.05 dB | 0.946 |
| H.264 offline (x264 veryslow 2-pass) | 102 092 | 33.87 dB | 0.932 |
| Dots v1, 32², 16 steps, best case | 15 801 | 21.96 dB | 0.717 |
| Dots v1, 64², 16 steps, best case | 58 392 | 22.52 dB | 0.757 |
| Dots v1, 128², 16 steps, best case | 205 503 | 22.74 dB | 0.774 |
| Dots v1, 128², 64 steps, best case | 355 974 | 23.04 dB | 0.797 |

"Best case" shows each dots keyframe fully formed and held, without the in-flight gaps of the real player. Even so, **AV1 at 28 KB beats dots v1 at 206 KB by 7.7 dB.** v1 also loses color: each dot's color is averaged across the clip by brightness rank, which pushes skin and sky toward sepia. And it updates only six times per second.

Verdict: v1 is a visual style, not a compression method. It fails requirements 1–3.

The "phone-like" rows imitate Chrome's encoder configuration with ffmpeg. They have not been measured through WebCodecs on an Android device.

## What the survey found

### Industry codecs and game rendering

- **Chrome on Android can encode AV1 in software through WebCodecs.** It uses libaom (arm64), VP9 (libvpx) and H.264 (OpenH264). AV1 runs in real-time-only mode: speed 7 (`latencyMode: 'quality'`), no lookahead, and several tools disabled. Rate control is per-frame quantizer only, with no region-of-interest map and no film-grain controls. Sources: Chromium `media/video/av1_video_encoder.cc`, `vpx_video_encoder.cc`, `third_party/libaom/options.gni`.
- **AV1 film grain synthesis** stores roughly 100–150 bytes of grain parameters instead of grain. The model (from the AV1 spec and dav1d `filmgrain_tmpl.c`, BSD-2):
  - a 73×82 template filled from a Gaussian table by a 16-bit LFSR;
  - an autoregressive filter with lag ≤ 3 (up to 24 luma coefficients);
  - a piecewise-linear scaling curve, applied in 32×32 blocks with overlap blending.

  Parameters can be estimated with libaom `noise_model.c`. Grain hides softness at low bitrates.
- **AMD FidelityFX FSR 1** (MIT) is a single-pass edge-adaptive upscaler (EASU, 12-tap Lanczos-2 approximation steered by local gradients) plus contrast-adaptive sharpening (RCAS). Both port to WebGL. FSR 2 / TAA need depth and motion vectors and do not fit decoded video.
- **Learned enhancement**: RAISR-style per-bucket filters, or 10k–100k-parameter WebGL super-resolution networks trained on the codec's own artifacts.
- **Perceptual finishing**: blue-noise dithering against banding; OKLab or JPEG XL's XYB for any custom primitives; luma-guided chroma upsampling.
- **Region of interest**: MediaPipe selfie segmentation (Apache-2.0, ~33 ms at 256² on a Pixel 6). Because WebCodecs has no ROI map, pre-smooth the background before encoding so the encoder spends bits on the person.
- **JPEG XL ideas** (libjxl, BSD-3): splines for hair and edges, patches, intensity-dependent noise, and progressive previews.

### Government and space agencies

- **ICER and ICER-3D** (NASA JPL, Mars rovers): wavelet coding with progressive bit-plane ordering, stopped at either a byte quota or a quality floor.
  - ICER-3D adds a 1-D transform along a third axis. For a loop that axis can be time, with wrap-around because the clip loops.
  - The integer 2/6 lifting filter keeps 3-D transforms of 12-bit data in 16 bits.
  - Context-modeled binary coding uses 17 contexts (ICER) or 19 (ICER-3D).
  - Sources: JPL IPN progress reports 42-155 and 42-168; NTRS 20060008608.
- **CCSDS 122.0-B-2**: wavelet image compression for spacecraft. Segments are independently coded and each can be truncated "at any point". It uses table-based codes with no arithmetic coder. Open implementations (MIT): `xbarin02/ccsds`, `maxim-komlik/ccsds122x0b2_impl`.
- **NGA's NPJE JPEG 2000 profile** (as implemented in GDAL): 19 quality layers from 0.03125 to 3.9 bpp, layer-first ordering, index markers. This allows range-request streaming of the first *n* bytes.
- **Region-of-interest priority**: JPL modified ICER to accept a priority map. A NIST-hosted face-coding study used background / head / core-face regions to reach 75:1, against 18:1 for JPEG, at equal recognition loss.
- **Rover practice**: thumbnails first, full frames on request.
- **Caveats**:
  - These codecs have no motion compensation, so expect ghosting on moving scenes at video rates.
  - Their tested rates bottom out around 0.03–0.09 bpp, while a 6-second loop at 100 KB is about 0.015–0.03 bpp.
  - The third-party ICER library is GPL-3.0, so we would write our own from the papers.

### "Smart pixel" representations (Gaussian splats and neural codecs)

- **Image-GS** (NYU/Intel/AMD, MIT):
  - Content-adaptive 2D Gaussians (position, scale, angle, RGB).
  - Rendered as a weight-normalized blend, which maps to two WebGL passes: additive (w·rgb, w), then divide.
  - Gradient-driven placement plus error-driven densification.
- **GaussianImage** (ECCV 2024): Cholesky-parameterized Gaussians with additive rendering, decoding at about 2,000 fps. As a codec it is weak: ~25.7 dB at 0.32 bpp on DIV2K.
- **Gaussian video codecs** (GSVC, D2GV, GaussianVideo): at best "comparable" to standard codecs on perceptual metrics, with encoding times of minutes to hours on server GPUs.
- **Overfitted neural codecs** (Cool-chic, C3) approach or beat HEVC with cheap decoders but need GPU-hours to encode.
- **Takeaway**: splats win on look, resolution independence and decode speed, not on bits. They are the right *renderer* for the "pixels rearranging" identity. They are not yet the right *compressor*.

## Plan

### Track A: lifelike loops on Android (built: see [loops v2](loops-v2.md))

Done: items 1–3 and 5. Remaining: item 4 (subject priority) and verification on physical Android phones.


1. **Base layer: AV1 through WebCodecs**, recorded on the phone, square, 360–432 px, two quantizer passes to land on a byte budget (~100 KB for 6 s). VP9 is the fallback.
2. **Container `.irl` v2**:
   - Closed groups of pictures every 2 seconds, each an independently decodable chunk with its own length and checksum, so a damaged chunk costs 2 seconds, not the loop.
   - Temporal layers where the encoder supports them, so a relay can drop enhancement frames without re-encoding.
   - An enhancement block under 1 KB: grain parameters, subject box, upscaler choice.
   - A SHA-256 content address and an Ed25519 signature.
3. **On-phone finishing** in WebGL, in this order:
   1. EASU upscale;
   2. RCAS sharpen (strongest on faces);
   3. AV1-style grain;
   4. blue-noise dither.

   Each synthesized stage is declared in the container.
4. **Subject priority**: MediaPipe selfie segmentation pre-smooths the background before encoding.
5. **"Smart pixels" as the look, not the codec**: a Gaussian-splat render mode over the decoded video, whose blend exponent slides from lifelike (p = 1) to mosaic. The loop can assemble itself from scattered splats at the start, so the identity is kept without paying for it in quality.

### Track B: progressive, error-tolerant coding for relays and space links (research)

An ICER-3D-style volume codec for six-second loops: integer 2/6 wavelets in space and time (wrapping in time), segment-independent coding, priority-ordered bit-planes, and subject-region priority. It answers requirements 2–3 by construction, so a file is decodable at any truncation point. It must be scored with the same harness against AV1, adding exams for truncation (10/25/50/100%), bit errors (10⁻⁵ to 10⁻³) and chunk loss (1–20%). If it can't get within a few dB of AV1 at relay-relevant sizes, AV1 with temporal layers remains the relay format.

### Not pursued

- **A blockchain "layer one"**: consensus needs round trips that delay-tolerant links don't have. Content-addressed, signed bundles over the Bundle Protocol (RFC 9171) provide integrity and authorship.
- **Custom cryptography**: use Ed25519 and AES-GCM.
