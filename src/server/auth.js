// irl.ing accounts: Better Auth on Postgres (Neon in production).
//
// Sign-up is passkey first and password free:
//   1. POST /api/auth/irl/claim checks the @handle, age and rules, and holds
//      the claim for 15 minutes. Nothing about the person is stored if they
//      can't join.
//   2. The passkey plugin registers a passkey against that claim (context),
//      and only after the phone's fingerprint/face/screen-lock check passes
//      is the account created, in the same transaction as the passkey and
//      the first session.
// Signing in is a passkey too. Every rule here is enforced on the server; the
// browser's copy of src/accounts/rules.js only gives instant feedback.
//
// Environment:
//   DATABASE_URL (or POSTGRES_URL)  Postgres connection string (Neon pooled)
//   BETTER_AUTH_SECRET              32+ random bytes, e.g. `openssl rand -base64 32`
//   BETTER_AUTH_URL                 optional; defaults to https://irl.ing in production,
//                                   the deployment URL on Vercel previews
//   TURNSTILE_SECRET_KEY / TURNSTILE_SITE_KEY  optional bot check on claims
//
// Loop sharing (friends, feed, safety review) also needs storage and a
// reviewer; until both are set, /irl/config reports sharing: false:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   see storage.js
//   ANTHROPIC_API_KEY (optional MODERATION_MODEL)                      see moderation.js
//   ADMIN_HANDLES                   comma-separated @names allowed to review

import { randomUUID } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint, freshSessionMiddleware, getSessionFromCtx, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { captcha } from "better-auth/plugins/captcha";
import * as z from "zod";
import { accountDefaults, ageFrom, checkHandle, isTeenNow, normalizeHandle } from "../accounts/rules.js";
import { getPool } from "./db.js";
import { getJudge, missingJudgeEnv } from "./moderation.js";
import { deleteUserLoops, social } from "./social.js";
import { getStorage, missingStorageEnv } from "./storage.js";

const CLAIM_MINUTES = 15;
const claimKey = (id) => `irl-claim:${id}`;

/**
 * The pooled Postgres connection string. Neon's Vercel integration names it
 * DATABASE_URL / POSTGRES_URL, or <prefix>_DATABASE_URL / <prefix>_POSTGRES_URL
 * when a custom prefix was chosen (this project uses "irl_"). The
 * *_NON_POOLING / *_UNPOOLED variants are never picked: serverless functions
 * should go through Neon's pooler.
 */
export function findDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  for (const suffix of ["_DATABASE_URL", "_POSTGRES_URL"]) {
    const name = Object.keys(env)
      .filter((key) => key.endsWith(suffix) && /^[A-Za-z0-9]+_(DATABASE|POSTGRES)_URL$/.test(key) && env[key])
      .sort()[0];
    if (name) return env[name];
  }
  return "";
}

export function settings(env = process.env) {
  const databaseUrl = findDatabaseUrl(env);
  const secret = env.BETTER_AUTH_SECRET || "";
  const baseURL =
    env.BETTER_AUTH_URL ||
    (env.VERCEL_ENV === "production" ? "https://irl.ing" : env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "http://localhost:3004");
  return {
    databaseUrl,
    secret,
    baseURL,
    rpID: new URL(baseURL).hostname,
    turnstile: env.TURNSTILE_SECRET_KEY ? { secretKey: env.TURNSTILE_SECRET_KEY, siteKey: env.TURNSTILE_SITE_KEY || "" } : null,
    configured: Boolean(databaseUrl && secret),
  };
}

/** The month someone turns 18, as "YYYY-MM", counting cautiously (see ageFrom). */
export function adultFrom(birthMonth, birthYear) {
  const month = birthMonth + 1;
  return month > 12 ? `${birthYear + 19}-01` : `${birthYear + 18}-${String(month).padStart(2, "0")}`;
}

/** Public view of an account: never the placeholder email or birth data. */
function publicAccount(user) {
  return {
    handle: user.handle,
    name: user.name,
    visibility: user.visibility,
    discoverable: user.discoverable && !isTeenNow(user.adultFrom),
    teen: isTeenNow(user.adultFrom),
  };
}

async function handleTaken(ctx, handle) {
  const existing = await ctx.context.adapter.findOne({ model: "user", where: [{ field: "handle", value: handle }] });
  return Boolean(existing);
}

