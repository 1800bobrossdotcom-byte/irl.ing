import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskStorage, getStorage, keys, missingStorageEnv, r2Storage } from "../src/server/storage.js";

const id = "a".repeat(64);

test("R2 links are signed, expiring, and point at the private bucket", async () => {
  const r2 = r2Storage({ accountId: "acct123", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", bucket: "irl-loops" });
  const put = new URL(await r2.presign("PUT", keys.loop(id), 300));
  assert.equal(put.host, "acct123.r2.cloudflarestorage.com");
  assert.equal(put.pathname, `/irl-loops/loops/${id}.irl`);
  assert.equal(put.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(put.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.match(put.searchParams.get("X-Amz-Credential"), /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.match(put.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  const get = new URL(await r2.presign("GET", keys.loop(id), 300));
  assert.notEqual(get.searchParams.get("X-Amz-Signature"), put.searchParams.get("X-Amz-Signature"), "method is part of the signature");
});

test("only loop and still-frame keys can be signed", async () => {
  const r2 = r2Storage({ accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "b" });
  for (const bad of ["../secrets", `loops/${id}.irl/../x`, "loops/abc.irl", `thumbs/${id}-3.jpg`, ""]) {
    await assert.rejects(r2.presign("GET", bad), /refusing storage key/, bad);
  }
  assert.deepEqual(keys.all(id), [`loops/${id}.irl`, `thumbs/${id}-0.jpg`, `thumbs/${id}-1.jpg`, `thumbs/${id}-2.jpg`]);
});

test("disk storage round-trips and its links verify only as issued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "irl-storage-"));
  try {
    const disk = diskStorage({ dir, baseURL: "http://localhost:3004", secret: "s3cret" });
    await disk.put(keys.thumb(id, 1), new Uint8Array([1, 2, 3]));
    assert.deepEqual(await disk.get(keys.thumb(id, 1)), new Uint8Array([1, 2, 3]));
    assert.equal(await disk.get(keys.loop(id)), null);
    const url = new URL(await disk.presign("PUT", keys.loop(id), 60));
    const [exp, sig] = [url.searchParams.get("exp"), url.searchParams.get("sig")];
    assert.equal(disk.verify("PUT", keys.loop(id), exp, sig), true);
    assert.equal(disk.verify("GET", keys.loop(id), exp, sig), false, "a PUT link can't be used to read");
    assert.equal(disk.verify("PUT", keys.thumb(id, 0), exp, sig), false, "a link is for one object");
    assert.equal(disk.verify("PUT", keys.loop(id), String(Number(exp) + 999), sig), false, "expiry can't be extended");
    assert.equal(disk.verify("PUT", keys.loop(id), "1", sig), false, "expired links fail");
    await disk.remove(keys.thumb(id, 1));
    assert.equal(await disk.get(keys.thumb(id, 1)), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sharing is off without storage; disk storage never runs in production", () => {
  assert.equal(getStorage({}), null);
  const opts = { baseURL: "http://x", secret: "s" };
  assert.equal(getStorage({ LOCAL_STORAGE_DIR: "/tmp/x", VERCEL_ENV: "production" }, opts), null);
  assert.equal(getStorage({ LOCAL_STORAGE_DIR: "/tmp/x" }, opts).kind, "local");
  assert.equal(getStorage({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b" }).kind, "r2");
});

test("a preview can say which storage settings are missing, by name only", () => {
  assert.deepEqual(missingStorageEnv({}), ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]);
  assert.deepEqual(missingStorageEnv({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: " ", R2_BUCKET: "b" }), ["R2_SECRET_ACCESS_KEY"]);
  assert.deepEqual(missingStorageEnv({ LOCAL_STORAGE_DIR: "/tmp/x" }), []);
});
