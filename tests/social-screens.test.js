import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPORT_LABELS, REPORT_REASONS } from "../src/social/reasons.js";

test("the report menu offers exactly the server's reasons, in plain words", () => {
  const source = readFileSync(new URL("../src/server/social.js", import.meta.url), "utf8");
  assert.match(source, /import \{ REPORT_REASONS \} from "\.\.\/social\/reasons\.js";/, "the server uses the same list");
  assert.deepEqual(REPORT_REASONS, ["child_safety", "sexual", "violence", "self_harm", "hate", "harassment", "privacy", "scam", "other"]);
  for (const label of Object.values(REPORT_LABELS)) assert.match(label, /^[A-Z][a-z -]+$/, label);
});

test("invite codes and hidden loops: remembered when storage works, harmless when it's blocked", async () => {
  const store = await import("../src/social/store.js");
  const blocked = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  globalThis.localStorage = { getItem: blocked, setItem: blocked, removeItem: blocked };
  store.savePendingInvite("abc");
  assert.equal(store.pendingInvite(), null);
  store.hideLoop("a".repeat(64));
  assert.equal(store.hiddenLoops().size, 0);

  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  store.savePendingInvite("abc");
  assert.equal(store.pendingInvite(), "abc");
  store.clearPendingInvite();
  assert.equal(store.pendingInvite(), null);
  for (let i = 0; i < 305; i++) store.hideLoop(`loop-${i}`);
  assert.equal(store.hiddenLoops().size, 300, "only the most recent reports are kept");
  assert.ok(store.hiddenLoops().has("loop-304"));
  kept.set("irl.hidden", "not json");
  assert.equal(store.hiddenLoops().size, 0);
  delete globalThis.localStorage;
});
