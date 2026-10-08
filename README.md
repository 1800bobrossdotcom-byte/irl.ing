# irl.ing

**Less scrolling. More irl’ing.**

Irl’ing is a verb: being present, seeing what's around you, and doing something with it. The mobile-friendly studio turns a photo into reusable artwork for stickers, T-shirts, and sweatshirts. Its identity is an open viewfinder with an outward arrow: notice a moment, then bring it into real life.

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

## On a phone

Open irl.ing and tap **Use a photo** or **Take a photo** at the top of the page. The editor finds the subject automatically, shows the first usable result immediately, and offers **Keep this bit** or **Touch up**. Conservative edge finishing runs in the background without blocking either action. Touch up opens Erase/Restore and a brush size; detailed controls are under **More tools**. **Try an example** uses the same flow without requiring a file. After Keep, tap **Make it yours**, choose Sticker, T-shirt, or Sweatshirt, then select size and border. Photo import errors appear in the photo dialog as well as on the page.

HEIC/HEIF inputs are accepted when the browser can decode them natively; otherwise an explicit message asks for a JPG/PNG or a new camera photo. No HEIC conversion service is used. These workflows have been exercised with mobile Chromium emulation, not a physical phone. Safari/WebKit verification is pending because the cloud network blocked the test-browser download.

## What works

- Local photo/camera import, with an automatic U²-Net background-removal model running in a Web Worker through ONNX Runtime Web. First use loads roughly 17 MB of uncompressed model/runtime resources from this same site. Photos do not leave the device.
- Automatic source-guided edge finishing on fresh cutouts, with manual refinement, optional halo cleanup and painted-area locks under More tools. RGB detail from the imported photo improves uncertain mask boundaries; mask edits remain reversible.
- Zoom/pinch/hand inspection, image-pixel soft brushes with hardness, undo/redo, light/dark/checker backgrounds, and full-resolution tap-to-keep selection. Traced outlines can become brush-editable masks without closing the editor. Connected or overlapping objects need manual refinement.
- Precise contour-following white outlines, die-cut/circle/oval sticker previews and centered T-shirt/sweatshirt front-print mockups. Sticker finish and price/quantity/checkout controls remain separate from garments, which support artwork downloads.
- Browser-local IndexedDB storage for images, original sources, masks and product/size/border settings. Legacy localStorage moments migrate automatically, with the old copy retained until migration commits. There is no arbitrary 12-moment limit; device quotas still apply.
- Reopening saved masks and cleaned colors, responsive layouts, separate preview and transparent artwork downloads. Artwork exports retain available source detail up to the 300-DPI print target, with actual physical-density metadata and no upscaling of small photos. Finish effects and garment illustrations stay in preview files. See [artwork geometry and output](docs/artwork-output.md).

Clear, distinct foreground subjects work best. The compact model is a useful first cut, not a guarantee of hair-perfect masks or arbitrary object recognition. The user can keep the photo as is, retry, or use manual editing when loading or execution fails. The verified model starts loading after photo-picker intent and stays initialized briefly for another photo: 45 seconds idle, 15 seconds on devices reporting 2 GB RAM or less. Hidden pages and explicit cancellation release it immediately; each edge-finishing worker is released after completion. Warmup respects the browser’s save-data setting. The undo history has a roughly 24 MB pixel budget.

A local Chromium check at a 390×844 viewport measured about 2.57 seconds to the first usable cutout and 1.90 / 1.79 seconds for subsequent photos sharing the initialized engine. These are desktop CPU measurements with a phone viewport, not hardware-phone or network guarantees. First use still needs to download and initialize the local tool.

## Validate

```sh
npm test
npm run build
# With the production server running on port 3003:
STUDIO_URL=http://127.0.0.1:3003 python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Numerical tests cover known-alpha strands, chromatic boundaries, halo cleanup, region locks, source transparency, brush/viewport behavior and persistence validation. Chromium browser workflows cover real inference, editor gestures and history, saved edits, migration, import/model/storage failures, tracing/export, responsive layouts and demo checkout. Browser tests need Python Playwright, Pillow, and Chromium, available in this cloud environment; use `CHROMIUM_PATH` to override `/usr/bin/chromium`. See [edge refinement math and evidence](docs/edge-refinement.md) for methods, quantitative synthetic results, and limits.

The production build checks the bundled model's SHA-256. The worker verifies it again before inference. Model provenance and licenses are in [the third-party notices](public/third-party-notices.txt).

## Product boundaries

Saved moments stay in this browser, not a cloud account; browser-data clearing removes them. Imports are limited to 20 MB, a 2400-pixel edge and four megapixels; devices reporting at most 2 GB RAM use 1600 pixels and two megapixels. Existing saved photos retain their stored dimensions. Mobile camera support depends on the device's native image picker.

The artwork PNG contains the graphic and optional white border at its available resolution, with physical-size metadata; the preview PNG contains display effects and any garment mockup. The editor also offers a bare cutout PNG. These are not manufacturing proofs, vector cutting contours or garment underbase separations. Garment mockups are illustrations rather than manufacturer templates. Sticker prices, delivery estimates and checkout are still demos; garments have no checkout. No payment is collected and no order reaches a printer. Real fulfillment requires provider selection, server-owned quotes, production artwork validation, payment integration and order reconciliation. See [the technical roadmap](docs/prototype.md).
