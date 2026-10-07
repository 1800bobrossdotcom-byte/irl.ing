# Irl’ing: prototype decisions and next slice

## The product judgment

The pasted proposal's most useful insight is the interaction that begins before artwork exists: a person notices something, selects the bit they care about, and turns it into a physical keepsake. The prototype makes that sequence testable. It doesn't independently verify the proposal's market sizing, competitor descriptions, model capabilities or supplier pricing.

The user's brand direction gives this a broader frame: **irl’ing is the act of being, seeing and doing in real life.** The studio is the first activity. “My moments” stores the things people stopped to notice, and “Start irl’ing” leads into making a physical keepsake. The orange flower mark and warm, tactile studio keep the product grounded in physical things.

## Six interaction states

1. **Notice:** sample objects, local upload or the device camera picker.
2. **Select:** whole-image or manual tap/drag outline with undo and clear.
3. **Make:** live sticker proof, shape, finish, size, border and quantity.
4. **Keep:** a browser-local moment collection and reusable cutouts.
5. **Review:** illustrative landed price, configuration summary and demo delivery estimate.
6. **Finish:** explicit demo completion with zero charged and no shipment.

These states use one responsive page with dialogs so a person can step back without losing their current configuration. Inputs and pricing stay deterministic. There are no fake loading delays, accounts, payment forms or requests to real suppliers.

## What to learn first

Watch a few people use a photo they already care about. Can they tell what to select, get a sticker they like, and understand the price without explanation? Does “irl’ing” naturally describe what they're doing? Do they return to a saved moment? Does a person want to order their own sticker once a believable production proof is shown?

Manual tracing is deliberately the biggest fidelity gap. It tests the rest of the journey but cannot validate the proposal's instant object-selection promise. The next meaningful technical slice is a real segmentation provider behind an upload API, followed by a real printer proof and one paid test order. Adding more product categories won't resolve those questions.

## Integration boundary for a real pilot

The current app has no server and must not receive provider or payment secrets. A production service would own the following workflow:

```text
Photo → temporary private asset → segmentation job → selected object
     → artwork validation / proof → expiring quote → payment
     → approved supplier order → production / tracking
```

A small API could expose:

| Operation                   | Responsibility                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /assets`              | Validate image size and format, strip metadata, store privately, return asset ID and retention information.                                      |
| `POST /assets/:id/segments` | Submit click/box prompts to a segmentation provider; return candidate masks associated with that asset.                                          |
| `POST /artworks`            | Preserve the original and chosen mask; derive transparent artwork, validated contour, bleed, margins and proof revision.                         |
| `POST /quotes`              | Validate the production spec and destination; request landed price and ETA from capable providers; return quote ID, expiry and artwork revision. |
| `POST /checkout-sessions`   | Bind the server's quote, artwork revision, tax and currency to a payment session; never trust a browser total.                                   |
| Payment webhook             | Verify the event signature and payment state; create exactly one order using idempotency keys.                                                   |
| Supplier adapter / webhook  | Submit only the approved proof, persist supplier references, reconcile retries and surface real production/tracking states.                      |

Store source assets and proofs in private object storage, and artwork revisions, quotes, payments and fulfillment state in a relational database. Use short-lived signed links for controlled supplier access. Define a retention/deletion policy before sending personal photos to a model provider. Never infer payment or shipment success from a client-side return URL.

## Supplier selection

Start with two explicit provider adapters, a shared capability model and a normalized landed quote. Filter by shape, material, dimensions, minimum quantity, destination and capacity. Require quality and deadline thresholds before comparing prices. For reorders, prefer the previous successful provider unless it cannot fulfill the order. Keep taxes and shipping in the normalized quote, and require renewed approval if the quote or proof changes.

The prototype's `getQuote()` compares two invented price curves synchronously. It has no real provider integration or availability signals. Its delivery text is intentionally labeled as a demo. Live integrations need currency and integer-cent arithmetic, quote expiry, provider timeouts, explicit unavailable states and protection against duplicate order submission.

## Artwork gate before taking money

A canvas preview does not establish manufacturability. The pilot needs resolution checks at the selected physical size, supported color handling, bleed and safe margin generation, contour simplification, minimum-width/island rules, a printer-specific export, and a customer-approved proof. Holographic material also needs a white-ink layer decision; a rainbow screen overlay cannot replace that production specification.

Keep this gate and the final order flow narrow enough to test with one sticker format and one reliable provider before expanding the assortment.
