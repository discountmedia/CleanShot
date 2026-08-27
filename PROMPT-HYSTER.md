# Hyster enhance prompt (CleanShot-optimised)

Paste **Prompt A** into the prompt box and save it as a shared template.
Keep **Prompt B** as a second template for photos where the fork tips are cropped.

Toggle settings are at the bottom and they matter — two of them will actively
fight this prompt if you tick them at the wrong time.

---

## Prompt A — standard (fork tips visible in frame)

Respray this Hyster in the same colour it already wears, factory-smooth with a light showroom gloss. Dents, deep gouges, bent hardware and missing parts stay clearly visible under the fresh paint — this should read as a cheap shop respray on a working used machine, not a restoration.

Every OEM decal, badge, capacity plate, data plate and serial number stays exactly where it is, at the same size and position, and as legible as it is in the photo.

Forks: repaint the fork shanks and blades bright fire-engine red, and paint the outer few inches of each blade safety yellow with a clean edge. Each fork keeps exactly the length and position it has in the photo. The load backrest and fork carriage stay black. The mast, chains, cylinders and any attachment keep the colour they already are.

Tyres: deep glossy wet-look shine on the rubber sidewalls, with tread, rims and hubs untouched. Sidewalls that are already white, cream or light grey are non-marking tyres — those keep the colour they already are and just get the gloss.

Floor: a clean light-grey epoxy showroom floor, lightly used, with a soft reflection under the unit and its contact shadow intact.

Operator station, when it is in the frame: plastics, vinyl and rubber freshly detailed — deep satin-black dash, clean seat, crisp coloured lever tips, fresh rubber pedal pads.

Finish: sharp professional product-photography clarity, rich accurate colour, freshly-waxed body panels.

---

## Prompt B — cropped fork tips

Identical to Prompt A, with the **Forks** paragraph replaced by:

Forks: repaint the fork shanks and blades bright fire-engine red, end to end, with no yellow anywhere. Each fork keeps exactly the length and position it has in the photo.

**Why two templates instead of one conditional sentence.** The original prompt
asked the model to look at the fork tips and decide whether to paint yellow.
That is the exact mechanism this repo measured as failing: with the tips out of
frame, the model **shortens the forks** so it has something to paint yellow.
Fork shortening is a top-line rubric defect and no whitelist line can authorise
it. Note that silence doesn't work either — omit yellow entirely and the model's
own prior paints it back in, which is why Prompt B says "no yellow anywhere"
explicitly rather than just not mentioning it.

---

## Toggles

| Toggle | Setting | Why |
|---|---|---|
| **Shine Tires** | **OFF** for white / cream / light-grey tyres | The toggle appends a literal "glossy black sidewalls, push the gloss harder" instruction **after** your prompt, so it outranks the non-marking exception by position. On the custom-prompt path it is the only source of the word "black" in the whole assembled prompt — ticking it on a non-marking unit manufactures the one defect nothing can authorise. Tick it only when the tyres are already dark. |
| **Perfect Showroom Floor** | OFF unless it's a genuine studio shot | The fragment self-cancels on outdoor/yard/warehouse photos, so on most used-unit shots it does nothing. On a real studio shot it *replaces* your epoxy floor with neutral #808080 polished concrete. **Never send both** — if you tick it, delete the Floor line from the prompt. |
| **Remove Rental-Fleet Branding** | ON if the unit carries Sunbelt / URI / Herc decals | Strips third-party rental decals while keeping OEM. |
| **Remove People** | ON if there are bystanders | — |
| **Remove Background Entirely** | ON only for the new-equipment site | Transparent PNG cutout, no watermark. Drop the Floor line if you use it — the floor is about to be deleted. |

---

## Model-number changes

**Do this after enhancing, not in the prompt.**

The `{{SOURCE_MODEL_TEXT}}` / `{{TARGET_MODEL_TEXT}}` placeholders never worked:
CleanShot has no variable substitution, so those braces went to Gemini literally.
And asking a generative pass to re-letter a decal is the weakest thing in the
pipeline — a legibly wrong model number is a straight FAIL by your own bar.

Use the **✎ Tweak** button on the finished variant and describe just that one
change. Be aware this routes to **Gemini**, which is the weaker option for
embedded text.

> **Known gap:** the Ideogram Edit tool — the one actually built for decal
> typography and model-number restoration — is fully wired in the backend and
> its dialog is still mounted, but **no button renders it any more**
> (`VariantThumb` in `SourceCompareCard.tsx` only draws ↻ Retry and ✎ Tweak).
> CLAUDE.md's "five small icons" table is stale. Restoring that button is a
> small frontend job and is the right fix if model-number work is routine.

---

## What was dropped from the original, and why

| Dropped | Reason |
|---|---|
| The 12-line **STRICT RULES** negation block | Emphatic "don't change X" measurably degrades Gemini output here — there is a reverted experiment on record (`48c653f` → `1585f46`). Every rule is now stated as the positive outcome. |
| **"Hyster factory yellow"** | Naming a brand colour asks the model what the colour *was*, inviting it to "correct" a faded or repainted unit toward a remembered palette. Swept out of the whole repo on 2026-08-21. |
| **Visual verification checklist** | An image model doesn't review and re-roll its own output. Pure length. |
| **Prompt assembly variables** preamble | No substitution engine exists. |
| **"Do NOT change the background"** | Conflicts with three of your own toggles. |
| **"Do NOT re-crop / change aspect ratio"** | Every output is cover-cropped to 2800x2000 regardless. |
| **~9,700 chars → ~1,400** | Written when `_describe_intended_edits` sliced the prompt at 1,500 characters, so at 9,700 the scanner saw only the preamble and the fork repaint, tyres, floor and paint were all eligible to be flagged as unintended. **That cap was removed 2026-08-27** — the whole prompt now reaches the scanner, so this is no longer a correctness fix. The shortening still stands on its own: the guardrails are appended anyway, and a sprawling prompt makes the quality check less discriminating. |

**Superseded 2026-08-27 — decals are a guardrail now.** The original note here read: *"Kept, against my first instinct: the decal-preservation sentence. I had cut it on the assumption that the automatic guardrail covers decals. It does not on the prompt-first path."* That was correct at the time and is the reason decal preservation was promoted into the GUARDRAILS block, where it is now appended on every path. A GENERIC "keep all the decals" sentence in an operator prompt is therefore redundant today. A SPECIFIC one is not — the guardrail can say "keep every decal as it is", but it cannot say "change the 50 to an 80".