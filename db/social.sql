-- irl.ing social tables: friends, blocks, invites, loops, reports, moderation.
-- Safe to run repeatedly. Apply after db/schema.sql (Better Auth's tables):
--   npm run db:migrate            (needs DATABASE_URL)
-- or paste into the Neon SQL editor.

-- Friendship is mutual: one row per pair, stored with the smaller id first.
create table if not exists irl_friendship (
  "userLow" text not null references "irl_user" ("id") on delete cascade,
  "userHigh" text not null references "irl_user" ("id") on delete cascade,
  "requestedBy" text not null,
  "status" text not null check ("status" in ('pending', 'accepted')),
  "createdAt" timestamptz not null default now(),
  "acceptedAt" timestamptz,
  primary key ("userLow", "userHigh"),
  check ("userLow" < "userHigh")
);
create index if not exists irl_friendship_high_idx on irl_friendship ("userHigh");

create table if not exists irl_block (
  "blocker" text not null references "irl_user" ("id") on delete cascade,
  "blocked" text not null references "irl_user" ("id") on delete cascade,
  "createdAt" timestamptz not null default now(),
  primary key ("blocker", "blocked")
);

-- An invite link / QR code. Whoever joins through it becomes the inviter's friend.
create table if not exists irl_invite (
  "code" text primary key,
  "inviter" text not null references "irl_user" ("id") on delete cascade,
  "createdAt" timestamptz not null default now(),
  "expiresAt" timestamptz not null,
  "uses" integer not null default 0,
  "maxUses" integer not null default 25
);
create index if not exists irl_invite_inviter_idx on irl_invite ("inviter");

-- A loop. Its id is the loop's Real Seal ID (SHA-256 of its signed manifest).
-- A row exists only once the loop has passed verification and safety review.
-- Status: visible (friends see it) | held (hidden until a person checks it) |
-- removed (taken down). Deleting an account deletes its loops, except ones
-- escalated for child safety, which the law requires preserving.
create table if not exists irl_loop (
  "id" text primary key,
  "owner" text references "irl_user" ("id") on delete set null,
  "ownerHandle" text not null,
  "status" text not null check ("status" in ('visible', 'held', 'removed')),
  "bytes" integer not null default 0,
  "sealKey" text,
  "ownerTeen" boolean not null default false,
  "moderation" jsonb,
  "escalated" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "publishedAt" timestamptz
);
create index if not exists irl_loop_owner_idx on irl_loop ("owner", "createdAt" desc);
create index if not exists irl_loop_status_idx on irl_loop ("status", "createdAt" desc);

-- The device keys that have signed loops for an account (trust on first use).
create table if not exists irl_seal_key (
  "userId" text not null references "irl_user" ("id") on delete cascade,
  "publicKey" text not null,
  "firstSeen" timestamptz not null default now(),
  primary key ("userId", "publicKey")
);

create table if not exists irl_report (
  "id" bigserial primary key,
  "loopId" text not null references irl_loop ("id") on delete cascade,
  "reporter" text references "irl_user" ("id") on delete set null,
  "reason" text not null,
  "note" text,
  "createdAt" timestamptz not null default now(),
  "resolvedAt" timestamptz,
  "resolution" text
);
create index if not exists irl_report_open_idx on irl_report ("loopId") where "resolvedAt" is null;

-- Every automated and human moderation decision, kept as an audit trail.
create table if not exists irl_moderation_event (
  "id" bigserial primary key,
  "loopId" text,
  "userId" text,
  "actor" text not null,
  "action" text not null,
  "detail" jsonb,
  "createdAt" timestamptz not null default now()
);
create index if not exists irl_moderation_event_loop_idx on irl_moderation_event ("loopId");

-- Strikes against an account; enough of them suspends posting.
create table if not exists irl_strike (
  "id" bigserial primary key,
  "userId" text not null references "irl_user" ("id") on delete cascade,
  "loopId" text,
  "reason" text not null,
  "createdAt" timestamptz not null default now()
);
create index if not exists irl_strike_user_idx on irl_strike ("userId");

alter table "irl_user" add column if not exists "suspendedAt" timestamptz;
