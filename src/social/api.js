// Talking to the irl.ing API from the social screens: one fetch helper that
// always comes back with a message to show, passkey sign-in, and the bits
// of page chrome the three screens share (a status line and the wordmark).

const API = "/api/auth";

const FALLBACK = {
  0: "You’re offline. Try again.",
  429: "Too many tries. Wait a minute and try again.",
};

/**
 * GET when `body` is undefined, otherwise POST it as JSON.
 * Resolves to { ok, status, body, message }; never throws. `message` is the
 * server's own message when it sent one.
 */
export async function api(path, body) {
  let res;
  try {
    res = await fetch(
      `${API}${path}`,
      body === undefined
        ? { credentials: "same-origin", headers: { accept: "application/json" } }
        : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    return { ok: false, status: 0, body: {}, message: FALLBACK[0] };
  }
  const data = (await res.json().catch(() => null)) ?? {};
  return { ok: res.ok, status: res.status, body: data, message: data.message || FALLBACK[res.status] || "Something went wrong. Try again." };
}

/** The signed-in account ({ handle, ... }), or null with the reason. */
export async function whoAmI() {
  const res = await api("/irl/me");
  return res.ok ? { me: res.body } : { me: null, signedOut: res.status === 401, message: res.message };
}

let clientPromise = null;
/** The Better Auth client with passkeys, loaded only when needed. */
export function authClient() {
  clientPromise ??= Promise.all([import("better-auth/client"), import("@better-auth/passkey/client")]).then(([{ createAuthClient }, { passkeyClient }]) =>
    createAuthClient({ baseURL: `${location.origin}${API}`, plugins: [passkeyClient()] }),
  );
  return clientPromise;
}

/** Sign in with a passkey. Resolves to null, or a message to show. */
export async function signIn() {
  try {
    const auth = await authClient();
    const { error } = await auth.signIn.passkey();
    if (error) throw error;
    return null;
  } catch (error) {
    const text = error?.message ?? "";
    if (/abort|cancel|not allowed|timed out/i.test(text) || error?.code === "ERROR_CEREMONY_ABORTED") return "That was cancelled. Try again when you’re ready.";
    return text || "That didn’t work. Try again.";
  }
}

/** "@name" for a handle that may or may not carry its @. */
export const at = (handle) => `@${String(handle ?? "").replace(/^@/, "")}`;

let toastTimer = 0;
/**
 * A short message in the page's status line, read out by screen readers.
 * The line is always in the page (empty when quiet) so announcements land.
 */
export function toast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = text;
  if (text) toastTimer = setTimeout(() => (el.textContent = ""), 6000);
}

/** Build an element: h("p", { class: "note" }, "text", child). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

/** The three dots on a menu button. */
export function dotsIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/>';
  return svg;
}

/** Disable a button while `work` runs. */
export async function busy(button, work) {
  button.disabled = true;
  try {
    return await work();
  } finally {
    button.disabled = false;
  }
}
