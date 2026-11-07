// The account sheet in the loops lab: claim an @name, save a passkey, sign in,
// sign out, delete. The Better Auth client (and its WebAuthn helper) loads
// only when someone opens the sheet; on page load we just ask /irl/me.

import { checkHandle } from "./rules.js";

const $ = (id) => document.getElementById(id);
const API = "/api/auth";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const sheet = $("account-sheet");
const pill = $("account-open");
let me = null; // signed-in account, or null
let config = null;
let claim = null; // { claim, handle, teen }
let clientPromise = null;
let turnstileToken = null;

function client() {
  clientPromise ??= Promise.all([import("better-auth/client"), import("@better-auth/passkey/client")]).then(
    ([{ createAuthClient }, { passkeyClient }]) => createAuthClient({ baseURL: `${location.origin}${API}`, plugins: [passkeyClient()] }),
  );
  return clientPromise;
}

async function api(path, init) {
  const res = await fetch(`${API}${path}`, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function show(step) {
  for (const el of sheet.querySelectorAll(".step")) el.hidden = el.dataset.step !== step;
  sheet.dataset.step = step;
  const first = sheet.querySelector(`.step[data-step="${step}"] input, .step[data-step="${step}"] button`);
  first?.focus();
}

function privacyLine(account) {
  return account.teen
    ? "Friends-only. You’re under 18, so strangers can’t find you."
    : "Friends-only to start. Only people you accept see your loops.";
}

function renderPill() {
  pill.hidden = false;
  pill.textContent = me ? `@${me.handle}` : "Claim your @name";
  pill.classList.toggle("signed-in", Boolean(me));
}

async function refreshMe() {
  const res = await api("/irl/me", { method: "GET" });
  me = res.ok ? res.body : null;
  renderPill();
}

async function open() {
  if (!config) config = (await api("/irl/config", { method: "GET" })).body;
  if (!sheet.open) sheet.showModal();
  if (!config.accounts) return show("off");
  if (me) {
    $("account-handle").textContent = `@${me.handle}`;
    $("account-privacy").textContent = privacyLine(me);
    return show("account");
  }
  show("claim");
  if (config.turnstileSiteKey) mountTurnstile(config.turnstileSiteKey);
  client(); // start loading the passkey helper while they type
}

// ---- claim ---------------------------------------------------------------

function fillBirthday() {
  const month = $("birth-month");
  const year = $("birth-year");
  month.replaceChildren(new Option("Month", ""), ...MONTHS.map((m, i) => new Option(m, String(i + 1))));
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now; y >= now - 100; y--) years.push(new Option(String(y), String(y)));
  year.replaceChildren(new Option("Year", ""), ...years);
}

let checkTimer = 0;
let checkSeq = 0;
$("handle").addEventListener("input", () => {
  const note = $("handle-note");
  const local = checkHandle($("handle").value);
  note.dataset.state = "";
  if (!$("handle").value) {
    note.textContent = "3–20 letters, numbers, _ or .";
    return;
  }
  if (!local.ok) {
    note.textContent = local.reason;
    note.dataset.state = "bad";
    return;
  }
  note.textContent = "Checking…";
  clearTimeout(checkTimer);
  const seq = ++checkSeq;
  checkTimer = setTimeout(async () => {
    const res = await api("/irl/check-handle", { method: "POST", body: JSON.stringify({ handle: local.handle }) });
    if (seq !== checkSeq) return;
    if (res.ok && res.body.available) {
      note.textContent = `@${res.body.handle} is yours.`;
      note.dataset.state = "good";
    } else {
      note.textContent = res.body.reason ?? res.body.message ?? "Couldn’t check that name. Try again.";
      note.dataset.state = "bad";
    }
  }, 300);
});

$("claim-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("claim-error");
  error.textContent = "";
  const local = checkHandle($("handle").value);
  const birthMonth = Number($("birth-month").value);
  const birthYear = Number($("birth-year").value);
  if (!local.ok) return (error.textContent = local.reason);
  if (!birthMonth || !birthYear) return (error.textContent = "Add your birthday.");
  if (!$("accept-rules").checked) return (error.textContent = "Please agree to the community rules.");
  if (config.turnstileSiteKey && !turnstileToken) return (error.textContent = "One moment: checking you’re not a bot.");
  const button = $("claim-continue");
  button.disabled = true;
  const res = await api("/irl/claim", {
    method: "POST",
    headers: turnstileToken ? { "x-captcha-response": turnstileToken } : {},
    body: JSON.stringify({ handle: local.handle, displayName: $("display-name").value, birthMonth, birthYear, acceptRules: true }),
  });
  button.disabled = false;
  if (!res.ok) {
    error.textContent = res.body.message ?? "Something went wrong. Try again.";
    window.turnstile?.reset?.();
    turnstileToken = null;
    return;
  }
  claim = res.body;
  $("save-handle").textContent = `@${claim.handle}`;
  $("save-teen").hidden = !claim.teen;
  $("save-error").textContent = "";
  show("save");
});

