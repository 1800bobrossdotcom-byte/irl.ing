# irl.ing user safety

irl.ing is six raw seconds of real life, shared with people you actually know. Safety isn't a feature added on top of that; it's what "friends before followers" and "feeds that end" mean in practice. This document is the safety program: what protects people today, what ships with loop sharing, how decisions are made, and what has to be in place before a public launch.

Every item is marked:
- **Live**: running on irl.ing now.
- **Built**: implemented and tested end to end, but not switched on yet. It needs storage and reviewer keys, and the app screens come with the redesign. See [the backend](social.md).
- **Designed**: specified; not built yet.
- **Before launch**: required before irl.ing is opened to the public or listed in an app store.

## Principles

1. **Small circles by default.** Loops go to friends you accepted, never to strangers or an algorithmic feed.
2. **Protect teens more, without making them prove it.** Under-18s get the strictest defaults automatically, and adults can't change a teen's protections.
3. **Nothing is shown before it's checked.** A shared loop stays private until it passes review.
4. **Collect as little as possible.** No passwords, phone numbers, contact lists, location or birthdays are stored.
5. **Real, not retouched.** No filters, face-tuning or beauty modes. Anything the app adds on playback is labeled.
6. **Humans decide the hard cases.** AI review triages; people review anything uncertain, reported or serious, and every decision is logged.
7. **Fail closed.** If a check can't run, the loop stays private.

## Accounts and identity

| Protection | Status |
| --- | --- |
| Passkey-only sign-in (fingerprint, face or screen lock). No passwords to leak, reuse or phish. | Live |
| The server *requires* the fingerprint, face or screen-lock check for signup and sign-in, not just possession of the phone. | Live |
| Age gate: under 13 can't join, and nothing about them is stored. | Live |
| Only the month someone turns 18 is stored, never their birthday. | Live |
| Under-18 accounts start friends-only and can't be found by strangers; they can't switch discovery on. | Live (defaults stored and enforced at signup) |
| Reserved names block impersonation of irl.ing, its staff and its pages (`admin`, `support`, `irl.ing`, `mod` and others, including disguised spellings). | Live |
| Rate limits on signup, sign-in and name checks, stored in the database so they hold across servers. | Live |
| Optional bot check (Cloudflare Turnstile) on signups. | Live, switched off until keys are added |
| In-app account deletion: type your @name to confirm; removes the account, passkeys and sessions and frees the name. | Live |
| Each phone's Real Seal key linked to the account, so loops show "Signed by @name". | Built (the server links keys on first use; the label comes with the feed screens) |

## Friends, not followers

| Protection | Status |
| --- | --- |
| Friendship is mutual: you see someone's loops only after you both said yes. | Built |
| Add friends in person by QR code, by invite link, or by exact @name. There is no browsing, no suggestions and no contact upload. | Built (the QR screen comes with the redesign) |
| Teens can't be found by exact-name search; adults can reach them only through a code or link the teen chose to share. A search for a teen gets the same answer as a search for no one. | Built |
| Block: ends the friendship, hides each person's loops from the other, and stops new requests. Blocking always wins, and blocking gives the same answer whether or not the account exists. | Built |
| Feeds end: when you've seen your friends' new loops, the app says so. No autoplay of strangers' content. | Built |

## Loops: private until checked

Today loops stay on the phone. They're shared only as a file the person chooses to send.

With sharing, every uploaded loop goes through these steps:

1. **Send to irl.ing.** The phone sends the loop (about 100 KB, at most 512 KB) and three small still frames to irl.ing's server from the signed-in account. Nothing is public at any point. *Built.*
2. **Verify.** The server checks that the loop is complete and that its Real Seal signature covers every part, with nothing added. It also checks the size, that the loop is six seconds at most, and the still frames. Anything that fails is rejected, never stored, and logged. *Built.*
3. **AI review.** The three still frames are sent to Claude, Anthropic's AI model, with irl.ing's community rules. Claude returns a structured verdict listing any rule categories it sees. *Built.*
4. **Decide.** irl.ing's own policy, not the model alone, turns that verdict into one of three outcomes:
   - **Show:** friends can see the loop.
   - **Hold for a person:** the loop stays private until a reviewer decides.
   - **Block.**

   The stricter of the policy and the model always wins, and teen accounts get stricter thresholds. If the review can't run, takes longer than 25 seconds, is refused, or returns something unreadable, the loop is held. *Built.*
5. **Store privately.** Loops that pass verification are kept in private storage (Cloudflare R2), whatever the outcome, so held loops can be reviewed and removed ones appealed. *Built.*
6. **Show to friends only.** Playback links are issued one loop at a time, only to the owner and accepted friends, and expire within 10 minutes. *Built.*

### What the AI review looks for

