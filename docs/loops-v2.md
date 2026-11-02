# Little loops v2: AV1 in signed, damage-tolerant chunks

v2 replaces the v1 dots codec, which measured far below AV1 at equal bytes ([findings](compression-research.md)). It is Track A of that plan. The "smart pixels" idea survives as a playback look, not as the compression.

## Pipeline

1. **Record.** Hold to record, let go to pause, up to six seconds. A center-square crop is captured at 30 fps as BT.709 limited-range I420. The size is 360² by default and 288² on phones reporting ≤ 2 GB of memory. Timestamps follow recorded time, so takes join seamlessly. The raw clip (MediaRecorder) stays on the phone; sound is recorded separately as Opus at 24 kbit/s.
2. **Encode on the phone** with WebCodecs (`src/loops/loop-encoder.js`):
   - AV1 (`av01.0.04M.08`) where the browser can both encode and decode it, else VP9, else H.264.
   - Two temporal layers (`L1T2`) where supported.
   - A keyframe every 60 frames, so each 2-second group of pictures (GOP) decodes on its own.
   - One pass at the nominal bitrate for the chosen budget (50, 100 or 200 KB of video), plus a corrective pass if it missed by more than 10%.
3. **Measure.** The encoded clip is decoded once on the phone, which gives:
   - the luma PSNR of every frame against what the camera captured, stored in the file as `quality.psnrY`;
   - film-grain parameters: residual strength in 8 brightness bands, measured only in flat 8×8 blocks, plus its lag-1 spatial correlation (`src/loops/grain.js`).
4. **Package and sign** (`src/loops/container.js`). The chunks are written in this order: description, signature, base-layer video per GOP, sound, enhancement-layer video per GOP. The device's Ed25519 key signs the SHA-256 hash of every chunk. That key is non-extractable and kept in IndexedDB.
5. **Play and finish** (`src/loops/loop-player.js`, `src/loops/finish-gl.js`):
   - Decoding streams about 10 frames ahead, rather than holding the whole clip in memory.
   - Each frame goes through, in WebGL2:
     1. an FSR 1 EASU edge-adaptive upscale to the screen's resolution;
     2. FSR 1 RCAS sharpening with its noise guard;
     3. AV1-style grain from a deterministic 256² template, scaled per brightness band;
     4. ±½ code-value dithering.
   - The "Look" slider blends in oriented, overlapping splats that sample the frame and lean along its edges.
   - Each new loop assembles itself from scattered splats, then settles into the lifelike picture.

Everything added on playback is listed in the file's `synthesizedOnPlayback` field and in the page text.

## Saving and sharing: MP4 for people, .irl for irl.ing

`.irl` only plays on irl.ing, so **Save video** and **Share video** produce an ordinary MP4 (`src/loops/export-video.js`). The steps:

1. Each frame is decoded and finished exactly as playback finishes it: Glow-Up, True Grain, dither, and whatever look is selected. The entrance animation is left out.
2. Frames are drawn at 720² and re-encoded with H.264, chosen first because nearly every device plays it, then VP9 or AV1.
3. Sound is re-encoded as AAC where the browser can, otherwise Opus.
4. Mediabunny (MPL-2.0) writes the file. It is loaded only when someone exports.

Lost pieces hold the last good frame, so the MP4 is always the full six seconds.

Measured in headless Chromium:

- **Sample:** H.264 High profile, 720×720, 180 frames, 6.0 s, 1.22 MB, decoded cleanly by ffmpeg. It took about 13 s, with WebGL running in software.
- **Fake-camera loop:** the MP4 carries both a video and a sound track.

Android only opens the share sheet shortly after a tap. If making the video takes longer than about four seconds, the button becomes **Share video now** and a second tap shares it.

The `.irl` stays available, as a secondary download, for loops travelling between irl.ing users: it is about 100 KB, sealed, and survives a bad link.

## File format (.irl v2)

```
file  = "IRL2" u8 version=2 u8[3] reserved
chunk = "IRLC" type[4] u32 length payload[length] u32 crc32(type, length, payload)
```

All integers are little-endian.

| Type | Payload |
| --- | --- |
| `META` | UTF-8 JSON: codec, size, fps, frame count, GOP length, layer count, optional decoder description (base64), grain, measured quality, synthesized stages, encoder bitrate and passes. |
| `SIGN` | u8 algorithm (1 = Ed25519), u8[32] public key, u16 *n*, *n* × SHA-256(type ‖ payload) of every other chunk, u8[64] signature over the preceding bytes. The loop ID is SHA-256 of everything before the signature. |
| `VID ` | u16 GOP, u8 temporal layer, u8 reserved, u16 frame count, then per frame u32 timestamp (µs), u8 flags (bit 0 = keyframe), u32 size, data. |
| `AUDI` | u8 media-type length, media type, audio bytes. |

### Damage and relay behavior

| Event | Result |
| --- | --- |
| Bit error in a chunk | Its CRC fails and the chunk is skipped. Losing a base-layer chunk loses that GOP; the player holds the last good frame for those two seconds. |
| Corrupted length field | The reader finds the next `IRLC` sync word and continues. |
| File cut short | Every chunk before the cut is kept. The base layer comes first, so a cut anywhere after it still plays all six seconds at 15 fps (the built-in sample and a fake-camera loop both did at a 60% cut). Sound is sent after the base layer, so whether it survives depends on where the cut lands. |
| Relay trim | `trimLayers(bytes, 0)` copies all chunks except enhancement-layer video, with no decoding and no re-signing: about 46% smaller at 15 fps. The signature still verifies every chunk that remains ("4 of 7 signed parts present"). |
| Tampering | A changed chunk with a recomputed CRC is reported as unsigned, because its hash is not in the signed manifest. |

All of these are exercised by `tests/container.test.js` and in the browser by `tests/loops-browser.mjs`. The page's **In transit** controls let people see them happen.

## Measured

These numbers come from Chromium 153 (desktop, headless) at a 412×915 Android-sized viewport. They have not yet been measured on a physical Android phone.

| Clip | Budget | File | Quality (PSNR-Y) |
| --- | --- | --- | --- |
| Built-in sample, 360², 30 fps | 100 KB | 92.3 KB | 36.1 dB |
| Built-in sample | 50 KB | under 65 KB (test bound) | 34.3 dB |
| Chromium fake camera, two takes, with sound | 100 KB | ≈ 86 KB (≈ 69 KB video + 17 KB sound) | (pattern is synthetic) |

Encoding plus the quality-and-grain pass took about 3 seconds for the sample on a desktop CPU. Phone timings are the next thing to measure.

## Not yet done

- **Subject priority:** MediaPipe segmentation to soften the background before encoding, so the encoder spends bits on the person.
- **A codec-trained upscaler,** RAISR-style or a small WebGL network, to replace or follow EASU.
- **Spatial or quality layers** (only temporal layers exist today), and a fully progressive format for relays. That is Track B.
- **Link-based sharing,** so a text message carries a URL instead of a file.
- **Verification on real Android phones**, including hardware encoders, which may look worse at these bitrates.
