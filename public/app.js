"use strict";

const $ = (selector) => document.querySelector(selector);
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const money = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const samples = [
  {
    id: "flower",
    name: "The afternoon flower",
    data: "/assets/flower.svg",
    sample: true,
  },
  {
    id: "cherries",
    name: "A very good cherry season",
    data: "/assets/cherries.svg",
    sample: true,
  },
  {
    id: "mushroom",
    name: "A little woodland find",
    data: "/assets/mushroom.svg",
    sample: true,
  },
];
const state = {
  asset: null,
  image: null,
  shape: "die-cut",
  finish: "matte",
  size: 3,
  quantity: 25,
  border: 8,
};
let selectionVersion = 0;
let toastTimer;
let collection = [];
const storageKey = "irling.moments.v1";
const safeImage = (value) =>
  typeof value === "string" &&
  (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) ||
    samples.some((s) => s.data === value));
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(saved))
    collection = saved
      .filter(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          safeImage(item.data) &&
          (!item.source || safeImage(item.source)),
      )
      .slice(0, 12);
} catch {
  /* A fresh or restricted browser can still use the studio. */
}

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 4200);
}
function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
}
function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error("That image could not be opened. Try a JPG, PNG or WebP."),
      );
    image.src = source;
  });
}
function makeCanvas(width, height = width) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
function alphaBounds(canvas) {
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 8) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  return right < left
    ? null
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
function trimCanvas(canvas) {
  const bounds = alphaBounds(canvas);
  if (!bounds)
    throw new Error(
      "That selection is empty. Choose a visible part of your photo.",
    );
  const trimmed = makeCanvas(bounds.width, bounds.height);
  trimmed
    .getContext("2d")
    .drawImage(
      canvas,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      bounds.width,
      bounds.height,
    );
  return trimmed;
}
async function selectAsset(asset) {
  const version = ++selectionVersion;
  try {
    const image = await loadImage(asset.data);
    if (version !== selectionVersion) return;
    const canvas = makeCanvas(image.naturalWidth, image.naturalHeight);
    canvas.getContext("2d").drawImage(image, 0, 0);
    state.image = trimCanvas(canvas);
    state.asset = { ...asset };
    $("#asset-status").textContent = asset.sample
      ? "Sample object"
      : "Your moment";
    document.querySelectorAll(".sample-button").forEach((button) => {
      button.classList.toggle("selected", button.dataset.id === asset.id);
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.id === asset.id),
      );
    });
    renderPreview();
    updateSavedStatus();
  } catch (error) {
    toast(error.message);
  }
}