/** irl.ing's own endpoints, mounted under /api/auth/irl/*. */
function irlAccounts(s, { db, storage, sharing, sharingMissing }) {
  return {
    id: "irl-accounts",
    endpoints: {
      irlConfig: createAuthEndpoint("/irl/config", { method: "GET" }, async (ctx) =>
        ctx.json({
          accounts: true,
          turnstileSiteKey: s.turnstile?.siteKey || null,
          passkeys: true,
          sharing,
          // Off production only: which settings sharing still needs (names, never values).
          ...(sharingMissing ? { sharingMissing } : {}),
        }),
      ),
      irlCheckHandle: createAuthEndpoint(
        "/irl/check-handle",
        { method: "POST", body: z.object({ handle: z.string().max(64) }) },
        async (ctx) => {
          const check = checkHandle(ctx.body.handle);
          if (!check.ok) return ctx.json({ available: false, reason: check.reason });
          if (await handleTaken(ctx, check.handle)) return ctx.json({ available: false, reason: "That name is taken." });
          return ctx.json({ available: true, handle: check.handle });
        },
      ),
      irlClaim: createAuthEndpoint(
        "/irl/claim",
        {
          method: "POST",
          body: z.object({
            handle: z.string().max(64),
            displayName: z.string().max(40).optional(),
            birthMonth: z.number().int().min(1).max(12),
            birthYear: z.number().int().min(1900).max(3000),
            acceptRules: z.literal(true),
          }),
        },
        async (ctx) => {
          const { body } = ctx;
          const age = ageFrom(body.birthMonth, body.birthYear);
          const defaults = accountDefaults(age);
          if (!defaults.allowed) throw new APIError("FORBIDDEN", { message: "irl.ing is for people 13 and up." });
          const check = checkHandle(body.handle);
          if (!check.ok) throw new APIError("BAD_REQUEST", { message: check.reason });
          if (await handleTaken(ctx, check.handle)) throw new APIError("CONFLICT", { message: "That name is taken." });
          const id = randomUUID();
          const displayName = (body.displayName ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: claimKey(id),
            value: JSON.stringify({
              handle: check.handle,
              displayName,
              adultFrom: adultFrom(body.birthMonth, body.birthYear),
              visibility: defaults.visibility,
              discoverable: defaults.discoverable,
              webauthnUserId: randomUUID(),
            }),
            expiresAt: new Date(Date.now() + CLAIM_MINUTES * 60_000),
          });
          return ctx.json({ claim: id, handle: check.handle, teen: defaults.teen });
        },
      ),
      irlMe: createAuthEndpoint("/irl/me", { method: "GET", use: [sessionMiddleware] }, async (ctx) =>
        ctx.json(publicAccount(ctx.context.session.user)),
      ),
      irlDeleteAccount: createAuthEndpoint(
        "/irl/delete-account",
        { method: "POST", use: [freshSessionMiddleware], body: z.object({ confirmHandle: z.string() }) },
        async (ctx) => {
          const user = ctx.context.session.user;
          if (normalizeHandle(ctx.body.confirmHandle) !== user.handle) throw new APIError("BAD_REQUEST", { message: "Type your @name to confirm." });
          await deleteUserLoops(db, storage, user.id);
          await ctx.context.adapter.deleteMany({ model: "passkey", where: [{ field: "userId", value: user.id }] });
          await ctx.context.adapter.deleteMany({ model: "session", where: [{ field: "userId", value: user.id }] });
          await ctx.context.internalAdapter.deleteUser(user.id);
          deleteSessionCookie(ctx);
          return ctx.json({ deleted: true });
        },
      ),
    },
  };
}

async function readClaim(ctx, id, { consume = false } = {}) {
  if (!id) return null;
  const row = consume
    ? await ctx.context.internalAdapter.consumeVerificationValue(claimKey(id))
    : await ctx.context.internalAdapter.findVerificationValue(claimKey(id));
  if (!row || new Date(row.expiresAt) < new Date()) return null;
  return JSON.parse(row.value);
}

const NEED_VERIFICATION = "Use your fingerprint, face or screen lock to save your passkey.";

/**
 * The passkey plugin accepts ceremonies without user verification; irl.ing
 * doesn't. Throws unless the authenticator confirmed the person (fingerprint,
 * face or screen lock), for registration and sign-in alike.
 */
export function requireUserVerified(info, status = "BAD_REQUEST") {
  if (info?.userVerified !== true) throw new APIError(status, { message: NEED_VERIFICATION });
}

/** Comma-separated @names allowed to use the review queue. */
export function adminHandles(value = "") {
  return value.split(",").map(normalizeHandle).filter(Boolean);
}

