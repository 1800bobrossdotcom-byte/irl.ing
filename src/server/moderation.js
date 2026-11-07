// AI safety review for shared loops.
//
// Claude looks at a loop's three still frames against irl.ing's community
// rules and returns a structured verdict (categories with severity, whether
// someone in frame may be under 18). irl.ing's own policy table, not the
// model alone, turns that into show / hold / block: the stricter of the two
// always wins, teen accounts get stricter thresholds, and anything the review
// can't settle (a refusal, an error, unreadable output) holds the loop for a
// person. Child-safety signals block and escalate.

import Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";

export const CATEGORIES = [
  "child_safety",
  "sexual",
  "violence_gore",
  "self_harm",
  "hate",
  "harassment",
  "weapons_threat",
  "drugs",
  "dangerous_acts",
  "private_info",
  "spam_scam",
];

export const DEFAULT_MODEL = "claude-opus-5-5";

// The review runs inside the share request (a 60-second function), so it is
// bounded: one retry at most, and a timeout that leaves room to answer. A
// review that doesn't finish holds the loop for a person.
const REQUEST_OPTIONS = { timeout: 25_000, maxRetries: 1 };

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: CATEGORIES },
          severity: { type: "string", enum: ["low", "high"] },
          reason: { type: "string" },
        },
        required: ["category", "severity", "reason"],
        additionalProperties: false,
      },
    },
    minor_in_frame: { type: "string", enum: ["no", "possible", "likely"] },
    suggested: { type: "string", enum: ["allow", "review", "block"] },
    summary: { type: "string" },
  },
  required: ["flags", "minor_in_frame", "suggested", "summary"],
  additionalProperties: false,
};

const Verdict = z.object({
  flags: z.array(z.object({ category: z.enum(CATEGORIES), severity: z.enum(["low", "high"]), reason: z.string() })),
  minor_in_frame: z.enum(["no", "possible", "likely"]),
  suggested: z.enum(["allow", "review", "block"]),
  summary: z.string(),
});

const SYSTEM = `You review short video loops for irl.ing, a six-second social video app where people share raw moments of everyday life with friends. Some users are teenagers (13-17).

You see three still frames from one loop. Report anything that breaks the community rules below. Most loops are ordinary life (friends, pets, food, places, jokes) and should come back with no flags. Don't flag ordinary things: people in swimwear at a beach or pool, kissing between adults, a kitchen knife being used for cooking, a beer at a barbecue, contact sports, cartoon or movie violence on a screen.

Community rules, as categories:
- child_safety: any nudity, sexualisation or sexualised posing of someone who might be under 18; a child in danger or being harmed.
- sexual: nudity (genitals, buttocks, female nipples) or sexual activity.
- violence_gore: graphic injury, blood, cruelty to people or animals, real violence.
- self_harm: depiction or promotion of self-harm, suicide or eating disorders.
- hate: hate symbols, slurs, or content attacking people for who they are.
- harassment: humiliating, bullying or targeting an identifiable person.
- weapons_threat: weapons pointed at people, brandished to intimidate, or threats.
- drugs: selling or using illegal drugs, or drug paraphernalia in use.
- dangerous_acts: stunts or challenges likely to cause serious injury.
- private_info: readable IDs, documents, cards, addresses, or screens showing personal data.
- spam_scam: scam offers, links or QR codes promoting scams, mass advertising.

Severity: "high" for a clear violation, "low" for borderline or unclear. Give a short reason for each flag that describes what is visible, without graphic detail.
minor_in_frame: whether anyone visible might be under 18 ("no", "possible", "likely").
suggested: "allow" if nothing breaks the rules, "review" if a person should look, "block" for a clear violation.
summary: one plain sentence describing the loop.`;

