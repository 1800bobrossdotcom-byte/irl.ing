# Edge refinement and roto editing

The editor uses a local segmentation model for the first mask, then automatically finishes fine boundaries in a separate worker. Further source-guided refinement is available under More tools. This is custom application engineering built on established matting methods, not a claim of a new mathematical invention or Photoshop parity.

## Processing

1. U²-Net predicts a 320×320 subject mask. Its enlarged result supplies subject identity, rather than a hard threshold that would discard fractional edge coverage.
2. A CPU worker area-averages RGB and mask values onto a work grid capped at 640 pixels on the longest edge. Local RGB covariance yields a regularized linear guided-filter model: `q = aᵀI + b`. Averaged coefficients are interpolated, then evaluated against the original imported photo’s RGB pixels. This retains color boundaries that a luminance-only filter misses.
3. Near uncertain mask boundaries, sufficiently supported local foreground and background colors provide a second alpha estimate: `α = ((I − B) · (F − B)) / ‖F − B‖²`. Color-line residual, foreground/background support, and color separation gate this estimate. Missing or ambiguous color evidence falls back to the guided result. Global refinement cannot increase coverage where the prior alpha is at most 5/255; elsewhere upward growth is capped to `p + 0.25√p`. An explicitly painted region permits recovery within that area; an entirely empty mask still remains empty. This guard limits background texture that could otherwise resemble hair. Deep foreground/background remain protected.
4. Optional color cleanup estimates foreground color from `F = (I − (1 − α)B) / α`. Confidence and correction limits reduce instability. It is off by default and does not reinterpret preexisting source transparency as photographic background contamination.
5. A painted refinement region locks every unpainted alpha and color pixel. Existing cleaned colors remain intact outside further corrections. Original photos are retained separately for comparison; cleaned RGB and mask are saved together with the cutout.

The guided-filter basis follows He, Sun, and Tang, *Guided Image Filtering* (ECCV 2010), and He and Sun, *Fast Guided Filter* ([2015 paper](https://arxiv.org/abs/1505.00996)). Foreground/background mixture projection follows the standard compositing equation. The confidence guards and editor integration are implemented here without extra image-processing dependencies.

## Editor behavior

Brush sizes are original-image pixels, with a smooth hardness falloff and spaced dabs along fast strokes. A common transform maps trace points, brush positions, and object picks between image and viewport coordinates. Pointer events outside the photo are ignored. Separate light/dark/checker backgrounds and the brush cursor are display layers and never enter exported pixels.

Zoom buttons, anchored wheel zoom, hand panning, and two-finger pinch support detailed inspection. A second finger rolls back provisional edits before starting a pinch; Undo/Redo history is also preserved. Selection uses the full-resolution alpha array, retaining fractional coverage rather than resizing a selected mask through the viewport. A traced outline can become a brush-editable mask without closing the editor.

Alpha-only snapshots reduce the basic undo cost fourfold compared with RGBA snapshots. History uses an approximately 24 MB budget, counting retained color canvases. Edge workers are cancellable and released after completion. Fresh segmentation results receive one automatic finishing pass; Keep or Touch up immediately cancels an unfinished pass, and stale callbacks cannot overwrite saved results or brush edits. Further refinement is explicit, so manual strokes remain authoritative.

The default editor shows a large preview, Keep, and Touch up. Touch up reveals Erase/Restore, undo/redo and brush size; More tools holds tracing, selection, refinement settings and inspection controls. A photo can proceed as is even if segmentation fails. Cutout-engine warmup begins only after capture intent and respects save-data/hidden-page state. A verified session stays available for repeat photos, bounded by a 45-second idle timeout (15 seconds on devices reporting at most 2 GB memory), and releases immediately on hiding/cancellation.

## Evidence and limits

The numerical fixtures generate known coverage and independently create an area-averaged, bilinearly enlarged coarse baseline. At maximum refinement strength:

| Constructed fixture | Coarse baseline | Refined | Interpretation |
| --- | ---: | ---: | --- |
| Curved thin-strand scene, mask MAE /255 | 11.4845 | 8.1243 | 29.3% less error |
| Strand pixels only, MAE /255 | 114.09 | 108.2769 | Better retention; substantial missing coverage remains |
| Background pixels, MAE /255 | 7.8118 | 4.7290 | Lower background leakage |
| Equal-luminance color boundary, MAE /255 | 6.5156 | 1.6797 | RGB guidance retains chromatic evidence |

Optional cleanup reduced compositing color error by 84.9% on a known mixed-color edge at maximum cleanup. These are synthetic measurements, not scores on real hair photos or comparisons with commercial software. The UI defaults to 80% detail and cleanup off, so these maximum-strength figures do not describe every default result.

A visual comparison using the official U²-Net horse test photograph showed modest improvement in tail gaps and strand boundaries. An earlier version brought back grass wisps; the expansion guard removes that regression in this example. Existing yellow/green fringes remain, and cleanup at 40% contributes little against this textured background. There is no known-alpha reference for this photo.

A 1600×1200 Node CPU benchmark took approximately 522 ms with cleanup enabled, with about 48 MB of typed-array buffers. Actual phone speed and browser memory differ; the worker keeps the interface responsive. Imported photos still have a maximum 1600-pixel edge. The clean PNG preserves that imported resolution and transparency; it does not reconstruct original camera resolution, invent missing strands, or create a print-production contour.

Similar foreground/background colors, complex mixed colors, motion blur, and subjects absent from the initial mask remain difficult. Check both light and dark backgrounds, adjust reach/detail, restrict refinement to a painted area, and finish with brushes. Undo preserves a comparison with the prior result.

Run `npm test` for numerical and persistence validation. Run `STUDIO_URL=http://127.0.0.1:3003 python3 -m unittest discover -s tests -p 'test_*.py' -v` against the production preview for browser workflows. Mobile checks use Chromium emulation; hardware phones and Safari remain unverified.
