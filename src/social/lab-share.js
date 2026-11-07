// "Share with friends" in the loops lab. The lab announces each loop it
// finishes with an `irl:loop` event ({ bytes, clip }, or null when cleared).
// Loops recorded here can be shared; the sample and opened files can't.
// Signed out, the button opens the account sheet instead.

import { makeStills, shareLoop } from "./share.js";

const $ = (id) => document.getElementById(id);
const button = $("share-friends");
const note = $("share-friends-note");
let current = null; // { bytes, clip }
let state = { sharing: false, signedIn: false };
let busy = false;

async function getJson(path) {
  try {
    const res = await fetch(`/api/auth${path}`, { credentials: "same-origin" });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, body: {} };
  }
}

async function refresh() {
  const [config, me] = await Promise.all([getJson("/irl/config"), getJson("/irl/me")]);
  state = { sharing: Boolean(config.body?.sharing), signedIn: me.ok };
  render();
}

function shareable() {
  return Boolean(current?.bytes && current.clip && !current.clip.sample);
}

function render() {
  const show = state.sharing && shareable();
  button.hidden = !show;
  if (!show) return;
  button.textContent = state.signedIn ? "Share with friends" : "Sign in to share";
  button.disabled = busy;
}

function say(text, link) {
  note.replaceChildren(text);
  if (link) {
    note.append(" ");
    const a = document.createElement("a");
    a.href = link.href;
    a.textContent = link.text;
    note.append(a);
  }
}

button.addEventListener("click", async () => {
  if (!state.signedIn) {
    $("account-open")?.click();
    return;
  }
  if (busy || !shareable()) return;
  busy = true;
  render();
  say("Sharing…");
  try {
    const stills = await makeStills(current.clip);
    const result = await shareLoop(current.bytes, stills);
    if (result.status === "visible") say(result.message, { href: "/friends/", text: "Open your feed" });
    else say(result.message || "Couldn’t share. Try again.");
    if (result.supportResources) {
      say(`${note.textContent} If you’re going through something hard, you can talk to someone now:`, {
        href: "https://findahelpline.com",
        text: "find a helpline",
      });
    }
    if (result.status === "visible" || result.status === "held") current = { ...current, shared: true };
  } catch {
    say("Couldn’t share. Try again.");
  } finally {
    busy = false;
    render();
    if (current?.shared) button.hidden = true; // one share per loop
  }
});

window.addEventListener("irl:loop", (event) => {
  current = event.detail ?? null;
  say("");
  render();
});
// Signing in or out happens in the account sheet; check again when it closes.
$("account-sheet")?.addEventListener("close", refresh);

refresh();
