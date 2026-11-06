# irl.ing brand

**The record dot is the brand.** It is the button you hold, the dot in the name, and the full stop at the end of a feed that ends. Everything else is built around it.

## The idea

irl.ing has one gesture: hold to record, let go to pause, hold again. Every loop is six seconds of takes with small gaps where your thumb came off the glass. The identity is drawn from that gesture rather than from a picture of a camera.

- **The mark, “the take”**, is a real loop: three takes of 2.6, 1.5 and 1.9 seconds, drawn clockwise from twelve o’clock as a ring around the record dot. The gaps are where someone let go. It isn’t a symbol of the button; on the landing page it *is* the button, and while you hold it the ring redraws itself from your own takes, so every loop gets a ring of its own.
- **The wordmark** is drawn, not typed. Stems stand flat on the baseline (feet on the ground); curves end round (still moving). The two tittles and the period are one size, and the period, the dot in the domain, is the record light. It sits between *irl* and *ing*: real life, then doing something with it.
- **Endings.** The page ends the way the feed will: “You’re caught up.” The full stop at the end of the biggest lines is the record dot.

### What changed, and why

The previous identity was Arial 900, an orange viewfinder with an outward arrow, cream paper, olive and Georgia italics.

- The arrow-in-a-frame read as the “open in new window” icon. It said *leave*, not *make*. Replaced by a mark that is the product’s own control.
- Cream, a serif italic and a soft orange is the default look of a great many generated sites. Cut the cream (daylight white instead), cut the italics (emphasis is a highlighter stroke now), cut the olive.
- Kept and sharpened the two colors that were already working: orange became **Rec**, a hotter red-orange like a camera’s tally light, and lime became **Highlighter**, used the way you’d use a marker on paper.
- Arial became **Schibsted Grotesk**, self-hosted.

## Logo files

All in `public/brand/` (the favicon is `public/favicon.svg`). Every file is generated from the construction below by `node scripts/brand/build.mjs` (add `--png` to re-render the PNGs and the share image with Playwright). Change the numbers there, never the files by hand.

| File | Use |
| --- | --- |
| `lockup.svg`, `lockup-reverse.svg` | Mark + wordmark, for places the name is introduced (share image, decks, stores). |
| `wordmark.svg`, `wordmark-reverse.svg` | The default signature: site headers and footers, small spaces. |
| `mark.svg`, `mark-reverse.svg` | The take on its own: avatars, stickers, large graphics. |
| `app-icon-maskable.svg` → `maskable-192.png`, `maskable-512.png`, `apple-touch-icon.png` | Full-bleed icon for Android adaptive/maskable and iOS. |
| `app-icon.svg` → `icon-192.png`, `icon-512.png` | Rounded-tile icon (`purpose: any`). |
| `og.png` (1200×630) | Social share image (`og:image`), template in `scripts/brand/og.html`. |
| `public/favicon.svg` | Favicon, drawn separately for 16 px. |
| `public/manifest.webmanifest` | Web app manifest, linked from both pages. Installs open the loops lab. |

Reverse files are chalk on dark. The record dot is Rec in every version; there is no one-color dot except in single-ink print (see below).

## Construction

### The take (mark)

On a 120 × 120 grid:

- Ring centerline radius **48**, weight **12**, round caps. Outer edge at 54, so 6 units of air inside the box.
- Record dot radius **25** (about 0.42 of the box).
- Takes **2.6 s, 1.5 s, 1.9 s** (they sum to six), clockwise from twelve. Each gap is **20°** of visible space after the round caps (the arcs are trimmed by 10° + the cap’s own angle at each end).
- The first gap is always at twelve: that’s where the loop starts and ends. Never rotate the mark.

### The wordmark

On a 100-unit x-height, baseline at 142:

- Stem weight **24**. Ascender (l) **142**; the tittles’ tops line up with it.
- Dots (both tittles and the period) **29** across, about 1.2× the stem, so they look as heavy as the stems.
- r: shoulder of radius 30 (centerline), ending round 22° past twelve. n: a half-ring arch of radius 34. g: a round bowl of radius 40 and a hook that ends round, 54 below the baseline.
- Round shapes overshoot the x-height and baseline by 2.
- Spacing (stem to stem unless noted): i–r 16, r–l 6 (from the r’s terminal), l–. 13, .–i 13, i–n 16, n–g 11.

### The lockup

The ring’s outer diameter equals the ascender height (142 units), sitting on the baseline; the wordmark starts 50 units (about a third of the mark) to its right.

### Clear space and minimum size

- Keep clear space of **one x-height** (the height of the *n*) on every side of the wordmark and lockup, and **a quarter of the diameter** around the mark.
- Minimum sizes on screen: wordmark **18 px tall** (about 40 px wide); lockup 24 px tall; mark 24 px. Below 24 px use the favicon artwork, which has wider gaps (26°) and sits on an ink tile.
- Print: wordmark 12 mm wide, mark 6 mm.

### App icon and favicon

- App icon: ink field, chalk ring, Rec dot. The ring’s outer radius is 150 of 512, inside Android’s adaptive safe circle (66 of 108 dp, radius 156 of 512) and the web’s 40% maskable zone, so no mask ever clips it.
- Favicon: a 32-unit tile, ring radius 10.4 and weight 3.2 with 26° gaps, dot radius 5.5. At 16 px it still reads as a dot in a broken ring.