/** Turn a verdict into show / hold / block. Exported for tests. */
export function decide(verdict, { ownerTeen }) {
  const reasons = [];
  let outcome = "show";
  let escalate = false;
  const raise = (to, why) => {
    const rank = { show: 0, hold: 1, block: 2 };
    if (rank[to] > rank[outcome]) outcome = to;
    reasons.push(why);
  };
  for (const { category, severity } of verdict.flags) {
    const high = severity === "high";
    switch (category) {
      case "child_safety":
        raise("block", "child_safety");
        escalate = true;
        break;
      case "sexual":
        raise(high ? "block" : "hold", `sexual:${severity}`);
        if (verdict.minor_in_frame !== "no") {
          raise("block", "sexual_with_possible_minor");
          escalate = true;
        }
        break;
      case "violence_gore":
      case "hate":
      case "weapons_threat":
      case "spam_scam":
        raise(high ? "block" : "hold", `${category}:${severity}`);
        break;
      case "drugs":
        if (high || ownerTeen) raise("hold", `drugs:${severity}`);
        else reasons.push("drugs:low (shown)");
        break;
      case "dangerous_acts":
        if (high || ownerTeen) raise("hold", `dangerous_acts:${severity}`);
        else reasons.push("dangerous_acts:low (shown)");
        break;
      default: // self_harm, harassment, private_info
        raise("hold", `${category}:${severity}`);
    }
  }
  if (verdict.suggested === "block") raise("block", "model_suggested_block");
  else if (verdict.suggested === "review") raise("hold", "model_suggested_review");
  return { outcome, escalate, reasons, supportResources: verdict.flags.some((f) => f.category === "self_harm") };
}

/** A held decision for when the review couldn't run. */
export function unavailable(why) {
  return { outcome: "hold", escalate: false, reasons: [`review_unavailable:${why}`], supportResources: false };
}

/** Claude as the reviewer. `client` is injectable for tests. */
export function claudeJudge({ client = new Anthropic(), model = DEFAULT_MODEL } = {}) {
  return {
    name: model,
    async review({ frames, ownerTeen }) {
      const content = [
        ...frames.map((jpeg) => ({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(jpeg).toString("base64") },
        })),
        {
          type: "text",
          text: `These are three still frames (start, middle, end) from one loop. The account that posted it belongs to someone ${ownerTeen ? "under 18" : "18 or over"}. Review them against the community rules.`,
        },
      ];
      let response;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 8000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
          system: SYSTEM,
          messages: [{ role: "user", content }],
        }, REQUEST_OPTIONS);
      } catch (error) {
        if (error instanceof Anthropic.APIConnectionTimeoutError) return { decision: unavailable("timeout") };
        if (error instanceof Anthropic.APIConnectionError) return { decision: unavailable("network") };
        if (error instanceof Anthropic.RateLimitError) return { decision: unavailable("rate_limited") };
        if (error instanceof Anthropic.APIError) return { decision: unavailable(`api_${error.status ?? "error"}`) };
        return { decision: unavailable("network") };
      }
      if (response.stop_reason === "refusal") return { decision: unavailable("refused"), raw: { stop_details: response.stop_details ?? null } };
      if (response.stop_reason === "max_tokens") return { decision: unavailable("truncated") };
      const text = response.content.find((block) => block.type === "text")?.text;
      let verdict;
      try {
        verdict = Verdict.parse(JSON.parse(text ?? ""));
      } catch {
        return { decision: unavailable("unreadable") };
      }
      return { verdict, decision: decide(verdict, { ownerTeen }), model: response.model };
    },
  };
}

/** Deterministic reviewer for local runs and tests only. */
export function stubJudge(suggested = "allow") {
  return {
    name: `stub:${suggested}`,
    async review({ ownerTeen }) {
      const verdict = { flags: [], minor_in_frame: "no", suggested, summary: "stub review" };
      return { verdict, decision: decide(verdict, { ownerTeen }), model: "stub" };
    },
  };
}

/** Names of the reviewer settings that are missing (never their values). */
export function missingJudgeEnv(env = process.env) {
  if (env.MODERATION_JUDGE?.startsWith("stub") && env.VERCEL_ENV !== "production") return [];
  return env.ANTHROPIC_API_KEY?.trim() ? [] : ["ANTHROPIC_API_KEY"];
}

/** The configured reviewer, or null when it isn't set up (sharing stays off). */
export function getJudge(env = process.env) {
  if (env.MODERATION_JUDGE?.startsWith("stub") && env.VERCEL_ENV !== "production") {
    return stubJudge(env.MODERATION_JUDGE.split(":")[1] || "allow");
  }
  if (env.ANTHROPIC_API_KEY) return claudeJudge({ model: env.MODERATION_MODEL || DEFAULT_MODEL });
  return null;
}
