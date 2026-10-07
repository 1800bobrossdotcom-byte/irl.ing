import { keepConnectedSubject } from "./mask.js";
import { viewportTransform, viewToSource, sourceToView, strokeDabs, brushCoverage } from "./editor-math.js";

export function createEditor({ onApply, notify, loadImage, makeCanvas, trimCanvas }) {
  const $ = (selector) => document.querySelector(selector);
  const canvas = $("#editor-canvas"), dialog = $("#editor-dialog");
  const cutout = makeCanvas(1), maskCanvas = makeCanvas(1), focusCanvas = makeCanvas(1);
  let asset, image, colors = null, alpha, focus = null, width, height;
  let mode = "whole", points = [], history = [], future = [];
  let worker, timeout, generation = 0, busy = false, applying = false, compare = false;
  let zoom = 1, pan = { x: 0, y: 0 }, hand = false, dirty = true, focusDirty = true, frame;
  const pointers = new Map();
  let gesture = null, previousPoint = null, strokeBefore = null, traceBefore = 0;
  let strokeHistory = null, strokeFuture = null;

  function transform() { return viewportTransform(width, height, canvas.width, canvas.height, zoom, pan); }
  function setStatus(text, error = false) {
    $("#cutout-status").textContent = text;
    $("#cutout-status").classList.toggle("error", error);
  }
  function cancelInference(message) {
    generation++;
    clearTimeout(timeout);
    worker?.terminate();
    worker = null;
    busy = false;
    if (message) setStatus(message);
  }
  function stateCopy() { return { alpha: alpha.slice(), focus: focus?.slice() || null, colors }; }
  function restoreState(state) {
    alpha = state.alpha; focus = state.focus; colors = state.colors;
    dirty = focusDirty = true;
  }
  function boundHistory() {
    // Alpha-only snapshots; include retained color canvases in the memory budget.
    let bytes = 0;
    const seen = new Set();
    for (let i = history.length - 1; i >= 0; i--) {
      const s = history[i];
      bytes += s.alpha.byteLength + (s.focus?.byteLength || 0);
      if (s.colors && !seen.has(s.colors)) { bytes += width * height * 4; seen.add(s.colors); }
      if ((bytes > 24 * 1024 * 1024 && i < history.length - 1) || history.length - i > 15) {
        history.splice(0, i + 1); break;
      }
    }
  }
  function snapshot() { const state = stateCopy(); history.push(state); future = []; boundHistory(); return state; }
  function writeAlpha(target, values, tinted = false) {
    if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
    const ctx = target.getContext("2d"), pixels = ctx.createImageData(width, height);
    for (let i = 0; i < values.length; i++) {
      pixels.data[i * 4] = tinted ? 224 : 255;
      pixels.data[i * 4 + 1] = tinted ? 154 : 255;
      pixels.data[i * 4 + 2] = tinted ? 36 : 255;
      pixels.data[i * 4 + 3] = tinted ? Math.round(values[i] * .42) : values[i];
    }
    ctx.putImageData(pixels, 0, 0);
  }
  function maskedSource() {
    if (!dirty) return cutout;
    cutout.width = width; cutout.height = height;
    writeAlpha(maskCanvas, alpha);
    const ctx = cutout.getContext("2d");
    ctx.drawImage(colors || image, 0, 0, width, height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    dirty = false;
    return cutout;
  }
  function validTrace() {
    return points.length >= 3 && Math.abs(points.reduce((sum, p, i) => {
      const n = points[(i + 1) % points.length]; return sum + p.x * n.y - n.x * p.y;
    }, 0)) > 40;
  }
  function rasterizeOutline() {
    if (!validTrace()) return;
    const ctx = maskCanvas.getContext("2d");
    maskCanvas.width = width; maskCanvas.height = height;
    ctx.beginPath();
    points.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](p.x, p.y));
    ctx.closePath(); ctx.fillStyle = "white"; ctx.fill();
    const pixels = ctx.getImageData(0, 0, width, height).data;
    alpha = Uint8ClampedArray.from({ length: width * height }, (_, i) => pixels[i * 4 + 3]);
    colors = null; dirty = true;
  }
  function draw() {
    if (!image) return;
    const ctx = canvas.getContext("2d"), t = transform();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const whole = mode === "whole" || mode === "trace" || compare;
    ctx.drawImage(whole ? image : maskedSource(), t.x, t.y, width * t.scale, height * t.scale);
    if (focus && mode === "focus" && !compare) {
      if (focusDirty) { writeAlpha(focusCanvas, focus, true); focusDirty = false; }
      ctx.drawImage(focusCanvas, t.x, t.y, width * t.scale, height * t.scale);
    }
    if (mode === "trace" && points.length && !compare) {
      const outline = points.map(p => sourceToView(p, t));
      ctx.beginPath(); ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.moveTo(outline[0].x, outline[0].y);
      outline.forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = "rgba(28,36,23,.5)"; ctx.fill("evenodd");
      ctx.beginPath(); ctx.moveTo(outline[0].x, outline[0].y);
      outline.forEach(p => ctx.lineTo(p.x, p.y));
      if (points.length > 2) ctx.closePath();
      ctx.strokeStyle = "#d7ef71"; ctx.lineWidth = 2; ctx.stroke();
      for (const p of outline) { ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#d7ef71"; ctx.fill(); }
    }
    const labels = {
      whole: "Keep the whole image, or let us find its subject.",
      trace: "Tap or draw an outline. Use outline to refine it with brushes.",
      cutout: "Zoom into fine edges. Refine hair & edges uses your photo’s color to improve the mask.",
      erase: "Erase with a soft brush. The size is measured in original photo pixels.",
      restore: "Bring back detail from the original photo with a soft brush.",
      select: "Tap a separated object to keep it, including its original edge detail.",
      focus: "Paint the edges you want to refine, then tap Refine hair & edges. Unpainted areas stay unchanged.",
    };
    $("#editor-instructions").textContent = hand ? "Drag to move the photo. Pinch with two fingers to zoom." : labels[mode];
    for (const [id, target] of [["whole-image","whole"],["trace-image","trace"],["erase-mask","erase"],["restore-mask","restore"],["select-subject","select"],["focus-edges","focus"]]) {
      const b = $(`#${id}`); b.classList.toggle("selected", mode === target); b.setAttribute("aria-pressed", String(mode === target)); b.disabled = busy || applying;
    }
    $("#refine-tools").hidden = ["whole", "trace"].includes(mode);
    $("#edge-settings").hidden = ["whole", "trace"].includes(mode);
    $("#brush-control").hidden = !["erase", "restore", "focus"].includes(mode);
    $("#undo-point").disabled = busy || applying || (mode === "trace" ? !points.length : !history.length);
    $("#undo-point").textContent = mode === "trace" ? "Undo point" : "Undo";
    $("#redo-mask").disabled = busy || applying || !future.length || mode === "trace";
    $("#clear-points").hidden = mode !== "trace";
    $("#clear-points").disabled = !points.length || busy;
    $("#apply-outline").hidden = mode !== "trace";
    $("#apply-outline").disabled = !validTrace() || busy;
    $("#clear-focus").hidden = !focus;
    $("#clear-focus").disabled = busy;
    $("#use-cutout").disabled = busy || applying || (mode === "trace" && !validTrace());
    $("#download-cutout").disabled = busy || applying || mode === "trace";
    $("#auto-cutout").disabled = busy || applying;
    $("#auto-cutout").setAttribute("aria-busy", String(busy));
    $("#cancel-cutout").hidden = !busy;
    $("#refine-edges").disabled = busy || applying;
    $("#auto-cutout-label").textContent = busy ? "Working on your photo…" : "Remove background";
    $("#point-count").textContent = busy ? "Working on your device" : mode === "trace" ? `${points.length} outline points${points.length < 3 ? " · add at least 3" : ""}` : mode === "whole" ? "Whole image selected" : "Background removed · check the edges";
    $("#zoom-fit").textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}% · Fit`;
    $("#zoom-out").disabled = zoom <= 1;
    $("#zoom-in").disabled = zoom >= 8;
    $("#pan-image").setAttribute("aria-pressed", String(hand));
    $("#pan-image").classList.toggle("selected", hand);
    canvas.style.cursor = hand ? "grab" : ["erase", "restore", "focus", "trace", "select"].includes(mode) ? "crosshair" : "default";
  }
  function scheduleDraw() { if (!frame) frame = requestAnimationFrame(() => { frame = null; draw(); }); }
  function chooseMode(next) {
    if (busy) return;
    compare = false; $("#compare-original").checked = false;
    mode = next; hand = false; draw();
  }
  function viewPoint(event) {
    const r = canvas.getBoundingClientRect();
    return { x: (event.clientX - r.left) * canvas.width / r.width, y: (event.clientY - r.top) * canvas.height / r.height };
  }
  function updateCursor(event) {
    const cursor = $("#brush-cursor"), r = canvas.getBoundingClientRect(), viewport = $("#editor-viewport"), host = viewport.getBoundingClientRect();
    const p = viewPoint(event);
    cursor.hidden = busy || compare || hand || !["erase","restore","focus"].includes(mode) || !viewToSource(p, transform(), width, height);
    if (cursor.hidden) return;
    const diameter = Number($("#brush-size").value) * transform().scale * r.width / canvas.width;
    cursor.style.width = cursor.style.height = `${diameter}px`;
    cursor.style.left = `${event.clientX - host.left - viewport.clientLeft}px`; cursor.style.top = `${event.clientY - host.top - viewport.clientTop}px`;
  }
  function brush(p, pressure = 1) {
    const diameter = Number($("#brush-size").value), radius = diameter / 2;
    const hardness = Number($("#brush-hardness").value) / 100;
    if (mode === "focus" && !focus) focus = new Uint8ClampedArray(width * height);
    const target = mode === "focus" ? focus : alpha;
    for (const dab of strokeDabs(previousPoint, p, diameter)) {
      const left = Math.max(0, Math.floor(dab.x - radius)), right = Math.min(width - 1, Math.ceil(dab.x + radius));
      const top = Math.max(0, Math.floor(dab.y - radius)), bottom = Math.min(height - 1, Math.ceil(dab.y + radius));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        let coverage = 0;
        // Tiny circles need area sampling: a one-pixel brush between pixel
        // centers must still paint rather than disappearing through aliasing.
        if (diameter < 4) {
          for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++)
            coverage += brushCoverage(Math.hypot(x + (sx + .5) / 4 - dab.x, y + (sy + .5) / 4 - dab.y), radius, hardness) / 16;
        } else coverage = brushCoverage(Math.hypot(x + .5 - dab.x, y + .5 - dab.y), radius, hardness);
        coverage *= pressure;
        const i = y * width + x;
        target[i] = mode === "erase" ? Math.round(target[i] * (1 - coverage)) : Math.round(target[i] + (255 - target[i]) * coverage);
      }
    }
    previousPoint = p;
    if (mode === "focus") focusDirty = true; else dirty = true;
    scheduleDraw();
  }
  function beginStroke() {
    strokeHistory = history.slice(); strokeFuture = future.slice();
    strokeBefore = snapshot();
  }
  function resetStroke() { previousPoint = null; strokeBefore = null; strokeHistory = strokeFuture = null; }
  function rollbackStroke() {
    if (strokeBefore) {
      restoreState(strokeBefore); history = strokeHistory; future = strokeFuture;
    }
    if (mode === "trace") points.length = traceBefore;
    resetStroke();
  }
  function setZoom(value, anchor = { x: canvas.width / 2, y: canvas.height / 2 }) {
    const old = transform(), source = { x: (anchor.x - old.x) / old.scale, y: (anchor.y - old.y) / old.scale };
    zoom = Math.max(1, Math.min(8, value));
    const base = viewportTransform(width, height, canvas.width, canvas.height, zoom);
    pan = zoom === 1 ? { x: 0, y: 0 } : { x: anchor.x - base.x - source.x * base.scale, y: anchor.y - base.y - source.y * base.scale };
    draw();
  }
  function startPinch() {
    rollbackStroke();
    const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, t = transform();
    gesture = { type: "pinch", distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom, source: { x: (center.x - t.x) / t.scale, y: (center.y - t.y) / t.scale } };
    draw();
  }
  canvas.addEventListener("pointerdown", event => {
    if (event.button > 0 || busy || applying) return;
    event.preventDefault();
    const v = viewPoint(event); pointers.set(event.pointerId, v); canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2 || gesture?.type === "frozen") return;
    traceBefore = points.length;
    if (hand || compare) { gesture = { type: "pan", start: v, pan: { ...pan } }; return; }
    gesture = { type: "edit", id: event.pointerId };
    const p = viewToSource(v, transform(), width, height);
    if (!p) return;
    if (mode === "trace") { points.push(p); draw(); }
    else if (["erase","restore","focus"].includes(mode)) { beginStroke(); brush(p, event.pointerType === "pen" ? event.pressure || .5 : 1); }
    else if (mode === "select") {
      const selected = keepConnectedSubject(alpha, width, height, p.x, p.y);
      if (!selected) { setStatus("Tap on the object itself, or use Restore to bring it back."); return; }
      beginStroke(); alpha = selected; dirty = true;
      setStatus("Just this one. Undo brings the other objects back."); draw();
    }
    updateCursor(event);
  });
  canvas.addEventListener("pointermove", event => {
    updateCursor(event);
    if (!pointers.has(event.pointerId) || busy) return;
    const v = viewPoint(event); pointers.set(event.pointerId, v);
    if (gesture?.type === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoom = Math.max(1, Math.min(8, gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance));
      const base = viewportTransform(width, height, canvas.width, canvas.height, zoom);
      pan = zoom === 1 ? { x: 0, y: 0 } : { x: center.x - base.x - gesture.source.x * base.scale, y: center.y - base.y - gesture.source.y * base.scale };
      scheduleDraw(); return;
    }
    if (gesture?.type === "pan") { pan = { x: gesture.pan.x + v.x - gesture.start.x, y: gesture.pan.y + v.y - gesture.start.y }; scheduleDraw(); return; }
    if (gesture?.type !== "edit" || gesture.id !== event.pointerId || compare) return;
    const p = viewToSource(v, transform(), width, height);
    if (!p) { previousPoint = null; return; }
    if (mode === "trace") {
      const last = points.at(-1); if (last && Math.hypot(p.x - last.x, p.y - last.y) * transform().scale > 7) { points.push(p); scheduleDraw(); }
    } else if (["erase","restore","focus"].includes(mode) && strokeBefore) brush(p, event.pointerType === "pen" ? event.pressure || .5 : 1);
  });
  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    if (event.type === "pointercancel" && gesture?.type === "edit") rollbackStroke();
    pointers.delete(event.pointerId);
    if (pointers.size) gesture = { type: "frozen" }; else { gesture = null; resetStroke(); }
    draw();
  }
  for (const name of ["pointerup","pointercancel","lostpointercapture"]) canvas.addEventListener(name, endPointer);
  canvas.addEventListener("pointerleave", () => { $("#brush-cursor").hidden = true; });
  canvas.addEventListener("wheel", event => { event.preventDefault(); setZoom(zoom * Math.exp(-event.deltaY * .002), viewPoint(event)); }, { passive: false });

  async function runAutomatic() {
    if (!image || busy) return;
    cancelInference(); const version = generation; busy = true; setStatus("Preparing your photo…"); draw();
    const input = makeCanvas(320), ctx = input.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 320, 320); ctx.drawImage(image, 0, 0, 320, 320);
    const pixels = ctx.getImageData(0, 0, 320, 320).data;
    const fail = message => { if (version !== generation) return; cancelInference(); setStatus(message, true); draw(); };
    try {
      worker = new Worker(new URL("./cutout.worker.js", import.meta.url), { type: "module" });
      worker.onerror = () => fail("The cutout tool couldn’t start on this browser. You can still trace your object.");
      worker.onmessage = ({ data }) => {
        if (version !== generation) return;
        if (data.type === "status") { setStatus(data.message); return; }
        if (data.type === "error") { fail(data.message); return; }
        if (data.type !== "result") return;
        const small = makeCanvas(320), sctx = small.getContext("2d"), rgba = sctx.createImageData(320, 320);
        for (let i = 0; i < data.mask.length; i++) { rgba.data[i * 4] = rgba.data[i * 4 + 1] = rgba.data[i * 4 + 2] = 255; rgba.data[i * 4 + 3] = data.mask[i]; }
        sctx.putImageData(rgba, 0, 0); snapshot();
        maskCanvas.width = width; maskCanvas.height = height;
        const mctx = maskCanvas.getContext("2d"); mctx.imageSmoothingQuality = "high"; mctx.drawImage(small, 0, 0, width, height);
        const enlarged = mctx.getImageData(0, 0, width, height).data;
        alpha = Uint8ClampedArray.from({ length: width * height }, (_, i) => enlarged[i * 4 + 3]);
        colors = null; focus = null; dirty = focusDirty = true; mode = "cutout";
        cancelInference();
        setStatus("Your subject is ready. Zoom in, refine fine edges, then keep your favorite bit."); draw();
      };
      timeout = setTimeout(() => fail("That took too long on this device. Try again, or trace the outline yourself."), 90000);
      worker.postMessage({ pixels }, [pixels.buffer]);
    } catch { fail("Automatic cutout is unavailable here. You can still trace your object."); }
  }
  async function runRefinement() {
    if (!image || busy || ["whole","trace"].includes(mode)) return;
    cancelInference(); const version = generation, before = stateCopy(); busy = true;
    setStatus(focus ? "Refining the painted edges on your device…" : "Refining fine edges on your device…"); draw();
    const input = makeCanvas(width, height); input.getContext("2d").drawImage(image, 0, 0);
    const rgba = input.getContext("2d").getImageData(0, 0, width, height).data, mask = alpha.slice(), region = focus?.slice();
    const settings = { radius: Number($("#edge-radius").value), strength: Number($("#edge-strength").value) / 100, cleanup: Number($("#edge-cleanup").value) / 100 };
    const fail = message => { if (version !== generation) return; cancelInference(); setStatus(message, true); draw(); };
    try {
      worker = new Worker(new URL("./refine.worker.js", import.meta.url), { type: "module" });
      worker.onerror = () => fail("Edge refinement couldn’t finish. Your current mask is unchanged; try a smaller photo.");
      worker.onmessage = ({ data }) => {
        if (version !== generation) return;
        if (data.type === "error") { fail(data.message); return; }
        if (data.type !== "result") return;
        history.push(before); future = []; boundHistory(); alpha = data.alpha;
        if (settings.cleanup > 0) {
          // Analyze the original photo, but retain earlier color edits wherever
          // this pass makes no correction, especially outside a painted region.
          if (before.colors) {
            const previous = before.colors.getContext("2d").getImageData(0, 0, width, height).data;
            const original = input.getContext("2d").getImageData(0, 0, width, height).data;
            for (let i = 0; i < alpha.length; i++) {
              const offset = i * 4;
              const changed = data.rgba[offset] !== original[offset] || data.rgba[offset + 1] !== original[offset + 1] || data.rgba[offset + 2] !== original[offset + 2];
              const gate = before.focus ? before.focus[i] / 255 : 1;
              for (let c = 0; c < 3; c++) data.rgba[offset + c] = changed
                ? Math.round(previous[offset + c] * (1 - gate) + original[offset + c] * gate + data.rgba[offset + c] - original[offset + c])
                : previous[offset + c];
            }
          }
          colors = makeCanvas(width, height); colors.getContext("2d").putImageData(new ImageData(data.rgba, width, height), 0, 0);
        } else colors = before.colors;
        dirty = true; mode = "cutout"; cancelInference();
        setStatus("Edges refined. Check on light and dark backgrounds; Undo restores the previous result."); draw();
      };
      timeout = setTimeout(() => fail("Refinement took too long. Your mask is unchanged; try again or use the brushes."), 60000);
      const payload = { rgba, alpha: mask, width, height, ...settings, region };
      worker.postMessage(payload, [rgba.buffer, mask.buffer, ...(region ? [region.buffer] : [])]);
    } catch { fail("Edge refinement is unavailable here. Your current mask is unchanged."); }
  }
  $("#auto-cutout").onclick = runAutomatic;
  $("#refine-edges").onclick = runRefinement;
  $("#cancel-cutout").onclick = () => { cancelInference("Cancelled. Your previous mask is still here."); draw(); };
  for (const [id, next] of [["whole-image","whole"],["trace-image","trace"],["erase-mask","erase"],["restore-mask","restore"],["select-subject","select"],["focus-edges","focus"]]) $(`#${id}`).onclick = () => chooseMode(next);
  $("#undo-point").onclick = () => {
    if (busy) return;
    if (mode === "trace") points.pop();
    else if (history.length) { future.push(stateCopy()); restoreState(history.pop()); }
    draw();
  };
  $("#redo-mask").onclick = () => { if (busy || !future.length) return; history.push(stateCopy()); restoreState(future.pop()); boundHistory(); draw(); };
  $("#clear-points").onclick = () => { points = []; draw(); };
  $("#apply-outline").onclick = () => { if (!validTrace()) return; snapshot(); rasterizeOutline(); mode = "cutout"; setStatus("Outline ready. Refine or brush the edges before keeping it."); draw(); };
  $("#clear-focus").onclick = () => { if (busy) return; snapshot(); focus = null; focusDirty = true; draw(); };
  $("#compare-original").onchange = event => { compare = event.target.checked; draw(); };
  $("#brush-size").oninput = event => { $("#brush-value").textContent = `${event.target.value} px`; };
  $("#brush-hardness").oninput = event => { $("#hardness-value").textContent = `${event.target.value}%`; };
  $("#zoom-in").onclick = () => setZoom(zoom * 1.5);
  $("#zoom-out").onclick = () => setZoom(zoom / 1.5);
  $("#zoom-fit").onclick = () => { zoom = 1; pan = { x: 0, y: 0 }; draw(); };
  $("#pan-image").onclick = () => { hand = !hand; draw(); };
  $("#editor-background").onchange = event => { $("#editor-viewport").dataset.background = event.target.value; };
  $("#download-cutout").onclick = () => {
    try {
      let output;
      if (mode === "whole") { output = makeCanvas(width, height); output.getContext("2d").drawImage(image, 0, 0); }
      else output = maskedSource();
      const anchor = document.createElement("a"); anchor.href = trimCanvas(output).toDataURL("image/png"); anchor.download = "irling-clean-cutout.png"; anchor.click();
      notify("Clean transparent PNG downloaded at your imported photo’s resolution.");
    } catch (error) { setStatus(error.message, true); }
  };
  dialog.addEventListener("keydown", event => {
    if (["INPUT","SELECT","TEXTAREA"].includes(event.target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); $(event.shiftKey ? "#redo-mask" : "#undo-point").click(); }
    if (event.key === "+" || event.key === "=") $("#zoom-in").click();
    if (event.key === "-") $("#zoom-out").click();
  });
  dialog.addEventListener("close", () => { cancelInference(); pointers.clear(); gesture = null; resetStroke(); $("#brush-cursor").hidden = true; });
  $("#use-cutout").onclick = async () => {
    if (!asset || busy || applying || (mode === "trace" && !validTrace())) return;
    applying = true; draw();
    try {
      if (mode === "whole") { alpha.fill(255); colors = null; dirty = true; }
      if (mode === "trace") rasterizeOutline();
      const trimmed = trimCanvas(maskedSource());
      await onApply({ ...asset, id: crypto.randomUUID(), source: asset.source || asset.data, mask: maskCanvas.toDataURL("image/png"), colors: colors?.toDataURL("image/png") || undefined, data: trimmed.toDataURL("image/png"), sample: Boolean(asset.sample) });
      dialog.close(); notify("There it is. A little piece of your world.");
    } catch (error) { setStatus(error.message, true); }
    finally { applying = false; draw(); }
  };
  return {
    async open(next, { automatic = false } = {}) {
      cancelInference(); const version = generation;
      try {
        const loaded = await loadImage(next.source || next.data);
        if (version !== generation) return;
        image = loaded; asset = { ...next }; width = image.naturalWidth; height = image.naturalHeight;
        points = []; history = []; future = []; focus = null; colors = null; hand = false; zoom = 1; pan = { x: 0, y: 0 };
        pointers.clear(); gesture = null; resetStroke(); mode = next.mask ? "cutout" : "whole";
        compare = false; $("#compare-original").checked = false;
        maskCanvas.width = width; maskCanvas.height = height;
        const ctx = maskCanvas.getContext("2d");
        if (next.mask) ctx.drawImage(await loadImage(next.mask), 0, 0, width, height);
        else { ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, height); }
        if (next.colors) { colors = makeCanvas(width, height); colors.getContext("2d").drawImage(await loadImage(next.colors), 0, 0, width, height); }
        if (version !== generation) return;
        const pixels = ctx.getImageData(0, 0, width, height).data;
        alpha = Uint8ClampedArray.from({ length: width * height }, (_, i) => pixels[i * 4 + 3]);
        dirty = focusDirty = true;
        const scale = Math.min(700 / width, 420 / height, 1);
        canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
        setStatus(next.mask ? "Your saved cutout is ready to refine." : "Automatic cutouts run on your device. No photo upload needed.");
        draw(); if (!dialog.open) dialog.showModal();
        if (automatic && !next.mask) runAutomatic();
      } catch (error) { notify(error.message); }
    },
  };
}
