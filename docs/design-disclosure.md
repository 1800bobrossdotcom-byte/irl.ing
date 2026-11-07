# irl.ing design disclosure

A dated record of how irl.ing is designed: what each part does, how it works, what's new about it, and what was built when. It's written so an engineer could rebuild the system from it and an advisor could judge what's novel.

- **Prepared:** 6 November 2026, from the repository's history (`1800bobrossdotcom-byte/irl.ing`).
- **Status markers:** **Live** = running on irl.ing; **Built** = in the repository, not yet switched on; **Designed** = specified, not yet built.
- **Note on publication:** this repository is public, so everything committed here, including this file, is publicly disclosed on its commit date. Disclosure before filing affects patent rights, outright in most countries and after a one-year grace period in the US. Get advice from a patent attorney before relying on any of it for IP, and keep future invention write-ups out of public repositories until that's decided.

## 1. What irl.ing is

A six-second social video app for any phone or desktop (originally planned Android first; widened on 7 Nov 2026). You hold to record, let go to pause, and keep going. Loops play for friends you've accepted; there are no filters, and feeds end. The design goal throughout is *tiny, honest and resilient*:

- loops small enough for one bar of signal;
- everything added on playback declared and bounded;
- files that survive damage, truncation and relays.

## 2. Capture: Hold-to-Loop (Live, 2 Nov 2026)

- **Recording.** One camera stream is recorded while the button or the picture is held, up to 6.0 s in total across any number of takes.
- **Frames.** A centre-square crop is captured at 30 fps as BT.709 limited-range I420, 360² by default and 288² on low-memory phones.
- **Timestamps** follow recorded time, not wall time, so takes join without gaps.
- **Sound** is recorded separately as Opus at 24 kbit/s.
- **The raw clip** (MediaRecorder) stays on the phone for comparison.
- **Pointer handling:** a late "capture lost" event from an earlier hold is ignored while the current hold still owns the pointer.

Code: `src/loops/loop-recorder.js`, `src/loops/loops-app.js`.

## 3. Encoding on the phone: Featherweight (Live, 2 Nov 2026)

- **Codec.** The browser's WebCodecs encoder, choosing AV1 (`av01.0.04M.08`) when the phone can both encode and decode it, then VP9, then H.264.
- **Temporal layers.** Two layers (`L1T2`) where supported.
- **Keyframes.** A closed GOP every 60 frames (2 s).
- **Hitting a byte budget** (50, 100 or 200 KB): one pass at the nominal bitrate, plus one corrective pass if the size missed by more than 10%.
- **Self-measurement.** The result is decoded once on the phone to measure luma PSNR against the captured frames.
- **True Grain parameters.** The same pass estimates residual strength in 8 brightness bands from flat 8×8 blocks, plus its lag-1 spatial correlation.

Measured on a 6 s, 288² crop of the Xiph *foreman* clip:

| Method | Size | Luma PSNR (PSNR-Y) |
| --- | --- | --- |
| Phone-style real-time AV1 | about 108 KB | 33.7 dB |
| Offline AV1 | 28 KB | 30.4 dB |
| v1 "dots" codec (retired) | 206 KB | 22.7 dB |

The comparison retired the v1 dots codec in favour of AV1 (`docs/compression-research.md`, `scripts/bench/rd-bench.sh`).

Code: `src/loops/loop-encoder.js`, `src/loops/grain.js`.

## 4. The loop file: Lifeboats, Lighten Up, Real Seal, Cosmic Courtesy (Live, 2 Nov 2026)

`.irl` v2 is a list of independent, checksummed chunks:

```
file  = "IRL2" u8 version u8[3] reserved
chunk = "IRLC" type[4] u32 length payload u32 crc32(type, length, payload)
```

1. **Lifeboats.** Each 2-second GOP and temporal layer is its own chunk.
   - A chunk whose CRC fails is skipped; its 2 seconds hold the last good frame.
   - A corrupted length is survived by scanning for the next `IRLC` sync word.
