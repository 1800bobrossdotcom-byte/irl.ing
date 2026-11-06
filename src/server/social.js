// irl.ing social endpoints, mounted under /api/auth/irl/* as a Better Auth
// plugin so they share its sessions, origin checks and rate limits.
//
//   Friends   GET /irl/friends · POST /irl/friends/request · /respond · /remove
//   Blocks    POST /irl/block · /irl/unblock
//   Invites   POST /irl/invites · GET /irl/invite?code= · POST /irl/invites/accept
//   Loops     POST /irl/loops/share · GET /irl/feed · GET /irl/loops/mine
//             POST /irl/loops/delete
//
// A shared loop comes to the server (at most 512 KB plus three ~20 KB still
// frames), which checks its Real Seal and runs the safety review before
// anything is stored. Playback uses short-lived signed links straight to
// private storage. Uploads don't use signed links because R2 can't cap an
// upload link's size.
//   Safety    POST /irl/report · GET /irl/admin/queue · POST /irl/admin/decide
//
// Friendship is mutual. Teens can't be found by @name: adults reach them only
// through a code or link the teen shared. Blocks always win. A loop is
// private until it has passed verification and safety review.

import { randomBytes } from "node:crypto";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import * as z from "zod";
import { isTeenNow, normalizeHandle } from "../accounts/rules.js";
import { parseLoop, verify } from "../loops/container.js";
import { query, transaction } from "./db.js";
import { keys, LIMITS } from "./storage.js";

const LINK_SECONDS = 600;
const INVITE_DAYS = 30;
const LOOPS_PER_DAY = 30;
const REPORTS_TO_HIDE = 3;
const STRIKES_TO_SUSPEND = 3;
const MAX_SECONDS = 6.5;
const LOOP_ID = /^[0-9a-f]{64}$/;
const REPORT_REASONS = ["child_safety", "sexual", "violence", "self_harm", "hate", "harassment", "privacy", "scam", "other"];

const NOT_FOUND = "No one by that @name.";
const pair = (a, b) => (a < b ? [a, b] : [b, a]);

const fail = (status, message) => new APIError(status, { message });

async function userByHandle(db, handle) {
  const [user] = await query(db, `select "id", "handle", "name", "discoverable", "adultFrom", "suspendedAt" from "irl_user" where "handle" = $1`, [
    normalizeHandle(handle),
  ]);
  return user ?? null;
}

async function blockedEitherWay(db, a, b) {
  const rows = await query(db, `select 1 from irl_block where ("blocker" = $1 and "blocked" = $2) or ("blocker" = $2 and "blocked" = $1)`, [a, b]);
  return rows.length > 0;
}

async function friendship(db, a, b) {
  const [low, high] = pair(a, b);
  const [row] = await query(db, `select * from irl_friendship where "userLow" = $1 and "userHigh" = $2`, [low, high]);
  return row ?? null;
}

async function makeFriends(db, a, b, requestedBy) {
  const [low, high] = pair(a, b);
  await query(
    db,
    `insert into irl_friendship ("userLow", "userHigh", "requestedBy", "status", "acceptedAt") values ($1, $2, $3, 'accepted', now())
     on conflict ("userLow", "userHigh") do update set "status" = 'accepted', "acceptedAt" = coalesce(irl_friendship."acceptedAt", now())`,
    [low, high, requestedBy],
  );
}

async function canSee(db, viewerId, loop) {
  if (!loop || loop.status !== "visible") return false;
  if (loop.owner === viewerId) return true;
  if (!loop.owner || (await blockedEitherWay(db, viewerId, loop.owner))) return false;
  const f = await friendship(db, viewerId, loop.owner);
  return f?.status === "accepted";
}

async function logEvent(db, { loopId = null, userId = null, actor, action, detail = null }) {
  await query(db, `insert into irl_moderation_event ("loopId", "userId", "actor", "action", "detail") values ($1, $2, $3, $4, $5)`, [
    loopId,
    userId,
    actor,
    action,
    detail && JSON.stringify(detail),
  ]);
}

async function addStrike(db, userId, loopId, reason) {
  if (!userId) return;
  await query(db, `insert into irl_strike ("userId", "loopId", "reason") values ($1, $2, $3)`, [userId, loopId, reason]);
  const [{ count }] = await query(db, `select count(*)::int as count from irl_strike where "userId" = $1`, [userId]);
  if (count >= STRIKES_TO_SUSPEND) {
    await query(db, `update "irl_user" set "suspendedAt" = coalesce("suspendedAt", now()) where "id" = $1`, [userId]);
    await logEvent(db, { userId, actor: "system", action: "suspended", detail: { strikes: count } });
  }
}

