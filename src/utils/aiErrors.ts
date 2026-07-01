// Client-side mapping of an AI-endpoint failure to a clear, NON-BLOCKING message. On a total AI
// outage the server returns 503 { error, retryable: true } (every model overloaded / network down).
// Calendar, chores and shopping all work without AI, so we surface the busy message PLUS a context
// hint steering the user to manual entry / Paste-Text, rather than treating it as a hard error.
// Pure → unit-testable. (Graceful degradation when AI is down across all models.)

/** True when the failure is a transient "AI is busy" outage the user should just retry / route around. */
export function isAiBusy(status: number, body: any): boolean {
  return status === 503 || !!(body && body.retryable);
}

/**
 * Build the user-facing message for a failed AI request.
 * - busy outage (503/retryable): server's friendly text + the caller's manual-entry hint.
 * - any other failure: the server's specific error, else `fallback`.
 */
export function aiErrorMessage(status: number, body: any, fallback: string, manualHint?: string): string {
  const base = (body && body.error) || fallback;
  return isAiBusy(status, body) && manualHint ? `${base} ${manualHint}` : base;
}
