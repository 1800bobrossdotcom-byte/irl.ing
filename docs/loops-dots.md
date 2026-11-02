# The dots format (.irl v1, retired)

> Superseded by [little loops v2](loops-v2.md). Measured against AV1 at equal bytes, v1 was a visual style rather than a codec ([findings](compression-research.md)). The codec remains in `src/loops/dots-codec.js` as a benchmark baseline for `scripts/bench/rd-bench.sh`; the lab no longer writes or opens v1 files.

`/loops/` is a lab for six-second, hold-to-record loops that are shared as **dots** rather than video. It runs entirely in the browser; nothing is uploaded.

## Recording

Hold the button (or the picture) to record, let go to pause, hold again to continue, up to six seconds in total. One `MediaRecorder` is paused and resumed, so the raw clip is a single file. MP4 is preferred where the browser can record it (current Chrome on Android); otherwise WebM. Sound is recorded separately as Opus at 24 kbit/s so a loop can carry it cheaply. While recording, 160×160 center-square frames are kept at 12 per second for the encoder; the front camera is mirrored to match what the person saw. The camera can be switched only before the first take.

## The idea

A loop is one fixed set of colored dots that rearranges itself. Every keyframe uses **all** the dots exactly once, so the picture is always made of the same pixels moving around.

Stored:

1. **Dot colors**: `grid²` RGB colors, one per dot, fixed for the whole loop. Dot *k* is the *k*-th darkest dot; its color is the average color found at brightness rank *k* across the clip.
2. **Brightness labels**: for each keyframe, every grid cell gets a bucket label `0…B-1`. The cells are ranked by brightness and split into *B* equal-size buckets, so each bucket always holds the same number of cells and the same number of dots.

Not stored: motion. The decoder pairs dots with cells inside each bucket by walking both along a Hilbert curve, dots by where they were on the previous keyframe and cells by where they are. Nearby dots therefore travel to nearby places. The algorithm is integer-only and deterministic, so every device rebuilds identical paths.

Between keyframes the player moves each dot from its cell on one keyframe to its cell on the next. *Settle* holds the picture for 40% of each keyframe interval and then glides; *Flow* never stops.

## Binary layout (little-endian)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `IRLD` |
| 4 | 1 | Version, `1` |
| 5 | 1 | Flags: bit 0 = sound present |
| 6 | 2 | Grid side (2–255) |
| 8 | 2 | Buckets *B* (2–256) |
| 10 | 1 | Keyframes per second |
| 11 | 1 | Reserved, `0` |
| 12 | 2 | Keyframe count |
| 14 | 4 | Compressed body length *L* |
| 18 | *L* | Body, raw DEFLATE |
| … | 1 + *m* | Sound media type length and UTF-8 type (if flag) |
| … | 4 + *n* | Sound byte length and bytes (if flag) |

The body before compression is three planar, delta-coded color channels (`grid²` bytes each), then the first keyframe's labels, then each later keyframe's labels as the byte difference from the previous keyframe. Unchanged cells become zeros, which DEFLATE stores almost for free.

## Measured sizes

A synthetic 6-second clip at 6 keyframes per second with 16 brightness steps, no sound (from `node --test`-style benchmarks in this repo):

| Grid | Dots | Loop file |
| --- | --- | --- |
| 32² | 1,024 | ≈ 12 KB |
| 64² | 4,096 | ≈ 32 KB |
| 128² | 16,384 | ≈ 76 KB |
| 160² | 25,600 | ≈ 103 KB |

The built-in sample scene measured 7.3 KB at 32², 25.7 KB at 64² and 81.9 KB at 128². Real camera footage varies with motion and detail; the lab shows the actual size next to the raw clip's size. Sound adds roughly 18 KB for six seconds.

## Limits and next steps

- Measured against AV1 on the Xiph *foreman* clip, v1 is far less efficient: 22.7 dB at 206 KB versus 30.4 dB for AV1 at 28 KB ([findings](compression-research.md)). Treat v1 as a look, not a codec.
- Colors are fixed per dot, so hues that share a brightness get averaged; more brightness steps buy accuracy for bytes.
- The jump from the last keyframe back to the first is not path-matched, so loops "re-form" at the seam.
- The lab is verified in Chromium at a 412×915 Android-like viewport with Chromium's fake camera and microphone, not yet on a physical Android phone.
- Version 2 ideas: per-dot color drift, a small per-keyframe motion hint, seam matching, and a link-based share so a text message carries a URL instead of a file.