/** Remove a user's loops and their objects, keeping child-safety escalations (the law requires preserving them). */
export async function deleteUserLoops(db, storage, userId) {
  let loops;
  try {
    loops = await query(db, `select "id" from irl_loop where "owner" = $1 and not "escalated"`, [userId]);
  } catch (error) {
    if (error.code === "42P01") return 0; // social tables not created yet: there are no loops to delete
    throw error;
  }
  for (const { id } of loops) {
    if (storage) await Promise.all(keys.all(id).map((key) => storage.remove(key)));
  }
  await query(db, `delete from irl_loop where "owner" = $1 and not "escalated"`, [userId]);
  return loops.length;
}

const isJpeg = (b) => b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;
const fromBase64 = (text) => new Uint8Array(Buffer.from(text, "base64"));

export function social({ db, storage, judge, admins = [], baseURL }) {
  const sharing = Boolean(storage && judge);
  const requireSharing = () => {
    if (!sharing) throw fail("SERVICE_UNAVAILABLE", "Loop sharing isn’t switched on yet.");
  };
  const me = (ctx) => ctx.context.session.user;
  const requirePosting = async (userId) => {
    const [row] = await query(db, `select "suspendedAt" from "irl_user" where "id" = $1`, [userId]);
    if (row?.suspendedAt) throw fail("FORBIDDEN", "Posting is paused on this account after repeated rule breaks.");
  };
  const isAdmin = (user) => admins.includes(user.handle);

  return {
    id: "irl-social",
    endpoints: {
      // ---- friends -------------------------------------------------------------
      irlFriends: createAuthEndpoint("/irl/friends", { method: "GET", use: [sessionMiddleware] }, async (ctx) => {
        const id = me(ctx).id;
        const rows = await query(
          db,
          `select f."status", f."requestedBy", u."handle", u."name"
             from irl_friendship f
             join "irl_user" u on u."id" = case when f."userLow" = $1 then f."userHigh" else f."userLow" end
            where (f."userLow" = $1 or f."userHigh" = $1)
            order by u."handle"`,
          [id],
        );
        const view = (r) => ({ handle: r.handle, name: r.name });
        return ctx.json({
          friends: rows.filter((r) => r.status === "accepted").map(view),
          incoming: rows.filter((r) => r.status === "pending" && r.requestedBy !== id).map(view),
          outgoing: rows.filter((r) => r.status === "pending" && r.requestedBy === id).map(view),
        });
      }),

      irlFriendRequest: createAuthEndpoint(
        "/irl/friends/request",
        { method: "POST", use: [sessionMiddleware], body: z.object({ handle: z.string().max(64) }) },
        async (ctx) => {
          const user = me(ctx);
          const target = await userByHandle(db, ctx.body.handle);
          if (!target || target.id === user.id) throw fail("NOT_FOUND", target ? "That’s you." : NOT_FOUND);
          if (await blockedEitherWay(db, user.id, target.id)) throw fail("NOT_FOUND", NOT_FOUND);
          const existing = await friendship(db, user.id, target.id);
          if (existing?.status === "accepted") return ctx.json({ status: "friends" });
          if (existing?.status === "pending" && existing.requestedBy === target.id) {
            await makeFriends(db, user.id, target.id, target.id); // they asked first: this accepts
            return ctx.json({ status: "friends" });
          }
          // Teens (and anyone not discoverable) can't be found by @name.
          if (!target.discoverable || isTeenNow(target.adultFrom)) throw fail("NOT_FOUND", NOT_FOUND);
          const [low, high] = pair(user.id, target.id);
          await query(
            db,
            `insert into irl_friendship ("userLow", "userHigh", "requestedBy", "status") values ($1, $2, $3, 'pending') on conflict do nothing`,
            [low, high, user.id],
          );
          return ctx.json({ status: "requested" });
        },
      ),

      irlFriendRespond: createAuthEndpoint(
        "/irl/friends/respond",
        { method: "POST", use: [sessionMiddleware], body: z.object({ handle: z.string().max(64), accept: z.boolean() }) },
        async (ctx) => {
          const user = me(ctx);
          const other = await userByHandle(db, ctx.body.handle);
          const existing = other && (await friendship(db, user.id, other.id));
          if (!existing || existing.status !== "pending" || existing.requestedBy === user.id) throw fail("NOT_FOUND", "There’s no request from that @name.");
          const [low, high] = pair(user.id, other.id);
          if (ctx.body.accept) await makeFriends(db, user.id, other.id, existing.requestedBy);
          else await query(db, `delete from irl_friendship where "userLow" = $1 and "userHigh" = $2`, [low, high]);
          return ctx.json({ status: ctx.body.accept ? "friends" : "declined" });
        },
      ),

      irlFriendRemove: createAuthEndpoint(
        "/irl/friends/remove",
        { method: "POST", use: [sessionMiddleware], body: z.object({ handle: z.string().max(64) }) },
        async (ctx) => {
          const user = me(ctx);
          const other = await userByHandle(db, ctx.body.handle);
          if (other) {
            const [low, high] = pair(user.id, other.id);
            await query(db, `delete from irl_friendship where "userLow" = $1 and "userHigh" = $2`, [low, high]);
          }
          return ctx.json({ status: "removed" });
        },
      ),

      // ---- blocks --------------------------------------------------------------
      irlBlock: createAuthEndpoint(
        "/irl/block",
        { method: "POST", use: [sessionMiddleware], body: z.object({ handle: z.string().max(64) }) },
        async (ctx) => {
          const user = me(ctx);
          const other = await userByHandle(db, ctx.body.handle);
          if (other && other.id !== user.id) {
            const [low, high] = pair(user.id, other.id);
            await transaction(db, async (tx) => {
              await tx.query(`delete from irl_friendship where "userLow" = $1 and "userHigh" = $2`, [low, high]);
              await tx.query(`insert into irl_block ("blocker", "blocked") values ($1, $2) on conflict do nothing`, [user.id, other.id]);
            });
          }
          return ctx.json({ status: "blocked" }); // same answer either way: no probing for accounts
        },
      ),

      irlUnblock: createAuthEndpoint(
        "/irl/unblock",
        { method: "POST", use: [sessionMiddleware], body: z.object({ handle: z.string().max(64) }) },
        async (ctx) => {
          const other = await userByHandle(db, ctx.body.handle);
          if (other) await query(db, `delete from irl_block where "blocker" = $1 and "blocked" = $2`, [me(ctx).id, other.id]);
          return ctx.json({ status: "unblocked" });
        },
      ),

      // ---- invites (links and QR codes) ---------------------------------------
      irlInviteCreate: createAuthEndpoint("/irl/invites", { method: "POST", use: [sessionMiddleware] }, async (ctx) => {
        const code = randomBytes(9).toString("base64url");
        const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
        await query(db, `insert into irl_invite ("code", "inviter", "expiresAt") values ($1, $2, $3)`, [code, me(ctx).id, expiresAt]);
        return ctx.json({ code, url: `${baseURL}/i/${code}`, expiresAt });
      }),

      irlInviteLookup: createAuthEndpoint("/irl/invite", { method: "GET", query: z.object({ code: z.string().max(32) }) }, async (ctx) => {
        const [row] = await query(
          db,
          `select u."handle", u."name" from irl_invite i join "irl_user" u on u."id" = i."inviter"
            where i."code" = $1 and i."expiresAt" > now() and i."uses" < i."maxUses"`,
          [ctx.query.code],
        );
        if (!row) throw fail("NOT_FOUND", "That invite has expired.");
        return ctx.json({ inviter: { handle: row.handle, name: row.name } });
      }),

      irlInviteAccept: createAuthEndpoint(
        "/irl/invites/accept",
        { method: "POST", use: [sessionMiddleware], body: z.object({ code: z.string().max(32) }) },
        async (ctx) => {
          const user = me(ctx);
          const [invite] = await query(db, `select * from irl_invite where "code" = $1 and "expiresAt" > now() and "uses" < "maxUses"`, [ctx.body.code]);
          if (!invite) throw fail("NOT_FOUND", "That invite has expired.");
          if (invite.inviter === user.id) throw fail("BAD_REQUEST", "That’s your own invite.");
          if (await blockedEitherWay(db, user.id, invite.inviter)) throw fail("NOT_FOUND", "That invite has expired.");
          await makeFriends(db, user.id, invite.inviter, invite.inviter);
          await query(db, `update irl_invite set "uses" = "uses" + 1 where "code" = $1`, [invite.code]);
          const [inviter] = await query(db, `select "handle", "name" from "irl_user" where "id" = $1`, [invite.inviter]);
          return ctx.json({ status: "friends", friend: inviter });
        },
      ),

      // ---- loops -----------------------------------------------------------------
      irlLoopShare: createAuthEndpoint(
        "/irl/loops/share",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({
            loop: z.string().max(base64Length(LIMITS.loopBytes)),
            thumbs: z.array(z.string().max(base64Length(LIMITS.thumbBytes))).length(LIMITS.thumbs),
          }),
        },
        async (ctx) => {
          requireSharing();
          const user = me(ctx);
          await requirePosting(user.id);

          // 1. Verify before anything is stored: a complete, intact loop with a
          //    valid Real Seal, six seconds at most, and three JPEG still frames.
          const bytes = fromBase64(ctx.body.loop);
          const frames = ctx.body.thumbs.map(fromBase64);
          const reject = async (message, detail) => {
            await logEvent(db, { userId: user.id, actor: "system", action: "rejected", detail });
            throw fail("BAD_REQUEST", message);
          };
          if (bytes.length === 0 || bytes.length > LIMITS.loopBytes) return reject("That loop is too big to share.", { reason: "size", bytes: bytes.length });
          let parsed;
          let seal;
          try {
            parsed = parseLoop(bytes);
            seal = await verify(parsed.chunks);
          } catch {
            return reject("That isn’t a loop irl.ing can share.", { reason: "unparseable" });
          }
          const { meta, report } = parsed;
          const intact = report.damaged === 0 && !report.truncated && report.missingGops.length === 0;
          const sealed = seal.signed && seal.valid && seal.present === seal.total && seal.foreign === 0;
          if (!intact || !sealed) return reject("This loop’s Real Seal didn’t check out, so it can’t be shared.", { reason: "seal", intact, sealed });
          if (!(meta.fps > 0) || !(meta.frameCount > 0) || meta.frameCount / meta.fps > MAX_SECONDS) return reject("Loops are six seconds at most.", { reason: "length" });
          if (frames.some((f) => !isJpeg(f) || f.length > LIMITS.thumbBytes)) return reject("The loop’s still frames are missing. Try sharing it again.", { reason: "thumbs" });

          // 2. The loop's ID is its seal. The same loop can only be shared once.
          const id = seal.id;
          const [existing] = await query(db, `select "owner", "status" from irl_loop where "id" = $1`, [id]);
          if (existing) {
            if (existing.owner === user.id) return ctx.json({ id, status: existing.status, message: "You already shared this loop.", supportResources: false });
            throw fail("CONFLICT", "That loop was already shared.");
          }
          const [{ today }] = await query(db, `select count(*)::int as today from irl_loop where "owner" = $1 and "createdAt" > now() - interval '1 day'`, [user.id]);
          if (today >= LOOPS_PER_DAY) throw fail("TOO_MANY_REQUESTS", "That’s a lot of loops for one day. Try again tomorrow.");

          // 3. Safety review, then irl.ing's own decision (fails closed: see moderation.js).
          const ownerTeen = isTeenNow(user.adultFrom);
          const result = await judge.review({ frames, ownerTeen });
          const { outcome, escalate, reasons, supportResources } = result.decision;
          const status = outcome === "show" ? "visible" : outcome === "hold" ? "held" : "removed";
          const moderation = { reviewer: judge.name, model: result.model ?? null, outcome, reasons, flags: result.verdict?.flags ?? [], summary: result.verdict?.summary ?? null };

          // 4. Store privately (removed loops too: they're kept for appeals and,
          //    when escalated, as the law requires), then record the decision.
          await storage.put(keys.loop(id), bytes);
          await Promise.all(frames.map((jpeg, n) => storage.put(keys.thumb(id, n), jpeg)));
          const inserted = await query(
            db,
            `insert into irl_loop ("id", "owner", "ownerHandle", "status", "bytes", "sealKey", "ownerTeen", "moderation", "escalated", "publishedAt")
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $4 = 'visible' then now() else null end)
             on conflict ("id") do nothing returning "id"`,
            [id, user.id, user.handle, status, bytes.length, seal.key, ownerTeen, JSON.stringify(moderation), escalate],
          );
          if (!inserted.length) return ctx.json({ id, status: "visible", message: "You already shared this loop.", supportResources: false });
          // Trust on first use: remember which device keys seal loops for this account.
          await query(db, `insert into irl_seal_key ("userId", "publicKey") values ($1, $2) on conflict do nothing`, [user.id, seal.key]);
          await logEvent(db, { loopId: id, userId: user.id, actor: judge.name, action: outcome, detail: moderation });
          if (escalate) await logEvent(db, { loopId: id, userId: user.id, actor: "system", action: "child_safety_escalation", detail: { reasons } });
          if (outcome === "block") await addStrike(db, user.id, id, reasons.join(","));

          const message =
            status === "visible"
              ? "Shared with your friends."
              : status === "held"
                ? "Your loop is waiting for a quick check by a person before friends can see it."
                : "This loop breaks the community rules, so it wasn’t shared.";
          return ctx.json({ id, status, message, supportResources });
        },
      ),

      irlFeed: createAuthEndpoint("/irl/feed", { method: "GET", use: [sessionMiddleware] }, async (ctx) => {
        requireSharing();
        const id = me(ctx).id;
        const rows = await query(
          db,
          `select l."id", l."ownerHandle", l."owner", l."publishedAt", u."name"
             from irl_loop l join "irl_user" u on u."id" = l."owner"
            where l."status" = 'visible'
              and l."publishedAt" > now() - interval '30 days'
              and (l."owner" = $1 or exists (
                    select 1 from irl_friendship f
                     where f."status" = 'accepted'
                       and ((f."userLow" = $1 and f."userHigh" = l."owner") or (f."userHigh" = $1 and f."userLow" = l."owner"))))
              and not exists (select 1 from irl_block b where (b."blocker" = $1 and b."blocked" = l."owner") or (b."blocker" = l."owner" and b."blocked" = $1))
            order by l."publishedAt" desc
            limit 50`,
          [id],
        );
        const loops = await Promise.all(
          rows.map(async (r) => ({
            id: r.id,
            handle: r.ownerHandle,
            name: r.name,
            mine: r.owner === id,
            publishedAt: r.publishedAt,
            loopUrl: await storage.presign("GET", keys.loop(r.id), LINK_SECONDS),
            posterUrl: await storage.presign("GET", keys.thumb(r.id, 0), LINK_SECONDS),
          })),
        );
        return ctx.json({ loops, caughtUp: true }); // the feed ends: this is everything new from your friends
      }),

      irlMyLoops: createAuthEndpoint("/irl/loops/mine", { method: "GET", use: [sessionMiddleware] }, async (ctx) => {
        requireSharing();
        const rows = await query(
          db,
          `select "id", "status", "createdAt", "publishedAt" from irl_loop where "owner" = $1 and "status" <> 'removed' order by "createdAt" desc limit 100`,
          [me(ctx).id],
        );
        const loops = await Promise.all(
          rows.map(async (r) => ({
            id: r.id,
            status: r.status, // visible, or held while a person checks it
            createdAt: r.createdAt,
            publishedAt: r.publishedAt,
            loopUrl: await storage.presign("GET", keys.loop(r.id), LINK_SECONDS),
            posterUrl: await storage.presign("GET", keys.thumb(r.id, 0), LINK_SECONDS),
          })),
        );
        return ctx.json({ loops });
      }),

      irlLoopDelete: createAuthEndpoint(
        "/irl/loops/delete",
        { method: "POST", use: [sessionMiddleware], body: z.object({ id: z.string().regex(LOOP_ID) }) },
        async (ctx) => {
          const user = me(ctx);
          const [row] = await query(db, `select "escalated" from irl_loop where "id" = $1 and "owner" = $2`, [ctx.body.id, user.id]);
          if (!row) throw fail("NOT_FOUND", "That loop isn’t yours or is already gone.");
          if (row.escalated) {
            // Preserved as the law requires; it stays hidden.
            await query(db, `update irl_loop set "status" = 'removed' where "id" = $1`, [ctx.body.id]);
          } else {
            if (storage) await Promise.all(keys.all(ctx.body.id).map((key) => storage.remove(key)));
            await query(db, `delete from irl_loop where "id" = $1`, [ctx.body.id]);
          }
          await logEvent(db, { loopId: ctx.body.id, userId: user.id, actor: user.handle, action: "deleted_by_owner" });
          return ctx.json({ status: "deleted" });
        },
      ),

      // ---- reports and review ------------------------------------------------
      irlReport: createAuthEndpoint(
        "/irl/report",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({ id: z.string().regex(LOOP_ID), reason: z.enum(REPORT_REASONS), note: z.string().max(500).optional() }),
        },
        async (ctx) => {
          const user = me(ctx);
          const [loop] = await query(db, `select * from irl_loop where "id" = $1`, [ctx.body.id]);
          if (!(await canSee(db, user.id, loop)) || loop.owner === user.id) throw fail("NOT_FOUND", "That loop isn’t available.");
          await query(db, `insert into irl_report ("loopId", "reporter", "reason", "note") values ($1, $2, $3, $4)`, [
            loop.id,
            user.id,
            ctx.body.reason,
            ctx.body.note ?? null,
          ]);
          const [{ open }] = await query(db, `select count(*)::int as open from irl_report where "loopId" = $1 and "resolvedAt" is null`, [loop.id]);
          const hide = ctx.body.reason === "child_safety" || open >= REPORTS_TO_HIDE;
          if (hide) await query(db, `update irl_loop set "status" = 'held' where "id" = $1 and "status" = 'visible'`, [loop.id]);
          await logEvent(db, { loopId: loop.id, userId: loop.owner, actor: user.handle, action: "reported", detail: { reason: ctx.body.reason, open, hidden: hide } });
          return ctx.json({ status: "reported", message: "Thanks. A person will look at it." });
        },
      ),

      irlAdminQueue: createAuthEndpoint("/irl/admin/queue", { method: "GET", use: [sessionMiddleware] }, async (ctx) => {
        if (!isAdmin(me(ctx))) throw fail("FORBIDDEN", "Reviewers only.");
        requireSharing();
        const rows = await query(
          db,
          `select l."id", l."ownerHandle", l."status", l."escalated", l."moderation", l."createdAt",
                  coalesce((select json_agg(json_build_object('reason', r."reason", 'note', r."note", 'at', r."createdAt"))
                              from irl_report r where r."loopId" = l."id" and r."resolvedAt" is null), '[]') as reports
             from irl_loop l
            where l."status" = 'held' or exists (select 1 from irl_report r where r."loopId" = l."id" and r."resolvedAt" is null)
            order by l."escalated" desc, l."createdAt"`,
        );
        const items = await Promise.all(
          rows.map(async (r) => ({
            id: r.id,
            handle: r.ownerHandle,
            status: r.status,
            escalated: r.escalated,
            moderation: r.moderation,
            reports: r.reports,
            createdAt: r.createdAt,
            // Child-safety escalations are never previewed here: they go through the reporting process.
            frames: r.escalated ? null : await Promise.all([0, 1, 2].map((n) => storage.presign("GET", keys.thumb(r.id, n), LINK_SECONDS))),
            loopUrl: r.escalated ? null : await storage.presign("GET", keys.loop(r.id), LINK_SECONDS),
          })),
        );
        return ctx.json({ items });
      }),

      irlAdminDecide: createAuthEndpoint(
        "/irl/admin/decide",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({ id: z.string().regex(LOOP_ID), action: z.enum(["restore", "remove", "remove_strike", "escalate"]), note: z.string().max(500).optional() }),
        },
        async (ctx) => {
          const reviewer = me(ctx);
          if (!isAdmin(reviewer)) throw fail("FORBIDDEN", "Reviewers only.");
          const [loop] = await query(db, `select * from irl_loop where "id" = $1`, [ctx.body.id]);
          if (!loop) throw fail("NOT_FOUND", "No such loop.");
          const { action } = ctx.body;
          if (action === "restore" && loop.escalated) throw fail("CONFLICT", "Child-safety escalations can’t be restored here.");
          const status = action === "restore" ? "visible" : action === "escalate" ? "held" : "removed";
          await query(
            db,
            `update irl_loop set "status" = $2, "escalated" = "escalated" or $3,
                    "publishedAt" = case when $2 = 'visible' then coalesce("publishedAt", now()) else "publishedAt" end
              where "id" = $1`,
            [loop.id, status, action === "escalate"],
          );
          await query(db, `update irl_report set "resolvedAt" = now(), "resolution" = $2 where "loopId" = $1 and "resolvedAt" is null`, [loop.id, action]);
          if (action === "remove_strike" || action === "escalate") await addStrike(db, loop.owner, loop.id, `reviewer:${action}`);
          await logEvent(db, { loopId: loop.id, userId: loop.owner, actor: reviewer.handle, action: `review_${action}`, detail: { note: ctx.body.note ?? null } });
          return ctx.json({ status });
        },
      ),
    },
  };
}
