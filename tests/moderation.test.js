import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { claudeJudge, decide, getJudge, missingJudgeEnv, stubJudge } from "../src/server/moderation.js";

const clean = { flags: [], minor_in_frame: "no", suggested: "allow", summary: "Two friends laughing at a cafe." };
const flag = (category, severity = "high") => ({ category, severity, reason: "test" });

test("ordinary loops are shown", () => {
  assert.equal(decide(clean, { ownerTeen: false }).outcome, "show");
  assert.equal(decide(clean, { ownerTeen: true }).outcome, "show");
});

test("child safety always blocks and escalates", () => {
  const d = decide({ ...clean, flags: [flag("child_safety", "low")], suggested: "allow" }, { ownerTeen: false });
  assert.equal(d.outcome, "block");
  assert.equal(d.escalate, true);
  // Sexual content with anyone who might be a minor is treated as child safety, even if not labeled so.
  const e = decide({ ...clean, flags: [flag("sexual", "low")], minor_in_frame: "possible" }, { ownerTeen: false });
  assert.deepEqual([e.outcome, e.escalate], ["block", true]);
});

test("clear violations block; borderline ones wait for a person", () => {
  for (const category of ["sexual", "violence_gore", "hate", "weapons_threat", "spam_scam"]) {
    assert.equal(decide({ ...clean, flags: [flag(category, "high")] }, { ownerTeen: false }).outcome, "block", category);
    assert.equal(decide({ ...clean, flags: [flag(category, "low")] }, { ownerTeen: false }).outcome, "hold", category);
  }
  for (const category of ["self_harm", "harassment", "private_info"]) {
    assert.equal(decide({ ...clean, flags: [flag(category, "low")] }, { ownerTeen: false }).outcome, "hold", category);
  }
  assert.equal(decide({ ...clean, flags: [flag("self_harm", "low")] }, { ownerTeen: false }).supportResources, true);
});

test("teen accounts get stricter thresholds", () => {
  for (const category of ["drugs", "dangerous_acts"]) {
    assert.equal(decide({ ...clean, flags: [flag(category, "low")] }, { ownerTeen: false }).outcome, "show", category);
    assert.equal(decide({ ...clean, flags: [flag(category, "low")] }, { ownerTeen: true }).outcome, "hold", category);
  }
});

test("the stricter of the policy and the model wins", () => {
  assert.equal(decide({ ...clean, suggested: "review" }, { ownerTeen: false }).outcome, "hold");
  assert.equal(decide({ ...clean, suggested: "block" }, { ownerTeen: false }).outcome, "block");
  assert.equal(decide({ ...clean, flags: [flag("hate", "high")], suggested: "allow" }, { ownerTeen: false }).outcome, "block");
});

/** A stand-in for the Anthropic client that records the request and returns `reply`. */
function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params, options) {
          calls.push({ ...params, options });
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  };
}
const message = (body, stop_reason = "end_turn") => ({
  model: "claude-opus-5-5",
  stop_reason,
  content: body === null ? [] : [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
});
const frames = [new Uint8Array([0xff, 0xd8, 1]), new Uint8Array([0xff, 0xd8, 2]), new Uint8Array([0xff, 0xd8, 3])];

test("Claude gets the frames, the rules and a strict schema, with refusal fallbacks", async () => {
  const client = fakeClient(message(clean));
  const result = await claudeJudge({ client }).review({ frames, ownerTeen: true });
  assert.equal(result.decision.outcome, "show");
  const [req] = client.calls;
  assert.equal(req.model, "claude-opus-5-5");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.fallbacks, "default");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(req.output_config.effort, "medium");
  assert.match(req.system, /community rules/i);
  const images = req.messages[0].content.filter((c) => c.type === "image");
  assert.equal(images.length, 3);
  assert.equal(images[0].source.media_type, "image/jpeg");
  assert.match(req.messages[0].content.at(-1).text, /under 18/);
  assert.deepEqual(req.options, { timeout: 25_000, maxRetries: 1 }, "bounded to fit inside the share request");
});

test("anything the review can't settle holds the loop for a person", async () => {
  const cases = [
    [message(null, "refusal"), "refused"],
    [message("{", "max_tokens"), "truncated"],
    [message("not json"), "unreadable"],
    [message({ ...clean, suggested: "maybe" }), "unreadable"],
    [new Anthropic.APIError(500, undefined, "boom", new Headers()), "api_500"],
    [new TypeError("fetch failed"), "network"],
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [new Anthropic.APIConnectionError({ message: "reset" }), "network"],
  ];
  for (const [reply, why] of cases) {
    const { decision } = await claudeJudge({ client: fakeClient(reply) }).review({ frames, ownerTeen: false });
    assert.equal(decision.outcome, "hold", why);
    assert.deepEqual(decision.reasons, [`review_unavailable:${why}`]);
  }
});

test("no reviewer configured means sharing stays off; stubs never run in production", async () => {
  assert.equal(getJudge({}), null);
  assert.equal(getJudge({ MODERATION_JUDGE: "stub", VERCEL_ENV: "production" }), null);
  assert.equal((await getJudge({ MODERATION_JUDGE: "stub:review" }).review({ ownerTeen: false })).decision.outcome, "hold");
  assert.equal(getJudge({ ANTHROPIC_API_KEY: "x" }).name, "claude-opus-5-5");
  assert.equal(getJudge({ ANTHROPIC_API_KEY: "x", MODERATION_MODEL: "claude-haiku-5-5" }).name, "claude-haiku-5-5");
  assert.equal((await stubJudge().review({ ownerTeen: true })).decision.outcome, "show");
});

test("a preview can say the reviewer key is missing, by name only", () => {
  assert.deepEqual(missingJudgeEnv({}), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(missingJudgeEnv({ ANTHROPIC_API_KEY: "x" }), []);
  assert.deepEqual(missingJudgeEnv({ MODERATION_JUDGE: "stub" }), []);
  assert.deepEqual(missingJudgeEnv({ MODERATION_JUDGE: "stub", VERCEL_ENV: "production" }), ["ANTHROPIC_API_KEY"]);
});
