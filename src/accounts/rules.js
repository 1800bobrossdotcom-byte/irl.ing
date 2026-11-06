// Account rules shared by the signup screens and, later, the server.
// The server must enforce every one of these itself; the client copy only
// gives instant feedback.

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const MIN_AGE = 13;
export const ADULT_AGE = 18;

// Names that would let someone impersonate the app, its staff or its pages.
export const RESERVED_HANDLES = new Set([
  "about", "account", "accounts", "admin", "administrator", "api", "app", "help", "irl", "irling", "irl_ing", "loop",
  "loops", "mod", "moderator", "moderators", "news", "official", "privacy", "root", "rules", "safety", "security",
  "settings", "signin", "signup", "staff", "support", "system", "team", "terms", "www",
]);

/** Lower-case and trim what someone typed, dropping a leading @. */
export function normalizeHandle(input) {
  return String(input ?? "").trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Check a handle. Returns { ok: true, handle } or { ok: false, reason }.
 * Allowed: 3–20 of a–z, 0–9, _ and . ; starts with a letter; no "..";
 * doesn't end with "." .
 */
export function checkHandle(input) {
  const handle = normalizeHandle(input);
  if (handle.length < HANDLE_MIN) return { ok: false, reason: `At least ${HANDLE_MIN} characters.` };
  if (handle.length > HANDLE_MAX) return { ok: false, reason: `At most ${HANDLE_MAX} characters.` };
  if (!/^[a-z]/.test(handle)) return { ok: false, reason: "Start with a letter." };
  if (!/^[a-z0-9_.]+$/.test(handle)) return { ok: false, reason: "Letters, numbers, _ and . only." };
  if (handle.includes("..") || handle.endsWith(".")) return { ok: false, reason: "No double dots, and no dot at the end." };
  if (RESERVED_HANDLES.has(handle) || RESERVED_HANDLES.has(handle.replace(/[_.]/g, ""))) return { ok: false, reason: "That name is reserved." };
  return { ok: true, handle };
}

/**
 * Whole years of age from a birth month (1–12) and year, counting the
 * birthday as not yet reached during the birth month itself (the cautious
 * reading when there's no day).
 */
export function ageFrom(birthMonth, birthYear, now = new Date()) {
  const month = now.getUTCMonth() + 1;
  let age = now.getUTCFullYear() - birthYear;
  if (month <= birthMonth) age -= 1;
  return age;
}

/**
 * Who may join, and how their account starts out. Everyone starts
 * friends-only ("friends before followers"); under-18s can't be found by
 * strangers at all.
 */
export function accountDefaults(age) {
  if (!Number.isFinite(age) || age < MIN_AGE) return { allowed: false };
  const teen = age < ADULT_AGE;
  return { allowed: true, teen, visibility: "friends", discoverable: !teen, canBecomeDiscoverable: !teen };
}

/** Basic shape check before sending a code; the code itself proves the address. */
export function checkEmail(input) {
  const email = String(input ?? "").trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return { ok: false, reason: "That doesn’t look like an email address." };
  return { ok: true, email };
}

/** Six digits, as typed or pasted (spaces and dashes allowed). */
export function normalizeCode(input) {
  const digits = String(input ?? "").replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** The current month as "YYYY-MM" (UTC), the same shape as an account's adultFrom. */
export function monthOf(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Whether an account is still under 18, given the month it turns 18 ("YYYY-MM"). */
export function isTeenNow(adultFrom, now = new Date()) {
  return Boolean(adultFrom) && monthOf(now) < adultFrom;
}
