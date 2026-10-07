# irl.ing

**Less scrolling. More irl’ing.**

_Irl’ing_ is a verb: being present, seeing what's around you, and doing something with it. This prototype turns a noticed moment into a custom sticker. Stickers are the first physical experience, not the limit of the brand.

## Run

The app is plain HTML, CSS and JavaScript. No build, API keys, account or backend is needed.

```sh
cd /workspace/irl.ing
npm install --no-save --package-lock=false --no-audit --no-fund --cache /workspace/.npm-cache serve@14.2.6
NO_UPDATE_CHECK=1 npm_config_cache=/workspace/.npm-cache npm run dev
```

The development server uses port 3001. For another port, use `PORT=3002 NO_UPDATE_CHECK=1 npm start`. Open the served site in a browser available in your development environment. No deployment is included.

## Try the prototype

1. Start with one of three original illustrated sample objects, or choose **Your photo**. On supported mobile devices, **Take a photo** opens the native camera picker.
2. Keep the whole image or trace around an object by tapping or dragging. Undo and clear let you revise the outline before applying it.
3. Try die-cut, circle and oval shapes; matte, glossy and holographic finishes; 2–4 inch sizes; 10–100 stickers; and a white border. The preview and illustrative price respond immediately.
4. Save a moment with the heart, then reopen it through **My moments**. Up to 12 objects persist in this browser's local storage. Remove them from the collection to clear those saved copies.
5. Download a transparent PNG preview, or choose **Start irl’ing** to complete an explicitly labeled demo checkout. No payment, address or manufacturing request is collected or sent.

Photos are decoded and processed locally. Imported images are resized to a maximum 1600-pixel edge for this prototype. Transparency is retained. A saved object includes its source image so it can be edited again. Private browsing, cleared browser data and storage quotas can prevent persistence; failed saves show an error without claiming success. Large photos may exhaust local storage before the 12-item limit.

## Validate

The cloud environment has Python Playwright and Chromium available. With the server running:

```sh
python3 tests/test_studio.py
```

The five browser tests cover configuration and quote updates, demo checkout, collection persistence and removal, upload/trace/undo/export, invalid files and storage failure, and responsive layouts. `STUDIO_URL` and `CHROMIUM_PATH` can override the test defaults. These are prototype tests, not manufacturing or payment integration tests.

## Current boundaries

- Sample objects are original SVG illustrations. They do not demonstrate AI segmentation.
- Uploaded photo cutouts use a manual polygon mask. Automatic object proposals, edge refinement and segmentation are future integrations.
- Prices and two internal supplier curves are fictional. Delivery estimates are illustrative, US-only, and not live promises. There is no tax calculation, payment processing, shipping or fulfillment.
- Finishes are visual approximations. The downloadable PNG is a preview, not a printer-ready proof or cut path. Preview rendering is capped at 1000 pixels and is not a 300-DPI production workflow.
- There is no cross-device account, analytics, service worker, PWA installation flow, public sharing or marketplace.
- Mobile camera capture depends on the device and browser. It uses the system file/camera picker rather than a live camera stream.

See [the product and integration notes](docs/prototype.md) for the next implementation slice.