// Preview-only price curves. A live application must obtain an expiring quote
// from its server; these providers and all their numbers are illustrative.
function getQuote() {
  const scale =
    { 2: 0.8, 3: 1, 4: 1.35 }[state.size] *
    { matte: 1, glossy: 1.1, holographic: 1.45 }[state.finish];
  const candidates = [
    {
      supplier: "Sample partner A",
      cents: Math.round((600 + 48 * state.quantity) * scale),
      days: 5,
    },
    {
      supplier: "Sample partner B",
      cents: Math.round((1100 + 35 * state.quantity) * scale),
      days: 6,
    },
  ];
  return candidates.sort((a, b) => a.cents - b.cents)[0];
}
function updatePrice() {
  const quote = getQuote();
  $("#total-price").textContent = money(quote.cents);
  $("#per-sticker").textContent =
    `${money(quote.cents / state.quantity)} / sticker`;
}
function renderPreview() {
  if (!state.image) return;
  const canvas = $("#sticker-canvas");
  const ctx = canvas.getContext("2d");
  const image = state.image;
  ctx.clearRect(0, 0, 1000, 1000);
  const artwork = makeCanvas(1000);
  const art = artwork.getContext("2d");
  const border = state.border * 3.6;
  let scale;
  if (state.shape === "die-cut") {
    scale = Math.min(760 / image.width, 760 / image.height);
    art.drawImage(
      image,
      (1000 - image.width * scale) / 2,
      (1000 - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
    if (border > 0) {
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 32)
        ctx.drawImage(
          artwork,
          Math.cos(angle) * border,
          Math.sin(angle) * border,
        );
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = "#fffefb";
      ctx.fillRect(0, 0, 1000, 1000);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(artwork, 0, 0);
  } else {
    const rx = 410,
      ry = state.shape === "oval" ? 305 : 410;
    ctx.beginPath();
    ctx.ellipse(500, 500, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#fffefb";
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(500, 500, rx - border, ry - border, 0, 0, Math.PI * 2);
    ctx.clip();
    scale =
      Math.min(
        (rx * 2 - border * 2) / image.width,
        (ry * 2 - border * 2) / image.height,
      ) * 0.88;
    ctx.drawImage(
      image,
      (1000 - image.width * scale) / 2,
      (1000 - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
    ctx.restore();
  }
  if (state.finish !== "matte") {
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    const gradient = ctx.createLinearGradient(100, 150, 850, 800);
    const stops =
      state.finish === "holographic"
        ? [
            [0, "rgba(220,120,244,.28)"],
            [0.25, "rgba(117,219,235,.32)"],
            [0.5, "rgba(227,247,125,.24)"],
            [0.75, "rgba(246,132,193,.26)"],
            [1, "rgba(120,160,246,.25)"],
          ]
        : [
            [0, "rgba(255,255,255,0)"],
            [0.35, "rgba(255,255,255,0)"],
            [0.47, "rgba(255,255,255,.42)"],
            [0.6, "rgba(255,255,255,0)"],
            [1, "rgba(255,255,255,0)"],
          ];
    stops.forEach(([position, color]) =>
      gradient.addColorStop(position, color),
    );
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1000, 1000);
    ctx.restore();
  }
  const bounds = alphaBounds(canvas);
  const longest = Math.max(bounds.width, bounds.height);
  const dimension = (px) => Number(((state.size * px) / longest).toFixed(1));
  $("#measurement").textContent =
    `${dimension(bounds.width)}″ × ${dimension(bounds.height)}″`;
  $("#sticker-canvas").setAttribute(
    "aria-label",
    `${state.asset.name}, ${state.size} inch ${state.finish} ${state.shape} sticker preview`,
  );
  const quality = $("#quality-note");
  const insufficient =
    !state.asset.sample &&
    Math.max(image.width, image.height) < state.size * 300;
  quality.hidden = !insufficient;
  quality.textContent = insufficient
    ? `This photo may look soft at ${state.size}″. A larger photo will print more clearly.`
    : "";
  updatePrice();
}
const qualityNote = document.createElement("p");
qualityNote.id = "quality-note";
qualityNote.className = "quality-note";
qualityNote.hidden = true;
$(".order-block").prepend(qualityNote);
for (const [id, key] of [
  ["shape-options", "shape"],
  ["finish-options", "finish"],
  ["size-options", "size"],
  ["quantity-options", "quantity"],
]) {
  $(`#${id}`).addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    state[key] =
      key === "size" || key === "quantity"
        ? Number(button.dataset.value)
        : button.dataset.value;
    $(`#${id}`)
      .querySelectorAll("button")
      .forEach((item) => {
        item.classList.toggle("selected", item === button);
        item.setAttribute("aria-pressed", String(item === button));
      });
    $("#finish-description").textContent = {
      matte: "Soft feel. Zero glare.",
      glossy: "A little extra shine.",
      holographic: "A rainbow in every angle.",
    }[state.finish];
    if (key === "quantity") updatePrice();
    else renderPreview();
  });
}
$("#border-input").addEventListener("input", (event) => {
  state.border = Number(event.target.value);
  $("#border-value").textContent = `${state.border}%`;
  renderPreview();
});
for (const sample of samples) {
  const button = document.createElement("button");
  button.className = "sample-button";
  button.dataset.id = sample.id;
  button.setAttribute("aria-label", sample.name);
  button.setAttribute("aria-pressed", "false");
  button.title = sample.name;
  button.innerHTML = `<img src="${sample.data}" alt="">`;
  button.addEventListener("click", () => selectAsset(sample));
  $("#sample-list").append(button);
}

// Local photo import and a touch/mouse polygon editor. No photo is sent to a server.
let editing = null;
let editorImage = null;
let points = [];
let traceMode = false;
let pointerActive = false;
$("#upload-button").onclick = () => openDialog("#upload-dialog");
$("#choose-photo").onclick = () => $("#photo-input").click();
$("#take-photo").onclick = () => $("#camera-input").click();
for (const id of ["photo-input", "camera-input"]) {
  $(`#${id}`).addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast("Choose a photo smaller than 20 MB.");
      return;
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      toast("Try a JPG, PNG, WebP or GIF photo.");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(objectUrl);
      const scale = Math.min(
        1,
        1600 / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const resized = makeCanvas(
        image.naturalWidth * scale,
        image.naturalHeight * scale,
      );
      resized
        .getContext("2d")
        .drawImage(image, 0, 0, resized.width, resized.height);
      const data = resized.toDataURL("image/png");
      $("#upload-dialog").close();
      await openEditor({
        id: crypto.randomUUID(),
        name:
          file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "A little moment",
        data,
        source: data,
        sample: false,
      });
    } catch (error) {
      toast(error.message);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  });
}
$("#edit-object").onclick = () => state.asset && openEditor(state.asset);
async function openEditor(asset) {
  try {
    editorImage = await loadImage(asset.source || asset.data);
    editing = { ...asset };
    points = [];
    traceMode = false;
    const scale = Math.min(
      700 / editorImage.naturalWidth,
      420 / editorImage.naturalHeight,
      1,
    );
    $("#editor-canvas").width = Math.round(editorImage.naturalWidth * scale);
    $("#editor-canvas").height = Math.round(editorImage.naturalHeight * scale);
    drawEditor();
    openDialog("#editor-dialog");
  } catch (error) {
    toast(error.message);
  }
}
function polygonArea() {
  return (
    Math.abs(
      points.reduce((area, point, i) => {
        const next = points[(i + 1) % points.length];
        return area + point.x * next.y - next.x * point.y;
      }, 0),
    ) / 2
  );
}
function drawEditor() {
  const canvas = $("#editor-canvas");
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(editorImage, 0, 0, width, height);
  if (traceMode && points.length) {
    ctx.fillStyle = "rgba(31,40,25,.45)";
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.moveTo(points[0].x, points[0].y);
    points.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fill("evenodd");
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.forEach((p) => ctx.lineTo(p.x, p.y));
    if (points.length > 2) ctx.closePath();
    ctx.strokeStyle = "#d7ef71";
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#d7ef71";
      ctx.fill();
      ctx.strokeStyle = "#354026";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  $("#whole-image").classList.toggle("selected", !traceMode);
  $("#whole-image").setAttribute("aria-pressed", String(!traceMode));
  $("#trace-image").classList.toggle("selected", traceMode);
  $("#trace-image").setAttribute("aria-pressed", String(traceMode));
  $("#undo-point").disabled = !traceMode || !points.length;
  $("#clear-points").disabled = !traceMode || !points.length;
  $("#use-cutout").disabled =
    traceMode && (points.length < 3 || polygonArea() < 20);
  $("#point-count").textContent = traceMode
    ? `${points.length} outline points${points.length < 3 ? " · add at least 3" : ""}`
    : "Whole image selected";
  $("#editor-instructions").textContent = traceMode
    ? "Tap around your object, or draw around it. The green outline is the part you’ll keep."
    : "Keep the whole image, or tap around an object to trace its outline.";
}
$("#whole-image").onclick = () => {
  traceMode = false;
  drawEditor();
};
$("#trace-image").onclick = () => {
  traceMode = true;
  drawEditor();
};
$("#undo-point").onclick = () => {
  points.pop();
  drawEditor();
};
$("#clear-points").onclick = () => {
  points = [];
  drawEditor();
};
function addPoint(event, dragging = false) {
  const canvas = $("#editor-canvas");
  const rect = canvas.getBoundingClientRect();
  const point = {
    x: Math.max(
      0,
      Math.min(
        canvas.width,
        ((event.clientX - rect.left) * canvas.width) / rect.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        canvas.height,
        ((event.clientY - rect.top) * canvas.height) / rect.height,
      ),
    ),
  };
  const last = points[points.length - 1];
  if (dragging && last && Math.hypot(point.x - last.x, point.y - last.y) < 7)
    return;
  points.push(point);
  drawEditor();
}
$("#editor-canvas").addEventListener("pointerdown", (event) => {
  if (!traceMode || event.button > 0) return;
  pointerActive = true;
  event.currentTarget.setPointerCapture(event.pointerId);
  addPoint(event);
});
$("#editor-canvas").addEventListener("pointermove", (event) => {
  if (traceMode && pointerActive) addPoint(event, true);
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
  $("#editor-canvas").addEventListener(name, () => {
    pointerActive = false;
  });
$("#use-cutout").onclick = async () => {
  if (!editing || (traceMode && (points.length < 3 || polygonArea() < 20)))
    return;
  try {
    const source = makeCanvas(
      editorImage.naturalWidth,
      editorImage.naturalHeight,
    );
    const ctx = source.getContext("2d");
    if (traceMode) {
      const sx = source.width / $("#editor-canvas").width,
        sy = source.height / $("#editor-canvas").height;
      ctx.beginPath();
      points.forEach((point, i) =>
        ctx[i ? "lineTo" : "moveTo"](point.x * sx, point.y * sy),
      );
      ctx.closePath();
      ctx.clip();
    }
    ctx.drawImage(editorImage, 0, 0);
    const cutout = trimCanvas(source);
    const asset = {
      ...editing,
      id: crypto.randomUUID(),
      source: editing.source || editing.data,
      data: cutout.toDataURL("image/png"),
      sample: editing.sample && !traceMode,
    };
    await selectAsset(asset);
    $("#editor-dialog").close();
    toast("There it is. A little piece of your world.");
  } catch (error) {
    toast(error.message);
  }
};

function updateSavedStatus() {
  $("#collection-count").textContent = collection.length;
  const saved = Boolean(
    state.asset && collection.some((item) => item.id === state.asset.id),
  );
  $("#save-object").classList.toggle("saved", saved);
  $("#save-object").setAttribute("aria-pressed", String(saved));
  $("#save-object").setAttribute(
    "aria-label",
    saved ? "Moment saved" : "Save moment",
  );
}
function persistCollection(next) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
    collection = next;
    updateSavedStatus();
    return true;
  } catch {
    toast(
      "Your browser couldn’t save this. Free up a saved moment, or download your preview.",
    );
    return false;
  }
}
$("#save-object").onclick = () => {
  if (!state.asset) return;
  if (collection.some((item) => item.id === state.asset.id)) {
    toast("Already in My moments. A good thing to keep.");
    return;
  }
  if (collection.length >= 12) {
    toast("Your collection is full. Remove a moment to make room.");
    return;
  }
  if (persistCollection([...collection, { ...state.asset }]))
    toast("A moment, kept. Find it in My moments.");
};
$("#collection-nav").onclick = () => {
  renderCollection();
  openDialog("#collection-dialog");
};
function renderCollection() {
  const grid = $("#collection-grid");
  grid.replaceChildren();
  if (!collection.length) {
    grid.innerHTML = `<div class="collection-empty">${icon("heart")}<p>Nothing here. Yet.</p><p>Tap the heart in the studio to hold on to a little moment.</p><button class="secondary-button" id="back-to-studio">Find your first moment</button></div>`;
    $("#back-to-studio").onclick = () => $("#collection-dialog").close();
    return;
  }
  for (const item of collection) {
    const card = document.createElement("div");
    card.className = "collection-card";
    const use = document.createElement("button");
    use.className = "collection-use";
    const img = document.createElement("img");
    img.src = item.data;
    img.alt = "";
    const name = document.createElement("span");
    name.textContent = item.name;
    use.append(img, name);
    use.onclick = async () => {
      await selectAsset(item);
      $("#collection-dialog").close();
    };
    const remove = document.createElement("button");
    remove.className = "collection-delete icon-button";
    remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.innerHTML = icon("close");
    remove.onclick = () => {
      if (persistCollection(collection.filter((saved) => saved.id !== item.id)))
        renderCollection();
    };
    card.append(use, remove);
    grid.append(card);
  }
}
$("#download-art").onclick = () => {
  if (!state.image) return;
  const output = trimCanvas($("#sticker-canvas"));
  output.toBlob((blob) => {
    if (!blob) {
      toast("The preview could not be exported. Try again.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `irling-${state.shape}-preview.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Preview downloaded. Print-ready files come in the next version.");
  }, "image/png");
};

$("#checkout-button").onclick = () => {
  if (!state.asset) return;
  const quote = getQuote();
  const snapshot = {
    ...state,
    image: undefined,
    asset: { ...state.asset },
    quote,
    preview: $("#sticker-canvas").toDataURL("image/png"),
  };
  $("#checkout-content").innerHTML =
    `<span class="demo-badge">A LITTLE LOOK AT WHAT’S NEXT · DEMO</span><h2>From your world.<br>Back into it.</h2><p>A little moment, ready for a second life.</p><div class="checkout-preview"><img src="${snapshot.preview}" alt="Your sticker preview"><div><h3>${escapeHtml(snapshot.asset.name)}</h3><p>${snapshot.quantity} ${snapshot.shape} stickers<br>${snapshot.size}″ · ${capitalize(snapshot.finish)} finish</p></div></div><div class="checkout-summary"><div class="summary-row"><span>${snapshot.quantity} custom stickers</span><span>${money(quote.cents)}</span></div><div class="summary-row"><span>US shipping</span><span>Included</span></div><div class="summary-row"><span>Delivery estimate</span><span>About ${quote.days} business days <span class="muted">(demo)</span></span></div><div class="summary-row total"><strong>Illustrative total</strong><strong>${money(quote.cents)}</strong></div></div><p class="checkout-note">This is a practice run. No payment, address, or real order. Live pricing, tax, printing and delivery will be connected next.</p><button class="primary-button" id="place-demo-order">Try a demo order ${icon("arrow")}</button>`;
  $("#place-demo-order").onclick = () => confirmDemo(snapshot);
  openDialog("#checkout-dialog");
};
function confirmDemo(snapshot) {
  const id = "IRL-" + crypto.randomUUID().slice(0, 6).toUpperCase();
  $("#checkout-content").innerHTML =
    `<span class="demo-badge">DEMO COMPLETE · NO REAL ORDER</span><div class="confirmation-icon">${icon("check")}</div><h2>Look at you.<br>You’re irl’ing.</h2><p>That thing you noticed? Imagine ${snapshot.quantity} little versions of it, out in the world.</p><div class="checkout-preview"><img src="${snapshot.preview}" alt="Your demo sticker"><div><h3>${escapeHtml(snapshot.asset.name)}</h3><p>${snapshot.quantity} × ${snapshot.size}″ ${snapshot.finish} ${snapshot.shape} stickers<br>${money(snapshot.quote.cents)} illustrative total · $0 charged</p></div></div><div class="confirmation-number">DEMO REFERENCE ${id}</div><p class="checkout-note">Nothing is being printed or shipped. Your demo ends here. Keep exploring, or save this moment with the heart in the studio.</p><button class="primary-button" id="make-another">Go on. Notice something else. ${icon("arrow")}</button>`;
  $("#make-another").onclick = () => $("#checkout-dialog").close();
  $("#checkout-dialog").scrollTop = 0;
}
$("#how-button").onclick = () => openDialog("#how-dialog");
$(".bottom-copy").role = "button";
$(".bottom-copy").tabIndex = 0;
$(".bottom-copy").setAttribute("aria-label", "What is irl’ing?");
$(".bottom-copy").onclick = () => openDialog("#how-dialog");
$(".bottom-copy").onkeydown = (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openDialog("#how-dialog");
  }
};
$("#lets-make").onclick = () => $("#how-dialog").close();
$("#studio-nav").onclick = () => {
  for (const dialog of document.querySelectorAll("dialog[open]"))
    dialog.close();
  $(".studio").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "start",
  });
};
updateSavedStatus();
selectAsset(samples[0]);
