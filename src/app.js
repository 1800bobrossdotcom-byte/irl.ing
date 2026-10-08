import { createEditor } from "./editor.js";
import { loadMoments, saveMoment, deleteMoment } from "./moments.js";
import { renderArtwork, artworkLayout } from "./artwork.js";
import { drawGarment } from "./garments.js";
import { setPngDensity } from "./png-density.js";
("use strict");

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
  product: "sticker",
  sizes: { sticker: 3, tshirt: 8, sweatshirt: 8 },
};
let selectionVersion = 0;
let toastTimer;
let collection = [];

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
    const vector = /^\/assets\/[a-z]+\.svg$/.test(asset.data);
    const factor = vector ? Math.min(2400 / Math.max(image.naturalWidth, image.naturalHeight), Math.sqrt(4_000_000 / (image.naturalWidth * image.naturalHeight))) : 1;
    const canvas = makeCanvas(image.naturalWidth * factor, image.naturalHeight * factor);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
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
    return true;
  } catch (error) {
    toast(error.message);
    return false;
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
  if (state.product !== "sticker") return;
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
  const shape = state.product === "sticker" ? state.shape : "die-cut";
  const { canvas: artwork } = renderArtwork(image, { shape, border: state.border, size: state.size, preview: true });
  const garment = state.product !== "sticker";
  $("#preview-stage").classList.toggle("garment-preview", garment);
  let longest = 820, centerX = 500, centerY = 500;
  if (garment) {
    const area = drawGarment(ctx, state.product, 1000, 1000);
    longest = area.width * state.size / 12;
    centerX = area.x + area.width / 2;
    centerY = area.y + area.height / 2;
  }
  const scale = longest / Math.max(artwork.width, artwork.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(artwork, centerX - artwork.width * scale / 2, centerY - artwork.height * scale / 2, artwork.width * scale, artwork.height * scale);
  if (!garment && state.finish !== "matte") {
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
  const layout = artworkLayout(image.width, image.height, { shape, border: state.border, size: state.size });
  const physicalWidth = layout.width / layout.dpi, physicalHeight = layout.height / layout.dpi;
  $("#measurement").textContent = `${Number(physicalWidth.toFixed(1))}″ × ${Number(physicalHeight.toFixed(1))}″`;
  const productName = { sticker: "sticker", tshirt: "T-shirt", sweatshirt: "sweatshirt" }[state.product];
  canvas.setAttribute("aria-label", `${state.asset.name}, ${state.size} inch ${garment ? productName + " centered front print" : state.finish + " " + state.shape + " sticker"} preview`);
  $("#preview-caption").textContent = garment ? "YOUR MOMENT. FRONT AND CENTER." : "A MOMENT, WITH A LITTLE STICKING POWER.";
  const density = Math.floor(layout.dpi);
  const insufficient = density < 299;
  const quality = $("#quality-note");
  quality.hidden = !insufficient;
  quality.textContent = insufficient ? `About ${density} DPI at ${state.size}″. Try a larger photo or a smaller print for finer detail.` : "";
  $("#output-note").textContent = `${layout.width} × ${layout.height} px artwork · ${density} DPI at ${state.size}″${garment ? " · centered front print" : " · even white outline"}`;
  updatePrice();
}
const qualityNote = document.createElement("p");
qualityNote.id = "quality-note";
qualityNote.className = "quality-note";
qualityNote.hidden = true;
$("#output-note").after(qualityNote);
function chooseProduct(product) {
  if (!["sticker", "tshirt", "sweatshirt"].includes(product)) return;
  state.sizes[state.product] = state.size;
  state.product = product;
  state.size = state.sizes[product];
  const garment = product !== "sticker";
  $("#sticker-settings").hidden = garment;
  $("#sticker-order").hidden = garment;
  $("#garment-note").hidden = !garment;
  $("#size-label").innerHTML = garment ? "Print size <span>Longest edge</span>" : "Size <span>Longest edge</span>";
  $("#size-options").innerHTML = (garment ? [8, 10, 12] : [2, 3, 4]).map(size => `<button class="option${size === state.size ? " selected" : ""}" data-value="${size}" aria-pressed="${size === state.size}">${size}″</button>`).join("");
  $("#product-options").querySelectorAll("button").forEach(button => {
    const selected = button.dataset.value === product;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  renderPreview();
}
$("#product-options").onclick = event => {
  const button = event.target.closest("button[data-value]");
  if (button) chooseProduct(button.dataset.value);
};
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
    if (key === "size") state.sizes[state.product] = state.size;
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
  button.addEventListener("click", async () => {
    await selectAsset(sample);
    setFlowStep("sticker");
    $("#customize-sticker").hidden = false;
  });
  $("#sample-list").append(button);
}

// Keep the phone entry points synchronous: mobile browsers require a direct
// user gesture to open their photo library or camera picker.
let importVersion = 0;
let appliedInEditor = false;
function setFlowStep(step) {
  document.querySelectorAll(".flow-steps li").forEach((item) => {
    if (item.dataset.step === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
}
function importMessage(message, error = false) {
  $("#import-status").textContent = message;
  $("#import-status").classList.toggle("error", error);
  $("#upload-error").hidden = !error;
  $("#upload-error").textContent = error ? message : "";
  $("#upload-progress").textContent = error
    ? "Your photo has not been changed."
    : message;
}
function setImportBusy(busy) {
  $(".capture-panel").setAttribute("aria-busy", String(busy));
  for (const id of [
    "start-photo",
    "start-camera",
    "try-example",
    "choose-photo",
    "take-photo",
  ])
    $(`#${id}`).disabled = busy;
}
function goToPreview() {
  if (matchMedia("(max-width: 650px)").matches)
    $(".workspace").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
}
const editor = createEditor({
  onApply: async (asset) => {
    if (!(await selectAsset(asset)))
      throw new Error(
        "That cutout could not be opened. Please try another outline.",
      );
    appliedInEditor = true;
    $("#customize-sticker").hidden = false;
    setFlowStep("sticker");
    importMessage(
      "Your cutout is ready. Check the preview, then choose your product and size.",
    );
  },
  notify: toast,
  loadImage,
  makeCanvas,
  trimCanvas,
});
$("#editor-dialog").addEventListener("close", () => {
  if (appliedInEditor) {
    appliedInEditor = false;
    goToPreview();
  } else setFlowStep(state.asset?.sample ? "photo" : "sticker");
});
function choosePhoto(input) {
  $(input).click();
  editor.warmup();
}
$("#start-photo").onclick = () => choosePhoto("#photo-input");
$("#start-camera").onclick = () => choosePhoto("#camera-input");
$("#upload-button").onclick = () => {
  $("#upload-error").hidden = true;
  openDialog("#upload-dialog");
  editor.warmup();
};
$("#choose-photo").onclick = () => choosePhoto("#photo-input");
$("#take-photo").onclick = () => choosePhoto("#camera-input");
$("#customize-sticker").onclick = () => {
  $(".configurator").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "start",
  });
  $("#config-title").focus({ preventScroll: true });
};
for (const id of ["photo-input", "camera-input"]) {
  $(`#${id}`).addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      importMessage("Choose a photo smaller than 20 MB.", true);
      toast("Choose a photo smaller than 20 MB.");
      return;
    }
    const standard = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
    const heic =
      /^image\/(heic|heif)(-sequence)?$/.test(file.type) ||
      /\.hei[cf]$/i.test(file.name);
    const untyped = !file.type && /\.(png|jpe?g|webp|gif)$/i.test(file.name);
    if (!standard && !heic && !untyped) {
      importMessage(
        "Try a JPG, PNG, WebP, GIF or a photo from your camera.",
        true,
      );
      toast("Try a JPG, PNG, WebP or GIF photo.");
      return;
    }
    const version = ++importVersion;
    setImportBusy(true);
    importMessage("Opening your photo…");
    const url = URL.createObjectURL(file);
    try {
      let image;
      try {
        image = await loadImage(url);
      } catch (error) {
        if (heic)
          throw new Error(
            "This browser can’t open this HEIC photo. Try taking a photo here, or choose a JPG or PNG version.",
          );
        throw error;
      }
      if (version !== importVersion) return;
      const lowMemory = navigator.deviceMemory <= 2;
      const scale = Math.min(1,
        (lowMemory ? 1600 : 2400) / Math.max(image.naturalWidth, image.naturalHeight),
        Math.sqrt((lowMemory ? 2_000_000 : 4_000_000) / (image.naturalWidth * image.naturalHeight)),
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
      setFlowStep("cutout");
      appliedInEditor = false;
      await editor.open(
        {
          id: crypto.randomUUID(),
          name:
            file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "A little moment",
          data,
          source: data,
          sample: false,
        },
        { automatic: true },
      );
      importMessage(
        "We’ll find your subject. Keep it when it looks right.",
      );
    } catch (error) {
      importMessage(error.message, true);
      toast(error.message);
    } finally {
      URL.revokeObjectURL(url);
      if (version === importVersion) setImportBusy(false);
    }
  });
}
$("#try-example").onclick = async () => {
  editor.warmup();
  const version = ++importVersion;
  setImportBusy(true);
  importMessage("Opening a sample scene…");
  try {
    const flower = await loadImage("/assets/flower.svg");
    if (version !== importVersion) return;
    const scene = makeCanvas(800, 900),
      ctx = scene.getContext("2d");
    const background = ctx.createLinearGradient(0, 0, 800, 900);
    background.addColorStop(0, "#e0e5d5");
    background.addColorStop(1, "#b4c7aa");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 800, 900);
    ctx.drawImage(flower, 140, 120, 520, 607);
    const data = scene.toDataURL("image/png");
    setFlowStep("cutout");
    appliedInEditor = false;
    await editor.open(
      {
        id: crypto.randomUUID(),
        name: "An afternoon find",
        data,
        source: data,
        sample: true,
      },
      { automatic: true },
    );
    importMessage(
      "This example is an illustration. Try your own photo whenever you’re ready.",
    );
  } catch (error) {
    importMessage(error.message, true);
  } finally {
    if (version === importVersion) setImportBusy(false);
  }
};
$("#edit-object").onclick = () => {
  if (state.asset) {
    setFlowStep("cutout");
    appliedInEditor = false;
    editor.open(state.asset);
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
function configurationSnapshot() {
  const { product, shape, finish, size, quantity, border } = state;
  return { product, shape, finish, size, quantity, border };
}
function restoreConfiguration(config) {
  if (!config) return;
  chooseProduct(["sticker", "tshirt", "sweatshirt"].includes(config.product) ? config.product : "sticker");
  for (const [key, values] of Object.entries({
    shape: ["die-cut", "circle", "oval"],
    finish: ["matte", "glossy", "holographic"],
    size: state.product === "sticker" ? [2, 3, 4] : [8, 10, 12],
    quantity: [10, 25, 50, 100],
  })) {
    if (values.includes(config[key]))
      document
        .querySelector(`#${key}-options [data-value="${config[key]}"]`)
        ?.click();
  }
  if (
    Number.isInteger(config.border) &&
    config.border >= 0 &&
    config.border <= 15
  ) {
    $("#border-input").value = config.border;
    $("#border-input").dispatchEvent(new Event("input"));
  }
}
$("#save-object").onclick = async () => {
  if (!state.asset) return;
  const item = { ...state.asset, configuration: configurationSnapshot() };
  const button = $("#save-object");
  button.disabled = true;
  try {
    await saveMoment(item);
    collection = await loadMoments();
    updateSavedStatus();
    toast("A moment, kept. Your product and placement choices are saved with it.");
  } catch {
    toast(
      "Your browser couldn’t save this. Free up device storage, or download your preview.",
    );
  } finally {
    button.disabled = false;
  }
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
      restoreConfiguration(item.configuration);
      await selectAsset(item);
      $("#collection-dialog").close();
      setFlowStep("sticker");
      $("#customize-sticker").hidden = false;
      goToPreview();
    };
    const remove = document.createElement("button");
    remove.className = "collection-delete icon-button";
    remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.innerHTML = icon("close");
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        await deleteMoment(item.id);
        collection = await loadMoments();
        updateSavedStatus();
        renderCollection();
      } catch {
        toast("That moment could not be removed. Please try again.");
        remove.disabled = false;
      }
    };
    card.append(use, remove);
    grid.append(card);
  }
}
function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("That image could not be exported. Try again.")), "image/png"));
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$("#download-art").onclick = async () => {
  if (!state.image) return;
  const button = $("#download-art"), image = state.image;
  const { product, size, border } = state, shape = product === "sticker" ? state.shape : "die-cut";
  button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    // Release the idle model before allocating a native-resolution outline.
    editor.releaseIdleModel();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { canvas, layout } = renderArtwork(image, { shape, size, border });
    const blob = await canvasBlob(canvas);
    const bytes = setPngDensity(new Uint8Array(await blob.arrayBuffer()), layout.dpi);
    downloadBlob(new Blob([bytes], { type: "image/png" }), `irling-${product}-${shape}-${size}in-artwork.png`);
    toast(`Artwork downloaded: ${canvas.width} × ${canvas.height} px, ${Math.floor(layout.dpi)} DPI at ${size}″.`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.setAttribute("aria-busy", "false"); }
};
$("#download-preview").onclick = async () => {
  if (!state.image) return;
  try {
    const snapshot = makeCanvas(1000);
    snapshot.getContext("2d").drawImage($("#sticker-canvas"), 0, 0);
    downloadBlob(await canvasBlob(snapshot), `irling-${state.product}-preview.png`);
    toast("Preview downloaded. Use the artwork PNG for your print design.");
  } catch (error) { toast(error.message); }
};

$("#checkout-button").onclick = () => {
  if (!state.asset || state.product !== "sticker") return;
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
$("#save-object").disabled = true;
$("#collection-nav").disabled = true;
loadMoments()
  .then((saved) => {
    collection = saved;
    updateSavedStatus();
  })
  .catch(() => {
    toast(
      "Saved moments are unavailable in this browser. You can still create and download a sticker.",
    );
  })
  .finally(() => {
    $("#save-object").disabled = false;
    $("#collection-nav").disabled = false;
  });
updateSavedStatus();
selectAsset(samples[0]);
