import test from "node:test";
import assert from "node:assert/strict";
import { accountDefaults, ageFrom, checkEmail, checkHandle, normalizeCode } from "../src/accounts/rules.js";

test("handles: friendly normalization and clear reasons", () => {
  assert.deepEqual(checkHandle("  @Gianni.Arone "), { ok: true, handle: "gianni.arone" });
  assert.deepEqual(checkHandle("sunset_loops"), { ok: true, handle: "sunset_loops" });
  assert.match(checkHandle("ab").reason, /At least 3/);
  assert.match(checkHandle("a".repeat(21)).reason, /At most 20/);
  assert.match(checkHandle("9lives").reason, /Start with a letter/);
  assert.match(checkHandle("hi there").reason, /Letters, numbers/);
  assert.match(checkHandle("emoji😀").reason, /Letters, numbers/);
  assert.match(checkHandle("a..b").reason, /double dots/);
  assert.match(checkHandle("abc.").reason, /double dots/);
});

test("handles that impersonate the app or staff are reserved, even disguised", () => {
  for (const name of ["admin", "Support", "irl_ing", "irl.ing", "irling", "mod"]) {
    assert.equal(checkHandle(name).ok, false, name);
    assert.match(checkHandle(name).reason, /reserved/, name);
  }
});

test("age counts the birth month cautiously", () => {
  const now = new Date(Date.UTC(2026, 10, 2)); // 2 November 2026
  assert.equal(ageFrom(10, 2013, now), 13); // birthday month passed
  assert.equal(ageFrom(11, 2013, now), 12); // birth month: not yet counted
  assert.equal(ageFrom(12, 2013, now), 12);
  assert.equal(ageFrom(1, 2008, now), 18);
});

test("under 13 can't join; teens start private and can't be found by strangers", () => {
  assert.deepEqual(accountDefaults(12), { allowed: false });
  assert.deepEqual(accountDefaults(Number.NaN), { allowed: false });
  assert.deepEqual(accountDefaults(13), { allowed: true, teen: true, visibility: "friends", discoverable: false, canBecomeDiscoverable: false });
  assert.deepEqual(accountDefaults(17).teen, true);
  assert.deepEqual(accountDefaults(18), { allowed: true, teen: false, visibility: "friends", discoverable: true, canBecomeDiscoverable: true });
});

test("emails and codes", () => {
  assert.deepEqual(checkEmail(" you@example.com "), { ok: true, email: "you@example.com" });
  for (const bad of ["you", "you@", "you@example", "@example.com", "a b@example.com"]) assert.equal(checkEmail(bad).ok, false, bad);
  assert.equal(normalizeCode("123 456"), "123456");
  assert.equal(normalizeCode("123-456"), "123456");
  assert.equal(normalizeCode("12345"), null);
  assert.equal(normalizeCode("12345a"), null);
});

test("teen status ends the month someone turns 18", async () => {
  const { isTeenNow, monthOf } = await import("../src/accounts/rules.js");
  assert.equal(monthOf(new Date(Date.UTC(2026, 10, 6))), "2026-11");
  assert.equal(isTeenNow("2026-12", new Date(Date.UTC(2026, 10, 30))), true);
  assert.equal(isTeenNow("2026-12", new Date(Date.UTC(2026, 11, 1))), false);
  assert.equal(isTeenNow(null), false);
  assert.equal(isTeenNow(""), false);
});
