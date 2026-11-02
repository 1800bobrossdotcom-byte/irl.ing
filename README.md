# irl.ing

**Less scrolling. More irl’ing.**

Irl’ing is a verb: being present, seeing what’s around you, and doing something with it. irl.ing is a six-second social video app, inspired by Vine and built around feeds that end. You hold to record, let go to pause, and your moment loops for your friends. There are no filters. Then you put the phone down. Recording, loops and the tech below work today in the loops lab; profiles, friends and feeds come next, Android first.

## What’s here

- **`/`**: the landing page. It plays a live loop through the same on-phone finishing pipeline the lab uses, has a hold-to-record demo, sets out the network's principles, and ends with **the lexicon**, plain names for the tech (Hold-to-Loop, Featherweight, Lifeboats, Lighten Up, Real Seal, True Grain, Glow-Up, Smart Pixels, Mars Manners) and a demo of how a loop survives a bad link.
- **`/loops/`**: the loops lab, Android (Chrome) first.
  - **Encoding:** clips are encoded on the phone with its own AV1 encoder (VP9 or H.264 where AV1 isn't available) to a 50, 100 or 200 KB budget.
  - **Packaging:** each loop is cut into two-second, checksummed chunks and signed with a key that never leaves the phone.
  - **Playback:** loops are rebuilt lifelike with FSR 1 upscaling and sharpening, measured film grain and dithering, with an optional "smart pixels" look.
  - **No camera needed:** **Try the sample** works without one.

  See [little loops v2](docs/loops-v2.md).
- **`/preview/`**: an early static layout mock.

Nothing is uploaded: loops stay on the phone until someone shares the file. There are no accounts yet, and no server.

## Run

Node.js 22.12+ or 24 is required.

```sh
npm ci
npm run dev        # http://localhost:3001
```

Production build:

```sh
npm run build
PORT=3003 npm start
```

Vercel deploys `master`; `vercel.json` selects Vite, `npm run build` and `dist/`. Commit the lockfile with any dependency changes.

## Test

```sh
npm test
# With the production server running on port 3003:
STUDIO_URL=http://127.0.0.1:3003 node tests/landing-browser.mjs
STUDIO_URL=http://127.0.0.1:3003 node tests/loops-browser.mjs
```

Unit tests cover the loop container (damage, truncation, relay trimming, signatures and tampering), grain estimation and color conversion. The browser tests need Playwright and Chromium, which this cloud environment provides; set `CHROMIUM_PATH` to choose a browser. They use Chromium's fake camera and microphone at phone-sized viewports. Nothing has been verified on a physical Android phone yet.

## Research and benchmarks

- [Compression findings](docs/compression-research.md): requirements, a survey of NASA/JPL, CCSDS, NGA, AV1, FSR and Gaussian-splat work, and the plan.
- `scripts/bench/rd-bench.sh`: quality at equal bytes on a standard test clip (AV1, H.264 and the retired v1 dots codec). Needs ffmpeg.
- [The v1 dots format](docs/loops-dots.md): retired and kept as a benchmark baseline.

Third-party notices are in [`public/third-party-notices.txt`](public/third-party-notices.txt), served at `/third-party-notices.txt`.