## Color

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--bg` | `#FFFFFF` daylight | `#111110` | Page |
| `--bg-2` | `#EFEFEA` concrete | `#1D1D1B` | Quiet panels, inputs, tracks |
| `--fg` | `#111110` ink | `#F4F4F0` chalk | Text, rules, outlines |
| `--fg-2` | `#5C5C57` | `#AAAAA2` | Secondary text |
| `--line` | `#DCDCD6` | `#34342F` | Hairlines |
| `--rec` | `#F33A16` | `#F33A16` | The record dot, the one action that starts something, big emphasis |
| `--rec-text` | `#C92F0E` | `#FF5A3C` | Rec as text under 24 px, errors |
| `--lime` | `#D8F04A` | `#D8F04A` | Highlighter: emphasis, selected chips, the closing band |
| `--night` | `#111110` | `#000000` | Surfaces that stay dark in both themes (the recorder, the lexicon) |
| `--night-2` | `#1D1D1B` | `#1A1A18` | Panels on night |
| `--night-fg-2` | `#AAAAA2` | `#AAAAA2` | Secondary text on night |
| `--sky`, `--peach` | `#A6D6F2`, `#FFB49C` | same | Diagram categories only (sound, extra frames) |

Contrast (WCAG 2.x): ink on white 18.9:1; `--fg-2` on white 6.7:1 and on concrete 5.8:1; ink on Rec 4.9:1 (so Rec buttons carry **ink** text, never white: white on Rec is 3.9:1); Rec on white 3.9:1, so Rec text is for 24 px and up only, and `--rec-text` (5.4:1) below that; ink on lime 14.8:1; lime on ink 14.8:1; chalk on ink 17.1:1; `--night-fg-2` on ink 8.1:1.

Proportions: mostly daylight and ink, one Rec moment per view, lime as a marker, not a wallpaper (the single lime band is the exception, and it ends the page).

Single-ink print: everything in ink, the dot included, on white; or everything reversed out of a solid.

## Type

**Schibsted Grotesk**, variable, upright, weights 400–900, SIL OFL 1.1. It was drawn for a Nordic newsroom: plain-spoken and warm, made for saying what happened. Self-hosted from `public/fonts/` (47 KB Latin, plus a 21 KB Latin Extended file that only loads when needed); no font request ever leaves irl.ing. No italic is shipped or synthesized.

| Style | Size | Line height | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Display (hero) | `clamp(48px, 15.6vw, 112px)` | 0.93 | 860 | −0.055em |
| Headline (h2) | `clamp(40px, 10.4vw, 84px)` | 0.95 | 840 | −0.048em |
| Closing line | `clamp(50px, 14.5vw, 136px)` | 0.9 | 860 | −0.055em |
| Title (h3, lexicon terms) | 28–36px | 1–1.05 | 820 | −0.035em |
| Lede | 19px | 1.5 | 400 | 0 |
| Body | 17px (lab 16px) | 1.55 | 400 | 0 |
| Small, captions | 14–15px | 1.5 | 400–600 | 0 |
| Label | 12–13px, uppercase | 1.35 | 700 | +0.12em |

- Big type is set tight and lowercase where the copy allows. Headlines balance (`text-wrap: balance`); keep phrases together with non-breaking spaces (“Hold&nbsp;it.”).
- Emphasis inside a headline is a lime highlighter stroke behind the words on light, lime text on dark. The hero line’s second half is Rec. Never italics.
- Tabular figures only for counters that change while you watch (the hero clock).

## Graphic language

- **Dots** are punctuation: the record light, bullets in the house rules, the full stop at the end of the biggest lines.
- **The take bar** is a capsule split where you let go: the recorder meters, the step bars in “How it works”, the strip under the share image.
- **The ring** is reserved for the record button and the mark. Don’t put it around anything else.
- **No gradients, glows, glass or drop shadows** on brand elements. The only pictures are loops.

## Motion

- Hold: the dot squares off while recording (150 ms), the ring draws the current take in Rec and keeps the earlier ones; when a loop plays, the take on screen is lit and the others dim.
- The period in the header blinks while you record on the landing page, and hops when you hover the wordmark.
- With `prefers-reduced-motion: reduce`, none of this animates; the loops hold still until asked, as before.

## Voice

Plain, specific, warm, a little funny. Short sentences, real verbs, talk to one person.

- **Say what’s true today.** “Recording, loops and everything in the lexicon below work today in the loops lab. Profiles, friends and feeds are being built next.” Never describe a feature that isn’t built as if it were.
- **Name things once, then use the name.** The lexicon terms are proper nouns, always written exactly: Hold-to-Loop, Featherweight, Lifeboats, Lighten Up, Real Seal, True Grain, Glow-Up, Honest Zoom, Smart Pixels, Cosmic Courtesy. Plain words first, the engineering second.
- **Irl’ing is a verb.** Being present, seeing what’s around you, doing something with it. Use it like one: “More irl’ing.”
- **End things.** “Then put the phone down.” “You’re caught up.”
- No hype words (revolutionary, seamless, AI-powered), no exclamation marks, no emoji, and no comparisons to other apps.

| Do | Don’t |
| --- | --- |
| “Hold to record, let go to pause.” | “Capture life’s magical moments!” |
| “About 100 KB. Light enough to send on one bar of signal.” | “Ultra-optimized next-gen compression.” |
| “When you’re caught up, we say so.” | “Never miss a thing.” |

## Do and don’t

**Do**

- Keep the period Rec, and let the mark be a button wherever it can be.
- Start the ring at twelve, with the canonical takes in every logo file. Only the live product draws other rings, from real takes.
- Give the wordmark its clear space and pick the reverse file on dark grounds.
- Use ink text on Rec and on lime.

**Don’t**

- Recolor, outline, shadow, gradient or animate the logo files, or rebuild the wordmark in a font.
- Rotate the take, change its gaps, or add a fourth take.
- Set the wordmark in all caps or follow it with another period.
- Use Rec for body text on light grounds, or put white text on Rec.
- Bring back cream backgrounds, serif italics or the viewfinder arrow.
- Show filters, beauty modes or anything that edits faces in brand imagery. Raw only.
