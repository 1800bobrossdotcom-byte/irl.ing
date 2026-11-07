// The feed (friends' loops and yours, newest first, then it ends) and
// "Your loops". Each loop shows its poster; tap to play. Signed links last
// ten minutes, so links are refreshed before they run out and again
// whenever a poster or a play fails.

import { api, at, dotsIcon, h, toast } from "./api.js";
import { isPlaying, playLoop, stopLoop } from "./player.js";
import { REPORT_LABELS } from "./reasons.js";
import { choose, confirmAction } from "./sheet.js";
import { hiddenLoops, hideLoop } from "./store.js";

const FRESH_MS = 9 * 60_000; // links last 10 minutes; refresh a little early
const RETRY_MS = 30_000;

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/**
 * kind "feed": GET /irl/feed, with Report / Block on others' loops.
 * kind "mine": GET /irl/loops/mine, held loops marked as waiting.
 * onChanged(what) runs after a block or delete, so other views can reload.
 */
export function loopList({ panel, kind, onChanged }) {
  const source = kind === "feed" ? "/irl/feed" : "/irl/loops/mine";
  const items = new Map(); // id -> { loop, el, img }
  let fetchedAt = 0;
  let lastRetry = 0;
  let loaded = false;

  async function fetchLoops() {
    const res = await api(source);
    if (!res.ok) return { error: res.message };
    fetchedAt = Date.now();
    const hidden = kind === "feed" ? hiddenLoops() : new Set();
    return { loops: (res.body.loops ?? []).filter((l) => !hidden.has(l.id)) };
  }

  /** New links for the loops on screen, without redrawing them. */
  async function refreshLinks() {
    const { loops } = await fetchLoops();
    if (!loops) return;
    const fresh = new Map(loops.map((l) => [l.id, l]));
    for (const [id, item] of items) {
      const loop = fresh.get(id);
      if (!loop) {
        remove(id);
        continue;
      }
      item.loop = loop;
      if (item.img.dataset.failed) {
        delete item.img.dataset.failed;
        item.img.src = loop.posterUrl;
      }
    }
  }

  function posterFailed(img) {
    img.dataset.failed = "1";
    if (Date.now() - lastRetry < RETRY_MS) return;
    lastRetry = Date.now();
    refreshLinks();
  }

  async function play(id, frame) {
    if (isPlaying(frame)) return stopLoop();
    const message = await playLoop(frame, async (retry) => {
      if (retry || Date.now() - fetchedAt > FRESH_MS) await refreshLinks();
      return items.get(id)?.loop.loopUrl ?? null;
    });
    if (message) toast(message);
  }

  function remove(id) {
    const item = items.get(id);
    if (!item) return;
    const hadFocus = item.el.contains(document.activeElement) || document.activeElement === document.body;
    if (item.el.contains(document.querySelector("[data-state]"))) stopLoop();
    const next = item.el.nextElementSibling;
    item.el.remove();
    items.delete(id);
    if (!items.size) render([]);
    else if (hadFocus) (next?.querySelector(".frame") ?? panel.querySelector(".frame"))?.focus();
  }

  async function menu(loop) {
    if (loop.mine || kind === "mine") {
      const choice = await choose({ title: "Your loop", options: [{ label: "Delete", value: "delete", danger: true }] });
      if (choice !== "delete") return;
      if (!(await confirmAction({ title: "Delete this loop?", note: "It’s gone for good.", action: "Delete" }))) return;
      const res = await api("/irl/loops/delete", { id: loop.id });
      if (!res.ok) return toast(res.message);
      remove(loop.id);
      toast("Deleted.");
      onChanged?.("deleted");
      return;
    }
    const name = at(loop.handle);
    const choice = await choose({
      title: `${name}’s loop`,
      options: [
        { label: "Report", value: "report" },
        { label: `Block ${name}`, value: "block", danger: true },
      ],
    });
    if (choice === "report") {
      const reason = await choose({ title: "What’s wrong?", options: Object.entries(REPORT_LABELS).map(([value, label]) => ({ label, value })) });
      if (!reason) return;
      const res = await api("/irl/report", { id: loop.id, reason });
      if (!res.ok) return toast(res.message);
      hideLoop(loop.id);
      remove(loop.id);
      toast(res.body.message || "Reported.");
    } else if (choice === "block") {
      if (!(await confirmAction({ title: `Block ${name}?`, note: "You won’t see each other’s loops, and they can’t add you.", action: `Block ${name}` }))) return;
      const res = await api("/irl/block", { handle: loop.handle });
      if (!res.ok) return toast(res.message);
      for (const [id, item] of items) if (item.loop.handle === loop.handle) remove(id);
      toast(`Blocked ${name}.`);
      onChanged?.("blocked");
    }
  }

  function card(loop) {
    const mine = kind === "mine";
    const held = loop.status === "held";
    const label = mine ? `Play your loop from ${day.format(new Date(loop.createdAt))}` : `Play ${at(loop.handle)}’s loop`;
    const img = h("img", { src: loop.posterUrl, alt: "", decoding: "async", loading: "lazy", onerror: () => posterFailed(img) });
    const frame = h("button", { type: "button", class: "frame", "aria-label": label, "aria-pressed": "false", onclick: () => play(loop.id, frame) }, img);
    frame.addEventListener("loopstate", () => frame.setAttribute("aria-pressed", String(frame.dataset.state === "playing")));
    frame.addEventListener("looperror", (event) => toast(event.detail));
    const more = h("button", { type: "button", class: "more", "aria-label": mine ? "Options for this loop" : `Options for ${at(loop.handle)}’s loop`, "aria-haspopup": "dialog", onclick: () => menu(items.get(loop.id)?.loop ?? loop) }, dotsIcon());
    const el = mine
      ? h("li", { class: `tile${held ? " held" : ""}`, dataset: { id: loop.id } }, frame, h("div", { class: "tile-foot" }, h("span", { class: "state" }, held ? "Waiting for a quick check" : ""), more))
      : h("li", { class: "loop", dataset: { id: loop.id, handle: loop.handle } }, h("div", { class: "loop-head" }, h("span", { class: "handle" }, at(loop.handle)), more), frame);
    items.set(loop.id, { loop, el, img });
    return el;
  }

  function render(loops) {
    stopLoop();
    items.clear();
    const list = h("ul", { class: kind === "feed" ? "loops" : "tiles", role: "list" }, loops.map(card));
    if (kind === "feed") {
      panel.replaceChildren(
        loops.length ? list : h("p", { class: "empty" }, "No loops yet. ", h("a", { href: "#friends" }, "Add friends"), "."),
        h("p", { class: "end" }, "You’re caught up", h("span", { class: "dot" }, ".")),
      );
    } else {
      panel.replaceChildren(loops.length ? list : h("p", { class: "empty" }, "No loops yet."));
    }
  }

  async function load() {
    loaded = true;
    panel.setAttribute("aria-busy", "true");
    const { loops, error } = await fetchLoops();
    panel.removeAttribute("aria-busy");
    if (error) return panel.replaceChildren(h("p", { class: "error", role: "alert" }, error));
    render(loops);
  }

  return { load, get loaded() { return loaded; } };
}
