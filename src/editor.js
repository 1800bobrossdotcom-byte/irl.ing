import { keepConnectedSubject } from "./mask.js";

export function createEditor({
  onApply,
  notify,
  loadImage,
  makeCanvas,
  trimCanvas,
}) {
  const $ = (selector) => document.querySelector(selector);
  const canvas = $("#editor-canvas");
  const dialog = $("#editor-dialog");
  let asset,
    image,
    mask,
    mode = "whole",
    points = [],
    history = [];
  let worker,
    timeout,
    generation = 0,
    busy = false,
    pointerActive = false,
    previousPoint;
  let compare = false,
    applying = false;
  const cutout = makeCanvas(1);
  const preview = makeCanvas(1);

  function setStatus(text, error = false) {
    $("#cutout-status").textContent = text;
    $("#cutout-status").classList.toggle("error", error);
  }
  function cancelInference(message) {
    generation++;
    clearTimeout(timeout);
    if (worker) worker.terminate();
    worker = null;
    busy = false;
    if (message) setStatus(message);
  }
  function snapshot() {
    history.push(
      mask.getContext("2d").getImageData(0, 0, mask.width, mask.height),
    );
    const maxHistory = Math.max(
      1,
      Math.min(
        15,
        Math.floor((24 * 1024 * 1024) / (mask.width * mask.height * 4)),
      ),
    );
    while (history.length > maxHistory) history.shift();
  }
  function maskedSource() {
    cutout.width = mask.width;
    cutout.height = mask.height;
    const ctx = cutout.getContext("2d");
    ctx.drawImage(image, 0, 0, mask.width, mask.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    return cutout;
  }
  function validTrace() {
    return (
      points.length >= 3 &&
      Math.abs(
        points.reduce((sum, p, i) => {
          const next = points[(i + 1) % points.length];
          return sum + p.x * next.y - next.x * p.y;
        }, 0),
      ) > 40
    );
  }
  function draw() {
    if (!image) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const showWhole = mode === "whole" || mode === "trace" || compare;
    ctx.drawImage(
      showWhole ? image : maskedSource(),
      0,
      0,
      canvas.width,
      canvas.height,
    );
    if (mode === "trace" && points.length && !compare) {
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.moveTo(points[0].x, points[0].y);
      points.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = "rgba(28,36,23,.5)";
      ctx.fill("evenodd");
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.forEach((p) => ctx.lineTo(p.x, p.y));
      if (points.length > 2) ctx.closePath();
      ctx.strokeStyle = "#d7ef71";
      ctx.lineWidth = 2;
      ctx.stroke();
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#d7ef71";
        ctx.fill();
        ctx.strokeStyle = "#293421";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    const labels = {
      whole: "Keep the whole image, or let us find its subject.",
      trace:
        "Tap or draw around the object you want to keep. The green outline becomes your cutout.",
      cutout:
        "Looking good? Keep it. Use Erase or Restore for the little details.",
      erase:
        "Brush over the bits you don’t want. Undo takes you back one stroke.",
      restore: "Brush to bring back a part of your original photo.",
      select: "Tap one of the separated objects to keep just that subject.",
    };
    $("#editor-instructions").textContent = labels[mode];
    for (const [id, target] of [
      ["whole-image", "whole"],
      ["trace-image", "trace"],
      ["erase-mask", "erase"],
      ["restore-mask", "restore"],
      ["select-subject", "select"],
    ]) {
      const button = $(`#${id}`);
      button.classList.toggle("selected", mode === target);
      button.setAttribute("aria-pressed", String(mode === target));
    }
    $("#refine-tools").hidden = mode === "whole" || mode === "trace";
    $("#brush-control").hidden = !["erase", "restore"].includes(mode);
    $("#undo-point").disabled =
      mode === "trace" ? !points.length : !history.length;
    $("#undo-point").textContent = mode === "trace" ? "Undo point" : "Undo";
    $("#clear-points").disabled = mode !== "trace" || !points.length;
    $("#clear-points").hidden = mode !== "trace";
    $("#use-cutout").disabled =
      busy || applying || (mode === "trace" && !validTrace());
    $("#auto-cutout").disabled = busy || applying;
    $("#auto-cutout").setAttribute("aria-busy", String(busy));
    $("#cancel-cutout").hidden = !busy;
    $("#auto-cutout-label").textContent = busy
      ? "Finding your thing…"
      : "Remove background";
    $("#point-count").textContent = busy
      ? "Working on your device"
      : mode === "trace"
        ? `${points.length} outline points${points.length < 3 ? " · add at least 3" : ""}`
        : mode === "whole"
          ? "Whole image selected"
          : "Background removed · check the edges";
    canvas.style.cursor = ["erase", "restore", "trace", "select"].includes(mode)
      ? "crosshair"
      : "default";
  }
  function chooseMode(next) {
    if (busy)
      cancelInference("Automatic cutout cancelled. You can keep editing.");
    compare = false;
    $("#compare-original").checked = false;
    if (next === "whole") {
      mode = "whole";
      draw();
      return;
    }
    if (next === "trace") {
      mode = "trace";
      draw();
      return;
    }
    mode = next;
    draw();
  }
  async function runAutomatic() {
    if (!image || busy) return;
    cancelInference();
    const version = generation;
    busy = true;
    setStatus("Preparing your photo…");
    draw();
    // White-composite transparency before inference; restore original alpha
    // when applying the inferred mask so transparent artwork stays transparent.
    const input = makeCanvas(320);
    const ctx = input.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 320, 320);
    ctx.drawImage(image, 0, 0, 320, 320);
    const pixels = ctx.getImageData(0, 0, 320, 320).data;
    try {
      worker = new Worker(new URL("./cutout.worker.js", import.meta.url), {
        type: "module",
      });
      const fail = (message) => {
        if (version !== generation) return;
        cancelInference();
        setStatus(message, true);
        draw();
      };
      worker.onerror = () =>
        fail(
          "The cutout tool couldn’t start on this browser. You can still trace your object.",
        );
      worker.onmessage = ({ data }) => {
        if (version !== generation) return;
        if (data.type === "status") {
          setStatus(data.message);
          return;
        }
        if (data.type === "error") {
          fail(data.message);
          return;
        }
        if (data.type !== "result") return;
        clearTimeout(timeout);
        busy = false;
        const small = makeCanvas(320),
          smallCtx = small.getContext("2d"),
          rgba = smallCtx.createImageData(320, 320);
        for (let i = 0; i < data.mask.length; i++) {
          rgba.data[i * 4] = 255;
          rgba.data[i * 4 + 1] = 255;
          rgba.data[i * 4 + 2] = 255;
          rgba.data[i * 4 + 3] = data.mask[i];
        }
        smallCtx.putImageData(rgba, 0, 0);
        snapshot();
        const maskCtx = mask.getContext("2d");
        maskCtx.clearRect(0, 0, mask.width, mask.height);
        maskCtx.imageSmoothingQuality = "high";
        maskCtx.drawImage(small, 0, 0, mask.width, mask.height);
        mode = "cutout";
        setStatus(
          "Your subject is ready. Check the edges, then keep your favorite bit.",
        );
        draw();
        // Release the large inference heap. HTTP cache retains the model and
        // runtime for another photo without keeping this worker alive.
        worker.terminate();
        worker = null;
      };
      timeout = setTimeout(
        () =>
          fail(
            "That took too long on this device. Try again, or trace the outline yourself.",
          ),
        90000,
      );
      worker.postMessage({ pixels }, [pixels.buffer]);
    } catch {
      cancelInference();
      setStatus(
        "Automatic cutout is unavailable here. You can still trace your object.",
        true,
      );
      draw();
    }
  }
  $("#auto-cutout").onclick = runAutomatic;
  $("#cancel-cutout").onclick = () => {
    cancelInference("Cancelled. Your photo is still here.");
    draw();
  };
  $("#whole-image").onclick = () => chooseMode("whole");
  $("#trace-image").onclick = () => chooseMode("trace");
  $("#erase-mask").onclick = () => chooseMode("erase");
  $("#restore-mask").onclick = () => chooseMode("restore");
  $("#select-subject").onclick = () => chooseMode("select");
  $("#undo-point").onclick = () => {
    if (mode === "trace") points.pop();
    else if (history.length)
      mask.getContext("2d").putImageData(history.pop(), 0, 0);
    draw();
  };
  $("#clear-points").onclick = () => {
    points = [];
    draw();
  };
  $("#compare-original").onchange = (event) => {
    compare = event.target.checked;
    draw();
  };
  $("#brush-size").oninput = (event) => {
    $("#brush-value").textContent = `${event.target.value} px`;
  };
  function point(event) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          canvas.width,
          ((event.clientX - r.left) * canvas.width) / r.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          canvas.height,
          ((event.clientY - r.top) * canvas.height) / r.height,
        ),
      ),
    };
  }
  function brush(p) {
    const scale = mask.width / canvas.width,
      ctx = mask.getContext("2d");
    ctx.globalCompositeOperation =
      mode === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = "white";
    ctx.fillStyle = "white";
    ctx.lineWidth = Number($("#brush-size").value) * scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo((previousPoint || p).x * scale, (previousPoint || p).y * scale);
    ctx.lineTo(p.x * scale, p.y * scale);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    previousPoint = p;
    draw();
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button > 0 || busy || compare) return;
    const p = point(event);
    pointerActive = true;
    previousPoint = null;
    canvas.setPointerCapture(event.pointerId);
    if (mode === "trace") {
      points.push(p);
      draw();
    } else if (mode === "erase" || mode === "restore") {
      snapshot();
      brush(p);
    } else if (mode === "select") {
      preview.width = canvas.width;
      preview.height = canvas.height;
      const ctx = preview.getContext("2d");
      ctx.drawImage(mask, 0, 0, preview.width, preview.height);
      const rgba = ctx.getImageData(0, 0, preview.width, preview.height);
      const alpha = Uint8ClampedArray.from(
        { length: preview.width * preview.height },
        (_, i) => rgba.data[i * 4 + 3],
      );
      const selected = keepConnectedSubject(
        alpha,
        preview.width,
        preview.height,
        p.x,
        p.y,
      );
      if (!selected) {
        setStatus("Tap on the object itself, or use Restore to bring it back.");
        return;
      }
      snapshot();
      for (let i = 0; i < selected.length; i++)
        rgba.data[i * 4 + 3] = selected[i];
      ctx.putImageData(rgba, 0, 0);
      const maskCtx = mask.getContext("2d");
      maskCtx.clearRect(0, 0, mask.width, mask.height);
      maskCtx.drawImage(preview, 0, 0, mask.width, mask.height);
      setStatus("Just this one. Undo brings the other objects back.");
      draw();
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointerActive || busy || compare) return;
    const p = point(event);
    if (mode === "trace") {
      const last = points.at(-1);
      if (last && Math.hypot(p.x - last.x, p.y - last.y) > 7) {
        points.push(p);
        draw();
      }
    } else if (mode === "erase" || mode === "restore") brush(p);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    canvas.addEventListener(name, () => {
      pointerActive = false;
      previousPoint = null;
    });
  dialog.addEventListener("close", () => {
    cancelInference();
    pointerActive = false;
  });
  $("#use-cutout").onclick = async () => {
    if (!asset || busy || applying || (mode === "trace" && !validTrace()))
      return;
    applying = true;
    draw();
    try {
      if (mode === "whole") {
        const ctx = mask.getContext("2d");
        ctx.clearRect(0, 0, mask.width, mask.height);
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, mask.width, mask.height);
      }
      if (mode === "trace") {
        const ctx = mask.getContext("2d"),
          scale = mask.width / canvas.width;
        ctx.clearRect(0, 0, mask.width, mask.height);
        ctx.beginPath();
        points.forEach((p, i) =>
          ctx[i ? "lineTo" : "moveTo"](p.x * scale, p.y * scale),
        );
        ctx.closePath();
        ctx.fillStyle = "white";
        ctx.fill();
      }
      const trimmed = trimCanvas(maskedSource());
      await onApply({
        ...asset,
        id: crypto.randomUUID(),
        source: asset.source || asset.data,
        mask: mask.toDataURL("image/png"),
        data: trimmed.toDataURL("image/png"),
        sample: Boolean(asset.sample),
      });
      dialog.close();
      notify("There it is. A little piece of your world.");
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      applying = false;
      draw();
    }
  };
  return {
    async open(next, { automatic = false } = {}) {
      cancelInference();
      const version = generation;
      try {
        const loaded = await loadImage(next.source || next.data);
        if (version !== generation) return;
        image = loaded;
        asset = { ...next };
        points = [];
        history = [];
        mode = next.mask ? "cutout" : "whole";
        compare = false;
        $("#compare-original").checked = false;
        mask = makeCanvas(image.naturalWidth, image.naturalHeight);
        const ctx = mask.getContext("2d");
        if (next.mask)
          ctx.drawImage(
            await loadImage(next.mask),
            0,
            0,
            mask.width,
            mask.height,
          );
        else {
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, mask.width, mask.height);
        }
        if (version !== generation) return;
        const scale = Math.min(
          700 / image.naturalWidth,
          420 / image.naturalHeight,
          1,
        );
        canvas.width = Math.round(image.naturalWidth * scale);
        canvas.height = Math.round(image.naturalHeight * scale);
        setStatus(
          next.mask
            ? "Your saved cutout is ready to refine."
            : "Automatic cutouts run on your device. No photo upload needed.",
        );
        draw();
        if (!dialog.open) dialog.showModal();
        if (automatic && !next.mask) runAutomatic();
      } catch (error) {
        notify(error.message);
      }
    },
  };
}
