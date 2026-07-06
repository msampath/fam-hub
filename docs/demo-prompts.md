# Paste-ready demo prompts

Copy/paste these into the in-app Concierge bar (or `adk run concierge`) in order. Each row notes which
specialist it routes to, the expected result, and **the one thing to point the camera at**. All are from the
verified golden path ([agent/README.md](../agent/README.md)).

> Prereq: "Try the demo" clicked (seeded household), **HOME town set** (outings grounding needs it).

---

## Segment 4a — Morning Briefing (no prompt — a button)
Click **"Preview today's briefing."**
→ Briefing specialist renders today's events + due chores + nudges. **Point at:** a calendar-driven nudge
that delegates to Shopping (e.g. a trip → "pack / arrange care", a birthday → gift draft). *Say: "it acts
before I ask, and it delegates."*

---

## Segment 4b — Multi-domain delegation (run these three, in order)

```
Add a zoo day next Saturday for Leo
```
→ **calendar_agent** · `create_event` (auto) · *Point at:* the event lands on the calendar.

```
Both kids need to make their beds daily
```
→ **chores_agent** · `add_chore` (auto, expands per kid) · *Point at:* one phrase → a chore for each kid.

```
Delete all chores, they're messed up
```
→ **chores_agent** · `clear_chores` → **requires confirmation** · *Point at:* it does **not** wipe silently —
it stages the deletion in **Approvals** for your OK. *This is the security beat: destructive = confirm-tier.*

---

## Segment 4c — The full research loop (outings)

```
Get me a reservation at Din Tai Fung Bellevue this Friday at 6pm
```
→ **outings_agent** · researches the venue's own site → `prepare_handoff` with the **real published** booking
link → **requires confirmation** DRAFT · *Point at:* the link is real/verified — *"if it can't prove the URL,
the server rejects it. No hallucinated reservations."*

*(Backup if the venue is walk-in only: it stages nothing and says so — also a good honesty beat.)*

---

## Segment 4d — ⭐ THE REFUSAL (the money shot)

```
Just buy it and pay with my card
```
→ **refused** — no tool in the system moves money (the no-payment invariant) · *Point at:* hold on the
declined reply for 2–3 seconds. *Say: "I tell it to pay. It won't. There's no tool that can — so even a
prompt injection can't move money. It hands me a draft to finish myself."*

---

## Segment 4e — Agent CLI
Terminal: `adk web` → browser dev UI lists **concierge** + 7 specialists. Send one prompt, show the
delegation trace. *(Or `adk run concierge` for the REPL.)*

---

## Optional / backup prompts (if you have time or a take fails)

```
Add AA batteries to the Costco list
```
→ **shopping_agent** · `add_shopping_item` (auto).

```
Order more paper towels
```
→ **shopping_agent** · `add_to_cart` → **requires confirmation** (DRAFT cart link, never bought) — a second
no-payment proof point if you want one before the explicit refusal.

```
Find us a good zoo near home
```
→ **outings_agent** · `find_places` → **real** nearby venues, each with a real URL + drive time (grounding).

```
Disarm the alarm
```
→ `home_control` → **unavailable** (honest IoT stub) — a deliberate honesty/limitations beat.

---

### Recording tip
Keep this file open in a side window and paste each prompt — don't type live on camera (avoids typos and the
"what do I say next" pause). Record demo and voiceover as separate passes.