export function buildOptions(s = settings(), env = process.env) {
  const pool = getPool(s.databaseUrl);
  const storage = getStorage(env, { baseURL: s.baseURL, secret: s.secret });
  const judge = getJudge(env);
  const sharing = Boolean(storage && judge);
  const sharingMissing = !sharing && env.VERCEL_ENV !== "production" ? [...missingStorageEnv(env), ...missingJudgeEnv(env)] : null;
  return {
    appName: "irl.ing",
    baseURL: s.baseURL,
    basePath: "/api/auth",
    secret: s.secret,
    database: pool,
    trustedOrigins: [s.baseURL],
    emailAndPassword: { enabled: false },
    user: {
      modelName: "irl_user",
      additionalFields: {
        handle: { type: "string", required: false, unique: true, input: false },
        visibility: { type: "string", required: false, defaultValue: "friends", input: false },
        discoverable: { type: "boolean", required: false, defaultValue: false, input: false },
        adultFrom: { type: "string", required: false, input: false },
      },
    },
    session: { modelName: "irl_session", expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24, freshAge: 60 * 10 },
    account: { modelName: "irl_account" },
    verification: { modelName: "irl_verification" },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "irl_rate_limit",
      window: 60,
      max: 60,
      customRules: {
        "/irl/check-handle": { window: 60, max: 40 },
        "/irl/claim": { window: 600, max: 10 },
        "/passkey/generate-register-options": { window: 600, max: 20 },
        "/passkey/verify-registration": { window: 600, max: 20 },
        "/passkey/generate-authenticate-options": { window: 60, max: 20 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
        "/irl/delete-account": { window: 600, max: 5 },
        "/irl/friends/request": { window: 600, max: 30 },
        "/irl/invites": { window: 3600, max: 20 },
        "/irl/invite": { window: 60, max: 20 },
        "/irl/invites/accept": { window: 600, max: 20 },
        "/irl/block": { window: 600, max: 30 },
        "/irl/loops/share": { window: 600, max: 20 },
        "/irl/report": { window: 600, max: 20 },
      },
    },
    advanced: {
      cookiePrefix: "irl",
      useSecureCookies: s.baseURL.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
    },
    plugins: [
      passkey({
        rpID: s.rpID,
        rpName: "irl.ing",
        origin: s.baseURL,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        schema: { passkey: { modelName: "irl_passkey" } },
        registration: {
          requireSession: false,
          async resolveUser({ ctx, context }) {
            const claim = await readClaim(ctx, context);
            if (!claim) throw new APIError("BAD_REQUEST", { message: "That claim expired. Pick your @name again." });
            return { id: claim.webauthnUserId, name: claim.handle, displayName: claim.displayName || claim.handle };
          },
          async afterVerification({ ctx, verification, context }) {
            // The plugin doesn't insist on user verification; we do.
            requireUserVerified(verification.registrationInfo);
            const session = await getSessionFromCtx(ctx);
            if (session) return { name: "irl.ing" }; // adding a passkey to a signed-in account
            const claim = await readClaim(ctx, context, { consume: true });
            if (!claim) throw new APIError("BAD_REQUEST", { message: "That claim expired. Pick your @name again." });
            if (await handleTaken(ctx, claim.handle)) throw new APIError("CONFLICT", { message: "That name was just taken. Pick another." });
            const user = await ctx.context.internalAdapter.createUser({
              name: claim.displayName || claim.handle,
              // Passkey-only accounts have no email; this address can never receive mail.
              email: `${randomUUID()}@passkey.irl.invalid`,
              emailVerified: false,
              handle: claim.handle,
              visibility: claim.visibility,
              discoverable: claim.discoverable,
              adultFrom: claim.adultFrom,
            });
            return { userId: user.id, name: "irl.ing" };
          },
        },
        authentication: {
          async afterVerification({ verification }) {
            requireUserVerified(verification.authenticationInfo, "UNAUTHORIZED");
          },
        },
      }),
      irlAccounts(s, { db: pool, storage, sharing, sharingMissing }),
      social({ db: pool, storage, judge, admins: adminHandles(env.ADMIN_HANDLES), baseURL: s.baseURL }),
      ...(s.turnstile ? [captcha({ provider: "cloudflare-turnstile", secretKey: s.turnstile.secretKey, endpoints: ["/irl/claim"] })] : []),
    ],
  };
}

let cached = null;
/** The auth instance, or null when the environment isn't set up yet. */
export function getAuth(env = process.env) {
  const s = settings(env);
  if (!s.configured) return null;
  if (!cached) cached = betterAuth(buildOptions(s));
  return cached;
}