// ---- passkeys --------------------------------------------------------------

function passkeyMessage(error) {
  const text = error?.message ?? "";
  if (/abort|cancel|not allowed|timed out/i.test(text) || error?.code === "ERROR_CEREMONY_ABORTED") return "Cancelled. Try again when you’re ready.";
  return text || "That didn’t work. Try again.";
}

$("save-passkey").addEventListener("click", async () => {
  const button = $("save-passkey");
  $("save-error").textContent = "";
  button.disabled = true;
  try {
    const auth = await client();
    const { error } = await auth.passkey.addPasskey({ context: claim.claim, createSession: true, authenticatorAttachment: "platform" });
    if (error) throw error;
    await refreshMe();
    $("done-handle").textContent = `@${me.handle}`;
    $("done-privacy").textContent = privacyLine(me);
    show("done");
  } catch (error) {
    $("save-error").textContent = passkeyMessage(error);
  } finally {
    button.disabled = false;
  }
});

$("signin-passkey").addEventListener("click", async () => {
  const button = $("signin-passkey");
  $("signin-error").textContent = "";
  button.disabled = true;
  try {
    const auth = await client();
    const { error } = await auth.signIn.passkey();
    if (error) throw error;
    await refreshMe();
    $("account-handle").textContent = `@${me.handle}`;
    $("account-privacy").textContent = privacyLine(me);
    show("account");
  } catch (error) {
    $("signin-error").textContent = passkeyMessage(error);
  } finally {
    button.disabled = false;
  }
});

// ---- signed in ----------------------------------------------------------------

async function invite() {
  const url = `${location.origin}/?from=${encodeURIComponent(me?.handle ?? "")}`;
  const text = `I’m on irl.ing as @${me?.handle}. Six seconds of real life, no filters.`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "irl.ing", text, url });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  await navigator.clipboard?.writeText(`${text} ${url}`).catch(() => {});
  const status = $("status");
  if (status) status.textContent = "Invite link copied.";
}

$("sign-out").addEventListener("click", async () => {
  await api("/sign-out", { method: "POST", body: "{}" });
  me = null;
  renderPill();
  sheet.close();
});

$("delete-account").addEventListener("click", async () => {
  const error = $("delete-error");
  error.textContent = "";
  const res = await api("/irl/delete-account", { method: "POST", body: JSON.stringify({ confirmHandle: $("delete-confirm").value }) });
  if (!res.ok) {
    error.textContent =
      res.status === 403 || /fresh/i.test(res.body.message ?? "")
        ? "For safety, sign out and sign back in, then delete within 10 minutes."
        : (res.body.message ?? "Couldn’t delete. Try again.");
    return;
  }
  me = null;
  renderPill();
  show("claim");
  sheet.close();
  const status = $("status");
  if (status) status.textContent = "Your account is gone.";
});

// ---- bot check (only when Turnstile keys are configured) ------------------

function mountTurnstile(siteKey) {
  if (document.getElementById("turnstile-script")) return;
  window.onIrlTurnstile = () =>
    window.turnstile.render("#turnstile", { sitekey: siteKey, action: "claim", callback: (token) => (turnstileToken = token) });
  const script = document.createElement("script");
  script.id = "turnstile-script";
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onIrlTurnstile&render=explicit";
  script.async = true;
  document.head.append(script);
}

// ---- wiring ---------------------------------------------------------------------

pill.addEventListener("click", open);
$("sheet-close").addEventListener("click", () => sheet.close());
$("to-signin").addEventListener("click", () => show("signin"));
$("to-claim").addEventListener("click", () => show("claim"));
$("invite").addEventListener("click", invite);
$("invite-2").addEventListener("click", invite);
$("done-close").addEventListener("click", () => sheet.close());
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) sheet.close(); // tap outside the sheet
});

fillBirthday();
api("/irl/config", { method: "GET" })
  .then(async (res) => {
    config = res.body;
    // No button at all until accounts are switched on: no dead ends.
    if (config.accounts) await refreshMe();
  })
  .catch(() => {});