| Category | Examples | Outcome |
| --- | --- | --- |
| Child safety | Any sexualisation or nudity involving someone who might be under 18; a child in danger | Blocked, escalated (see below) |
| Sexual content | Nudity, sexual activity | Blocked |
| Violence and gore | Graphic injury, cruelty to people or animals | Blocked, or held when unclear |
| Self-harm | Promotion or depiction of self-harm or suicide | Held; the person is shown support resources |
| Hate | Hate symbols, slurs, dehumanising content | Blocked, or held when unclear |
| Harassment | Humiliating or targeting a person | Held |
| Weapons and threats | Brandishing weapons at people, threats | Held, or blocked when explicit |
| Drugs | Selling or using illegal drugs | Held; always held for teen accounts |
| Dangerous acts | Stunts likely to cause serious harm | Held |
| Private information | Visible IDs, documents, addresses, screens with personal data | Held |
| Scams and spam | Scam links, QR codes, mass promotion | Held, or blocked when explicit |

Audio isn't reviewed by AI yet. Reports cover it until it is.

## Reports, blocks and human review

| Protection | Status |
| --- | --- |
| Report on every loop and profile, with a reason (child safety, sexual content, violence, self-harm, hate, harassment, privacy, scam, other). | Built for loops; profile reports come with the profile screens |
| A loop is hidden at once while it's reviewed if it is reported for child safety, or if it receives three reports. | Built |
| A human review queue for held and reported loops. Reviewers restore, remove, or remove and add a strike. | Built (the review screen comes with the redesign) |
| Strikes: repeated removals suspend posting, and the most serious violations close the account. | Built: three strikes pause posting. Closing accounts: Designed |
| An audit log of every automated and human decision: who or what decided, when and why. | Built |
| Appeals: the person can ask for a held or removed loop to be looked at again by a human. | Designed |

## Child safety

This is the area with legal duties, not just policy.

- **Known-image matching.** Every shared loop's still frames are hash-matched against known child sexual abuse material. *Designed; the provider is decided before launch.*
  - **Cloudflare's CSAM Scanning Tool** only scans images served through irl.ing's own Cloudflare domain. It needs a small authenticated media endpoint on that domain (for example `media.irl.ing`), because private R2 links come from Cloudflare's storage domain instead.
  - **A dedicated matching service** such as Thorn's Safer is the alternative.
- **Escalation.** A loop flagged for child safety, by AI review, a report or a match:
  - is blocked at once;
  - is visible only to designated safety staff, with no casual previews;
  - is preserved with its audit trail, even if the account is deleted.

  *Built:*
  - Escalations are never previewed in the review queue, and can't be restored there.
  - They're kept when the owner deletes the loop or the account.
  - The staff process for handling them is set up with NCMEC registration, before launch.
- **Reporting.** Under US law (18 U.S.C. § 2258A), irl.ing must report apparent child sexual abuse material to NCMEC's CyberTipline and preserve the report's contents for at least one year. This requires registering with NCMEC and naming the staff who report. *Before launch.*
- **Never shared onward.** Flagged material is never sent to further AI services for "a second opinion". Matching and human escalation handle it. *Built.*

## Data and processors

| What | Where | Why | Retention |
| --- | --- | --- | --- |
| Account (@name, display name, the month you turn 18, visibility settings) | Neon (Postgres), via Vercel | Running your account | Until you delete it |
| Passkey public key (no biometrics; those never leave your phone) | Neon | Signing in | Until you delete it |
| Session tokens, with IP address and browser for security | Neon | Keeping you signed in; spotting abuse | 30 days |
| Loops and their three still frames | Cloudflare R2, private | Sharing with friends; safety review | Until you delete the loop or your account (*Built*) |
| Three still frames per shared loop | Anthropic API (Claude) | AI safety review | Per Anthropic's commercial API terms (*Built*) |
| Friendships, blocks, invites | Neon | Who sees whose loops | Until either account is deleted (*Built*) |
| Moderation decisions and reports | Neon | Safety and appeals | Kept for the safety record; child-safety items per law |

Loops aren't end-to-end encrypted. irl.ing can review them for safety, which is a deliberate choice for a network that includes teens. The privacy policy will say this plainly.

## Known limits

- AI review makes mistakes in both directions. That's why it holds rather than guesses, and why humans and appeals exist.
- Still frames can miss something that happens between them; reports cover the gap.
- Audio isn't reviewed by AI yet.
- Age is self-declared. The protections are strong defaults, not verification.

## Before a public launch

- [ ] Privacy policy and terms of service, covering everything above in plain language
- [ ] Community rules page (the in-app rules, expanded)
- [ ] NCMEC CyberTipline registration and named reporting staff
- [ ] A safety contact and a process for law-enforcement requests
- [ ] Report, block and the review queue live, with trained reviewers and response-time targets
- [ ] If listed in app stores: Google Play's Data safety form and Apple's privacy labels, content ratings, and both stores' user-generated-content requirements (report, block, moderation, terms)
- [ ] Legal review of age and teen protections for target countries (US COPPA, UK Age Appropriate Design Code, EU DSA)
- [ ] A crisis-support resource list for the self-harm flow, per country

Designs here are implemented in `src/server/` and `src/accounts/`. Account protections are covered by `tests/accounts-browser.mjs` and `tests/accounts-server.test.js`. See also [accounts](accounts.md) and [the design disclosure](design-disclosure.md).
