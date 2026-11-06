import test from "node:test";
import assert from "node:assert/strict";
import { adminHandles, adultFrom, findDatabaseUrl, getAuth, requireUserVerified, settings } from "../src/server/auth.js";

test("passkeys must come with the fingerprint, face or screen-lock check", () => {
  assert.doesNotThrow(() => requireUserVerified({ userVerified: true }));
  for (const info of [{ userVerified: false }, {}, undefined, { userVerified: "true" }]) {
    assert.throws(() => requireUserVerified(info), /fingerprint, face or screen lock/);
  }
});

test("accounts stay off until the database and secret are set", () => {
  assert.equal(getAuth({}), null);
  assert.equal(getAuth({ DATABASE_URL: "postgres://x" }), null);
  assert.equal(getAuth({ BETTER_AUTH_SECRET: "s" }), null);
});

test("the passkey domain follows the deployment", () => {
  assert.equal(settings({ VERCEL_ENV: "production" }).rpID, "irl.ing");
  assert.equal(settings({ VERCEL_ENV: "preview", VERCEL_URL: "irl-abc-bobdev1.vercel.app" }).baseURL, "https://irl-abc-bobdev1.vercel.app");
  assert.equal(settings({}).baseURL, "http://localhost:3004");
  assert.equal(settings({ BETTER_AUTH_URL: "https://irl.ing", VERCEL_URL: "x.vercel.app" }).rpID, "irl.ing");
});

test("only the month someone turns 18 is kept, counted cautiously", () => {
  assert.equal(adultFrom(3, 2010), "2028-04");
  assert.equal(adultFrom(12, 2010), "2029-01");
});

test("the database is found under Neon's plain or prefixed names, always pooled", () => {
  assert.equal(findDatabaseUrl({ DATABASE_URL: "plain" }), "plain");
  assert.equal(findDatabaseUrl({ POSTGRES_URL: "vercel" }), "vercel");
  assert.equal(findDatabaseUrl({ irl_POSTGRES_URL: "pooled", irl_POSTGRES_URL_NON_POOLING: "direct", irl_POSTGRES_HOST: "h" }), "pooled");
  assert.equal(findDatabaseUrl({ irl_DATABASE_URL: "db", irl_POSTGRES_URL: "pg" }), "db");
  assert.equal(findDatabaseUrl({ irl_DATABASE_URL_UNPOOLED: "direct" }), "");
  assert.equal(findDatabaseUrl({ DATABASE_URL: "plain", irl_POSTGRES_URL: "prefixed" }), "plain");
  assert.equal(settings({ irl_POSTGRES_URL: "pooled", BETTER_AUTH_SECRET: "s" }).configured, true);
});

test("reviewers are listed by @name", () => {
  assert.deepEqual(adminHandles(" @Rev.One, mod_two ,,"), ["rev.one", "mod_two"]);
  assert.deepEqual(adminHandles(undefined), []);
});
