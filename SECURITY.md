# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| latest `main` | yes |
| `v0.1.0` (tag `capstone-submitted`, the capstone submission) | yes — critical fixes only |
| anything older | no |

## Reporting a vulnerability

**Report privately via GitHub Security Advisories** — the *Security* tab on
[github.com/msampath/fam-hub](https://github.com/msampath/fam-hub) → *Report a vulnerability*.
Please do **not** open a public issue for a vulnerability.

Include what you'd want yourself: affected run mode (appliance / dev / cloud), a reproduction, and
impact. This is a single-maintainer project — expect an acknowledgment within a few days, best
effort after that. Coordinated disclosure appreciated; you'll be credited unless you'd rather not be.

## Security model — what's actually enforced

The full adversarial review is in [`docs/security-review.md`](./docs/security-review.md); the short
version:

- **No-payment invariant, by architecture.** The agent never holds payment credentials and has no
  tool that can complete a purchase or transfer. Carts and reservations are **drafts** the parent
  completes — the Kroger integration writes to your cart via an API that has no checkout endpoint,
  and booking handoffs open a real page the human fills and submits. Even a worst-case prompt
  injection has no money-moving tool to reach.
- **Server-authoritative risk tiers.** Every mutating tool is classified auto / confirm /
  step-up-PIN in the MCP tool layer, server-side — never trusted to the model. Destructive
  operations are confirm-tier by construction (staged in the Approvals queue, applied on approval);
  the step-up PIN is scrypt-hashed and checked server-side.
- **Household isolation.** On the Supabase path, row-level security scopes every read and write to
  the caller's household (verified in the review: RLS on all tables, no service-role bypass in the
  data path). On the SQLite appliance, every storage-adapter call carries the authenticated
  household id, and the LAN is the trust boundary (passphrase → box-signed session).
- **Verified foundations.** Real JWT verification on every `/api` endpoint (not a decode-only
  stub), a thorough SSRF guard (per-redirect-hop re-validation, private-range and rebinding-aware
  blocking, backed by tests), helmet/CSP, no `dangerouslySetInnerHTML` anywhere, and no secrets in
  the client bundle.

## Honest posture — read this before deploying publicly

The current posture was reviewed for **personal, single-household use** (self-hosted LAN appliance
or one family's cloud deploy). Under that threat model the review found **0 critical / 0 high**
findings. Several knowns escalate to High the moment the app faces multiple untrusted users or the
public internet — they are deliberately deferred, not unknown: refresh-token-to-user binding, the
DNS-rebinding residual, server-side invite-join validation, PIN brute-force throttling, and digest
endpoint ingress gating, among others.

If you intend a **public or multi-tenant deploy**, read the *"Public-deploy security hardening
bundle"* in [`planning/roadmap.md`](./planning/roadmap.md) and the findings table in
[`docs/security-review.md`](./docs/security-review.md) first — and treat that list as gating work,
not suggestions.

## In scope

Anything that breaks the guarantees above: household-isolation (RLS/adapter) bypass, no-payment or
risk-tier bypass (getting the agent to mutate without the required tier), auth bypass on `/api`,
SSRF guard escapes, secret exposure. Out of scope: vulnerabilities requiring a deployment the docs
already warn against (e.g., exposing the dev server or the appliance to the open internet), and
denial-of-service against your own self-hosted box.
