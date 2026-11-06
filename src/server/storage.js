// Private loop storage. In production: Cloudflare R2 through its S3 API,
// with short-lived signed links (SigV4 query signing via aws4fetch), so
// phones upload and play directly while every object stays private. For
// local development and tests: a directory on disk with HMAC-signed links
// served by scripts/serve-local.mjs. Both expose the same interface:
//   presign(method, key, seconds) → URL     get(key) → Uint8Array | null
//   put(key, bytes)                          remove(key)
//
// Environment (production):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Environment (local only, never in production):
//   LOCAL_STORAGE_DIR

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { AwsClient } from "aws4fetch";

export const LIMITS = { loopBytes: 512 * 1024, thumbBytes: 160 * 1024, thumbs: 3 };

/** Object keys for a loop: the .irl file and its three still frames. */
export const keys = {
  loop: (id) => `loops/${id}.irl`,
  thumb: (id, n) => `thumbs/${id}-${n}.jpg`,
  all: (id) => [`loops/${id}.irl`, ...[0, 1, 2].map((n) => `thumbs/${id}-${n}.jpg`)],
};

const SAFE_KEY = /^(loops\/[0-9a-f]{64}\.irl|thumbs\/[0-9a-f]{64}-[0-2]\.jpg)$/;

function checkKey(key) {
  if (!SAFE_KEY.test(key)) throw new Error(`refusing storage key ${key}`);
  return key;
}

export function r2Storage({ accountId, accessKeyId, secretAccessKey, bucket }) {
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const urlFor = (key) => `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${checkKey(key)}`;
  return {
    kind: "r2",
    async presign(method, key, seconds = 600) {
      const url = new URL(urlFor(key));
      url.searchParams.set("X-Amz-Expires", String(seconds));
      const signed = await aws.sign(new Request(url, { method }), { aws: { signQuery: true } });
      return signed.url;
    },
    async get(key) {
      const res = await aws.fetch(urlFor(key));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage read failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async put(key, bytes) {
      const res = await aws.fetch(urlFor(key), { method: "PUT", body: bytes });
      if (!res.ok) throw new Error(`storage write failed (${res.status})`);
    },
    async remove(key) {
      const res = await aws.fetch(urlFor(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`storage delete failed (${res.status})`);
    },
  };
}

/** Disk storage for local runs. Links are signed with HMAC and expire. */
export function diskStorage({ dir, baseURL, secret }) {
  const pathFor = (key) => join(dir, normalize(checkKey(key)));
  const sign = (method, key, exp) => createHmac("sha256", secret).update(`${method}\n${key}\n${exp}`).digest("hex");
  return {
    kind: "local",
    async presign(method, key, seconds = 600) {
      const exp = Math.floor(Date.now() / 1000) + seconds;
      return `${baseURL}/api/dev-storage/${checkKey(key)}?exp=${exp}&sig=${sign(method, key, exp)}`;
    },
    /** Used by the local server to check an incoming signed request. */
    verify(method, key, exp, sig) {
      if (!SAFE_KEY.test(key) || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
      const expected = Buffer.from(sign(method, key, exp), "hex");
      const given = Buffer.from(String(sig), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async put(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

/** The configured storage, or null when loop sharing isn't switched on. */
export function getStorage(env = process.env, { baseURL, secret } = {}) {
  if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET) {
    return r2Storage({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
    });
  }
  if (env.LOCAL_STORAGE_DIR && env.VERCEL_ENV !== "production" && baseURL && secret) {
    return diskStorage({ dir: env.LOCAL_STORAGE_DIR, baseURL, secret });
  }
  return null;
}
