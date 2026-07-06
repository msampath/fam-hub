// Mailer PORT (Phase-6): one `Mailer` interface, adapter per channel — Resend today, console for
// dev/appliance visibility, off for hard-disable; an SES/Gmail adapter is a ~30-line drop-in later.
// Selection: MAILER=resend|console|off, defaulting to resend when RESEND_API_KEY is set, else a
// skip-reporting no-op (the scheduler degrades cleanly and nothing is sent in dev — unchanged
// behavior from the pre-port mailer). Send-only to the user's own address — never a list.

export interface SendResult { ok: boolean; skipped?: boolean; error?: string }

export interface Mailer {
  name: string;
  send(to: string, subject: string, text: string): Promise<SendResult>;
}

const validRecipient = (to: string) => !!to && /.+@.+\..+/.test(to);

// Resend adapter — the production channel. `fetchImpl` injectable for tests.
export function resendMailer(fetchImpl: typeof fetch = fetch): Mailer {
  return {
    name: 'resend',
    async send(to, subject, text) {
      const key = process.env.RESEND_API_KEY;
      const from = process.env.DIGEST_FROM_EMAIL || 'Family-Hub <onboarding@resend.dev>';
      if (!key) return { ok: false, skipped: true }; // not configured → no send (documented production step)
      if (!validRecipient(to)) return { ok: false, error: 'invalid recipient' };
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
    },
  };
}

// Console adapter — prints instead of sending (appliance/dev visibility, overnight test runs).
export function consoleMailer(log: (s: string) => void = console.log): Mailer {
  return {
    name: 'console',
    async send(to, subject, text) {
      if (!validRecipient(to)) return { ok: false, error: 'invalid recipient' };
      log(`[mailer:console] to=${to}\nsubject: ${subject}\n${text}\n--- end of email ---`);
      return { ok: true };
    },
  };
}

// Off adapter — hard-disable: everything reports skipped (parity with "no key configured").
export const offMailer: Mailer = {
  name: 'off',
  async send() { return { ok: false, skipped: true }; },
};

// Adapter selection. Explicit MAILER wins; default = resend when configured, else skip-reporting off
// (EXACTLY the pre-port behavior — a keyless dev box never silently "sends" to the console).
export function makeMailer(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Mailer {
  const mode = (env.MAILER || '').trim().toLowerCase();
  if (mode === 'console') return consoleMailer();
  if (mode === 'off') return offMailer;
  if (mode === 'resend' || env.RESEND_API_KEY) return resendMailer(fetchImpl);
  return offMailer;
}

// Back-compat wrapper — the digest scheduler's original entry point, now routed through the port.
export async function sendDigestEmail(
  to: string,
  subject: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  return makeMailer(process.env, fetchImpl).send(to, subject, text);
}
