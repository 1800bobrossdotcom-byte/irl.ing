// All brush coordinates and diameters use source-image pixels. Pan offsets use
// viewport pixels, after the fitted image has been enlarged by zoom.
export function viewportTransform(
  width,
  height,
  viewWidth,
  viewHeight,
  zoom = 1,
  pan = { x: 0, y: 0 },
) {
  if (
    ![width, height, viewWidth, viewHeight, zoom].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new RangeError("Image, viewport, and zoom must have positive dimensions.");
  const scale = Math.min(viewWidth / width, viewHeight / height) * zoom;
  return {
    scale,
    x: (viewWidth - width * scale) / 2 + pan.x,
    y: (viewHeight - height * scale) / 2 + pan.y,
  };
}

export function viewToSource(p, transform, width, height) {
  const x = (p.x - transform.x) / transform.scale;
  const y = (p.y - transform.y) / transform.scale;
  // Captured pointer events can occur outside the photo. Reject them instead
  // of collapsing them onto its edge and accidentally erasing an edge strip.
  return Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height
    ? { x, y }
    : null;
}

export function sourceToView(p, transform) {
  return {
    x: p.x * transform.scale + transform.x,
    y: p.y * transform.scale + transform.y,
  };
}

export function strokeDabs(from, to, diameter) {
  if (!from) return [{ x: to.x, y: to.y }];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const spacing = Math.max(0.5, diameter * 0.12);
  const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
  // The previous event already stamped `from`; omitting it keeps soft strokes
  // from darkening twice at every pointer-event boundary.
  return Array.from({ length: count }, (_, i) => {
    if (i === count - 1) return { x: to.x, y: to.y };
    const t = (i + 1) / count;
    return { x: from.x + dx * t, y: from.y + dy * t };
  });
}

export function brushCoverage(distance, radius, hardness) {
  if (!(radius > 0) || !Number.isFinite(distance)) return 0;
  const d = Math.max(0, distance);
  if (d >= radius) return 0;
  const inner = radius * Math.max(0, Math.min(1, hardness));
  if (d <= inner) return 1;
  const t = (d - inner) / (radius - inner);
  // Smoothstep has zero slope at both ends: no visible ring where the opaque
  // core meets the soft edge, and no jump where coverage reaches zero.
  return 1 - t * t * (3 - 2 * t);
}
