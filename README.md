# irl.ing

**Less scrolling. More irl’ing.**

Irl’ing is a verb: being present, seeing what's around you, and doing something with it. The mobile-friendly studio turns a photo into a reusable sticker cutout. Its identity is an open viewfinder with an outward arrow: notice a moment, then bring it into real life.

## Run

Node.js 22.12+ or 24 is required. This environment uses Node 24.

```sh
cd /workspace/irl.ing
npm ci --cache /workspace/.npm-cache
npm run dev
```

The development server uses port 3001. To exercise the production build:

```sh
npm run build
PORT=3003 npm start
```

Vercel deploys `master`. `vercel.json` selects Vite, `npm run build`, and `dist/`. Commit the lockfile with dependency changes. No provider credentials, paid APIs or external photo storage are needed for the current release.

## What works

- Local photo/camera import, with an automatic U²-Net background-removal model running in a Web Worker through ONNX Runtime Web. First use loads roughly 17 MB of uncompressed model/runtime resources from this same site. Photos do not leave the device.
- Manual tracing, erase/restore brushes with undo, original-image comparison, and tap-to-keep selection for spatially separated subjects. Connected or overlapping objects need manual refinement.
- Die-cut/circle/oval previews, three finish previews, size, border and quantity controls, plus an explicitly illustrative price and demo checkout.
- Browser-local IndexedDB storage for images, original sources, masks and sticker settings. Legacy localStorage moments migrate automatically, with the old copy retained until migration commits. There is no arbitrary 12-moment limit; device quotas still apply.
- Reopening saved masks for further editing, responsive layouts and downloadable PNG previews.

Clear, distinct foreground subjects work best. The compact model is a useful first cut, not a guarantee of hair-perfect masks or arbitrary object recognition. The user can cancel inference, retry it, or use manual editing when loading or execution fails. Worker memory is released after inference; the undo history has a roughly 24 MB pixel budget.

## Validate

```sh
npm test
npm run build
# With the production server running on port 3003:
STUDIO_URL=http://127.0.0.1:3003 python3 tests/test_studio.py
```

Five numerical/storage-validation tests and eight Chromium browser workflows cover real model inference, brush/undo, saved masks/settings, migration, model-loading failure, invalid images, unavailable storage, tracing/export, responsive layouts and demo checkout. Python Playwright and Chromium are provided by the cloud environment; use `CHROMIUM_PATH` to override `/usr/bin/chromium`.

The production build checks the bundled model's SHA-256. The worker verifies it again before inference. Model provenance and licenses are in [the third-party notices](public/third-party-notices.txt).

## Product boundaries

Saved moments stay in this browser, not a cloud account; browser-data clearing removes them. Imports are limited to 20 MB and resized to a 1600-pixel maximum edge. Mobile camera support depends on the device's native image picker.

The downloaded PNG is a visual preview, not a manufacturing proof. Prices, delivery estimates and checkout are still demos. No payment is collected and no order reaches a printer. Real fulfillment requires provider selection, server-owned quotes, production artwork validation, payment integration and order reconciliation. See [the technical roadmap](docs/prototype.md).