2. **Cosmic Courtesy (priority order).** Chunks are written in this order: description, signature, base-layer video for every GOP, sound, enhancement-layer video. A file cut short anywhere after the base layer still plays the whole six seconds at 15 fps.
3. **Lighten Up (relay trimming).** A relay can drop the enhancement-layer chunks by copying the others verbatim. It needs no decoding and no re-signing, and the file shrinks by about 46% on the sample.
4. **Real Seal (per-chunk signature manifest).** A `SIGN` chunk holds:
   - an Ed25519 public key;
   - the SHA-256 of every other chunk's type and payload;
   - a signature over all of that.

   The device key is non-extractable and kept in IndexedDB. Because each chunk is signed individually, a trimmed, damaged or truncated file still verifies chunk by chunk ("4 of 7 signed parts present, all authentic"). A chunk altered with a recomputed CRC is caught as unsigned. The loop's ID is the SHA-256 of the manifest.

Code: `src/loops/container.js`. Tests: `tests/container.test.js`. Spec: `docs/loops-v2.md`.

**Novelty claimed (to be assessed):** the combination of an independently signed per-chunk manifest with priority-ordered, sync-marked chunks, so that relays can trim, truncate or lose chunks and recipients can still verify each surviving chunk, without re-signing, for short social video.

## 5. Playback: Glow-Up, True Grain, Honest Zoom, Smart Pixels (Live, 2 Nov 2026)

The decoded frames go through a WebGL2 pipeline, run in YUV:

1. **EASU** edge-adaptive 2× upscale of luma (a GLSL port of AMD FidelityFX FSR 1, MIT).
2. **RCAS** sharpening with its noise guard.
3. **True Grain:** a deterministic 256² template scaled per brightness band.
4. **The Honest Zoom lock** on luma and on 2× bilinear colour.
5. **Display:** YUV→RGB, scaled to the screen, with ±½ code-value dither.

**Honest Zoom.** After any upscaler, an integer pass adjusts every 2×2 block of the 2× output so its four values sum to exactly 4 × the received pixel. Shrinking the output back down returns the received frame bit for bit.

- **Clamping.** The block algorithm spreads the difference over the values that can still move, with a rotating remainder. It repeats when values pin at 0 or 255, and always converges within four rounds.
- **Checking.** About once a second on playback, and on every exported frame, the zoomed planes are read back (packed four values per texel on the GPU) and verified block by block against the received frame.
- **Labelling.** The viewer is told when the guarantee is paused (smart-pixel styling, finishing off).

Measured on a real 720p talking-head clip (Xiph *KristenAndSara*), shrunk to 360², AV1-encoded at loop budgets, and upscaled back:

- Plain bicubic, Lanczos and EASU contradict 38–45% of sent blocks; locked, 0%.
- The lock *raises* luma PSNR by 0.2–0.4 dB for every method.
- EASU plus the lock is the best result: 31.62 dB at 100 KB per loop and 32.24 dB at 200 KB.

(`docs/honest-zoom.md`, `scripts/bench/honest-zoom-bench.mjs`.)

**Novelty claimed (to be assessed):** an exact integer consistency lock applied after an arbitrary upscaler, verified against cryptographically signed source frames on the viewing device, with the guarantee and its pauses reported to the viewer. Prior art for consistency constraints includes iterative back-projection (Irani & Peleg, 1991) and the consistency-enforcing module of *Explorable Super-Resolution* (Bahat & Michaeli, CVPR 2020). Base-plus-enhancement coding appears in MPEG-5 LCEVC, and bounded-error coding in JPEG-LS near-lossless mode.

**Smart Pixels** is a playback style: oriented, overlapping splats sample the received frame and lean along its edges, flying in from scattered positions so that each loop assembles itself. It is labelled as a style, never as the faithful picture.

Code: `src/loops/finish-gl.js`, `src/loops/honest-zoom.js`, `src/loops/loop-player.js`.

## 6. Saving and sharing outside irl.ing (Live, 2 Nov 2026)

**Save video** and **Share video** produce an ordinary MP4 (H.264 first, then VP9 or AV1) at 2× the loop's size, with AAC or Opus sound.

- **Lifelike look:** the encoder receives the verified Honest Zoom I420 frames directly ("180/180 frames verified before encoding" on the sample).
- **Smart-pixel look:** the styled canvas is recorded instead, and labelled as not verified.
- **Format choice:** `.irl` remains the format loops travel in between irl.ing users.

Code: `src/loops/export-video.js` (Mediabunny, MPL-2.0).

## 7. Accounts (Live, 6 Nov 2026)

Passkey-first and password-free, on Better Auth 1.7.10 with Neon Postgres, as one Vercel function. Signup runs in this order:

1. **Claim.** The person claims an @name with their birth month and year. The server enforces age 13+, the handle rules and reserved names, then holds the claim for 15 minutes.
2. **Passkey.** A passkey is registered against the claim, and the server requires user verification.
3. **One transaction.** Only then are the account, the passkey and the first session created together.

Privacy defaults:

- Only the month the person turns 18 is stored, never the birthday.
- Under-18s start friends-only and can't be found.
- Deletion requires a fresh session and typing the @name.
- Rate limits are stored in the database, so they hold across servers.

Code: `src/server/auth.js`, `src/accounts/`. Spec: `docs/accounts.md`. End-to-end test with real WebAuthn ceremonies: `tests/accounts-browser.mjs`.

## 8. Friends, invites and blocks (Built, not yet switched on)

- **Mutual friendship.** One row per pair, stored smaller id first, as pending or accepted.
- **Invites.** A code turns into a link and a QR code. Whoever joins through it becomes the inviter's friend; codes expire and have a use limit.
- **Exact @name lookup**, which doesn't return teen accounts.
- **Blocks** override friendship and requests.
- **Onboarding is invite-first:**
  1. "@friend invited you", with their latest loop playing.
  2. Claim your @name.
  3. Save the passkey.
  4. You're friends automatically.
  5. Make your first loop.
  6. "You're caught up."

Schema: `db/social.sql`.

## 9. Loop storage (Built, not yet switched on)

- **Storage:** private Cloudflare R2. Objects are keyed by loop ID: the `.irl` file plus three JPEG still frames.
- **Upload:** through irl.ing's server, in one request of at most 2 MB. The first design used signed PUT links straight to R2. That was dropped on 6 Nov 2026 because R2 can't cap a signed link's upload size.
- **Verify before storing:** the server parses the file and verifies the Real Seal. It checks size and duration, records the signing key against the account (trust on first use) and runs safety review. Only then is anything written to storage.
- **Playback:** a signed GET link, issued per loop to the owner and accepted friends only.
- **Deletion:** deleting a loop or an account deletes its objects. The exception is child-safety escalations, which are preserved as the law requires.

## 10. Safety review (Built, not yet switched on)

- **The reviewer:** Claude (Anthropic API, `claude-opus-5-5`, structured JSON output, refusal fallbacks) reviews each loop's three still frames against the community rules.
- **Deciding:** irl.ing's policy maps the returned categories to show, hold or block. The stricter of the policy and the model wins, and teen thresholds are stricter.
- **Failing closed:** refusals, errors and unreadable output hold the loop.
- **People:** reports, a human review queue, strikes and an audit log complete it.

Full program: [user safety](user-safety.md). Endpoints and setup: [the backend](social.md).

## 11. Timeline

| Date | Milestone | Commit |
| --- | --- | --- |
| 7 Oct 2026 | Sticker studio prototype (since removed) | `361250b` |
| 2 Nov 2026 | Loops lab v1 (dots codec, later retired) | `b05f09d` |
| 2 Nov 2026 | Equal-bytes benchmark; compression findings | `2e7b16d` |
| 2 Nov 2026 | Loops v2: AV1, Lifeboats, Real Seal, Glow-Up, True Grain, Smart Pixels | `2618c5b` |
| 2 Nov 2026 | Landing page; studio removed | `7c84db6` |
| 2 Nov 2026 | Lexicon and positioning | `80998e3`, `1cdcc30` |
| 2 Nov 2026 | MP4 save and share | `ebb214f` |
| 2 Nov 2026 | Honest Zoom | `a2927d2` |
| 2 Nov 2026 | Passkey-first accounts | `9f2de8e` |
| 6 Nov 2026 | Accounts live on irl.ing | `645f4d8` |
| 6 Nov 2026 | Social, storage and safety designs recorded (this document; [user safety](user-safety.md)) | `aa48670` |
| 6 Nov 2026 | Friends, invites, blocks, verified loop sharing, Claude safety review, reports and review queue built ([the backend](social.md)) | `9781285` |
| 6 Nov 2026 | New identity: the take mark, drawn wordmark, Rec and Highlighter ([brand](brand.md)) | `2c697e3` |
| 7 Nov 2026 | Positioning widened from Android first to any phone or desktop | this commit |
