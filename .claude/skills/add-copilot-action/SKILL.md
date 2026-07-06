---
name: add-copilot-action
description: Add a new quick-path copilot ACTION to Family-Hub (schema → validator/critic → ledger applier → UI surface → tests). Use when the in-app copilot should be able to stage/apply a new kind of change.
---

# add-copilot-action — a new approvable action through the whole safety pipe

Every copilot action rides the same contract: the model PROPOSES structured JSON → pure validators
clamp it → confirm-tier actions stage a LedgerEntry in Approvals → an APPLIER applies it on the
parent's approve. Follow the pipe in order:

1. **Schema** — add the action shape to `COPILOT_SCHEMA` (`src/utils/copilotPrompt.ts`) and the
   prompt contract (CLAIM=ACTION: the model may only claim what an emitted action actually does).
2. **Validate/clamp** — a pure builder in `src/utils/aiActions.ts` (clamp lengths, resolve
   members/dates against the live roster, drop garbage — model output is untrusted input). If the
   quick path can near-miss it, teach the critic (`src/utils/copilotCritic.ts` / `quickAddCritic.ts`)
   to verify + one corrective re-prompt.
3. **Risk tier** — auto (reversible, applies immediately) / confirm (stages an Approval) / stepup
   (PIN). Money-shaped? STOP — the no-payment invariant forbids it; stage a draft/handoff instead.
4. **Stage** — build the entry via `buildLedgerEntry` (`src/utils/historyLog.ts`) with a summary the
   parent can judge in one line; append via the ledger (capped).
5. **Apply** — add ONE applier to `LEDGER_APPLIERS` (`src/utils/ledgerAppliers.ts`), keyed by the
   tool name. Contract: resolve targets against the LIVE collections at approve time; transition the
   ledger via `ctx.markLedger` (or deliberately keep it PENDING for retryable externals); narrate via
   `ctx.say`. NO new branches in App.tsx — the registry dispatch handles it.
6. **Surface** — Approvals renders from the ledger automatically; only add UI if the action needs a
   custom card (see CopilotBar's handoff/booking rendering).
7. **Tests** — pure builder tests in `src/__tests__/aiActions.test.ts`-style; applier tests in
   `src/__tests__/ledgerAppliers.test.ts` with the mock ctx (approve + reject + the edge that makes
   this action special); a golden in `scripts/eval-quickpath.ts`'s set if the quick path emits it.
8. **Gate**: `/verify-suite`; run `npm run eval` + `eval:local` if the schema/prompt changed
   (Decision A must hold).

## Traps
- Resolve deletion targets by refId FIRST, title second — and refuse ambiguous title-only matches
  (see delete_event's blocked path): scope must never exceed what the parent approved.
- USER_COMPLETES (`src/constants.ts`) decides Actions-vs-Approvals surfaces — handoff-style tools the
  PARENT completes belong there, not in Approvals.
