// Transactional email via Resend (the digest delivery channel). Opt-in + gated: with no RESEND_API_KEY the
// sender is a no-op that reports `skipped` (so the scheduler degrades cleanly and nothing is sent in dev).
// Send-only to the user's own address — never a list. `fetchImpl` injectable for tests.

export interface SendResult { ok: boolean; skipped?: boolean; error?: string }

export async function sendDigestEmail(
  to: string,
  subject: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM_EMAIL || 'Family-Hub <onboarding@resend.dev>';
  if (!key) return { ok: false, skipped: true }; // not configured → no send (documented production step)
  if (!to || !/.+@.+\..+/.test(to)) return { ok: false, error: 'invalid recipient' };
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (res.ok) return { ok: true };
    // Carry Resend's own message — a 403 names the real problem ("You can only send testing emails to
    // your own email address…" = sandbox mode / unverified domain), which is otherwise undiagnosable.
    const detail = await res.text().then(t => t.slice(0, 200)).catch(() => '');
    return { ok: false, error: `resend ${res.status}${detail ? ` — ${detail}` : ''}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'send failed' };
  }
}
