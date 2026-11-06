import test from "node:test";
import assert from "node:assert/strict";
import { deleteUserLoops } from "../src/server/social.js";

const id = "b".repeat(64);

test("deleting an account removes its loop files, but never escalations", async () => {
  const queries = [];
  const db = {
    async query(text, values) {
      queries.push({ text, values });
      return { rows: text.startsWith("select") ? [{ id }] : [] };
    },
  };
  const removed = [];
  const storage = { remove: async (key) => removed.push(key) };
  assert.equal(await deleteUserLoops(db, storage, "u1"), 1);
  assert.deepEqual(removed, [`loops/${id}.irl`, `thumbs/${id}-0.jpg`, `thumbs/${id}-1.jpg`, `thumbs/${id}-2.jpg`]);
  assert.ok(queries.every((q) => /not "escalated"/.test(q.text)));
});

test("account deletion still works before the social tables exist", async () => {
  const db = { query: async () => Promise.reject(Object.assign(new Error('relation "irl_loop" does not exist'), { code: "42P01" })) };
  assert.equal(await deleteUserLoops(db, null, "u1"), 0);
  const broken = { query: async () => Promise.reject(Object.assign(new Error("connection lost"), { code: "57P01" })) };
  await assert.rejects(deleteUserLoops(broken, null, "u1"), /connection lost/);
});
