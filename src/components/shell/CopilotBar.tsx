import { useState, useRef, useEffect, type FormEvent } from 'react';
import { Settings, Paperclip, Mail, Cloud, RotateCcw } from 'lucide-react';
import { useCalendar } from '../../CalendarContext';
import { useApp } from '../../AppContext';
import { suggestionKey } from '../../utils/aiActions';
import { isAgentConfigured } from '../../utils/agentClient';
import { USER_COMPLETES } from '../../constants';
import { useSpeechInput } from '../../hooks/useSpeechInput';
import type { CopilotSuggestion } from '../../types';
import ImportDrawer from './ImportDrawer';
import Modal from './Modal';
import ChatMarkdown from './ChatMarkdown';
import { C, brutShadow } from './theme';

const AGENT_ON = isAgentConfigured();

type ScanKind = 'bills' | 'packages' | 'kids';
const SCAN_LABEL: Record<ScanKind, string> = { bills: 'Bills', packages: 'Packages', kids: "Kids'" };

interface CopilotBarProps {
  onOpenManage: () => void;
}

// The single persistent interaction surface (spec §5). The top bar IS the one copilot input
// (ask, or tell it to do something); focusing it opens the panel. Expanded = Ask (the answer
// thread) · Do (acts) · Approve (ledger drafts — the no-payment safety surface). One input only.
export default function CopilotBar({ onOpenManage }: CopilotBarProps) {
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);   // "Actions (#)" modal — proactive email finds
  const [approvalsOpen, setApprovalsOpen] = useState(false); // "Approvals (#)" modal — drafts awaiting approval
  const { copilotMessages, isCopilotThinking, handleSendCopilotMessage } = useCalendar();
  // The copilot input is LOCAL state (not in the shared CalendarContext): typing here used to mutate the
  // context on every keystroke and re-render the whole app. Local → only this bar re-renders. (§3.3)
  const [copilotInput, setCopilotInput] = useState('');
  const {
    actionLedger, approveLedgerEntry, rejectLedgerEntry, reviseLedgerEntry, verifyStepUpPin, hasStepUpPin,
    scanEmailForBills, scanEmailForPackages, scanEmailForKidsActivities, handleCreateSuggestion, addedSuggestionKeys,
    autoEmailSuggestions, autoScanActive, kidMode, setKidMode, copilotName,
  } = useApp();

  // Kid-mode exit gate: hold the 🔒 chip for 3s (a deliberate-adult gesture), then — if a step-up PIN is
  // set — verify it before unlocking. The PIN reuses the existing server-side scrypt verify; no new server
  // surface. KAGGLE_EVAL: Security — the kid-safe device lock and its step-up unlock.
  const holdTimerRef = useRef<number | null>(null);
  const startExitHold = () => {
    if (holdTimerRef.current != null) return;
    holdTimerRef.current = window.setTimeout(async () => {
      holdTimerRef.current = null;
      if (hasStepUpPin) {
        const pin = window.prompt('Parent PIN to exit kid mode:') || '';
        if (!pin || !(await verifyStepUpPin(pin))) return;
      }
      setKidMode(false);
    }, 3000);
  };
  const cancelExitHold = () => {
    if (holdTimerRef.current != null) { window.clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  };

  const pending = actionLedger.filter(e => e.status === 'pending');
  const resolved = actionLedger.filter(e => e.status !== 'pending');
  // Two buckets, by WHO completes the work: USER_COMPLETES handoffs (booking/cart/pass — you open & finish
  // them yourself) are "Actions"; everything else pending (delete/reschedule event, push to Google, …) is an
  // "Approval" the AGENT executes once you OK it. Derived from `tool` — no LedgerEntry schema change.
  const pendingActions = pending.filter(e => USER_COMPLETES.has(e.tool));    // you do it
  const pendingApprovals = pending.filter(e => !USER_COMPLETES.has(e.tool)); // the agent does it
  // Partition RESOLVED history the same way, so a completed handoff (a user Action) doesn't conjure a phantom
  // "Approvals" badge or get filed under agent-Approvals history. Completed Actions live in the Actions modal.
  const resolvedApprovals = resolved.filter(e => !USER_COMPLETES.has(e.tool));
  const resolvedActions = resolved.filter(e => USER_COMPLETES.has(e.tool));
  // Proactive auto-scan finds not yet added (filtered live so added ones disappear immediately).
  const newEmail = autoEmailSuggestions.filter(s => !addedSuggestionKeys.has(suggestionKey(s)));
  // The Actions badge = email finds + staged handoffs (both are "things you do").
  const actionsCount = newEmail.length + pendingActions.length;
  const [historyOpen, setHistoryOpen] = useState(false);
  // "Clear" the on-screen thread — VIEW ONLY. Hides messages at indices below this marker; it does NOT touch
  // `copilotMessages` state, the persisted `famplan_copilot_messages`, or the agent's slice(-8) memory. Ephemeral
  // (resets on reload). Set to copilotMessages.length to hide everything currently in the thread.
  const [viewHiddenBefore, setViewHiddenBefore] = useState(0);
  const noneVisible = viewHiddenBefore >= copilotMessages.length;

  // Open a draft/handoff booking link in a NEW TAB of the existing browser (mobile: the browser); the app
  // stays in its own tab to return to. Guarded to http(s) so a bad link can't become a javascript:/data: vector.
  const openLink = (url?: string) => {
    if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  };
  // Keep the newest chat message in view: scroll the transcript to the bottom on new messages / when opened.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [copilotMessages, isCopilotThinking, open]);

  // Email scans (B1 bills / B2 packages / B3 kids) → tap-to-add suggestion chips.
  const [scanning, setScanning] = useState<ScanKind | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<CopilotSuggestion[]>([]);
  const runScan = async (kind: ScanKind) => {
    setScanning(kind); setScanMsg(null);
    const fn = kind === 'bills' ? scanEmailForBills : kind === 'packages' ? scanEmailForPackages : scanEmailForKidsActivities;
    const r = await fn();
    setScanning(null);
    if (r.error) { setScanMsg(r.error); setScanResults([]); return; }
    setScanResults(r.suggestions);
    setScanMsg(`Scanned ${r.scanned} email${r.scanned === 1 ? '' : 's'} · ${r.suggestions.length} found`);
  };
  const suggestionChip = (s: CopilotSuggestion, key: string | number) => {
    const added = addedSuggestionKeys.has(suggestionKey(s));
    return (
      <button
        key={key}
        type="button"
        disabled={added}
        onClick={() => handleCreateSuggestion(s)}
        className="rounded-full px-2.5 py-1 text-[11px] font-bold"
        style={added
          ? { border: `2px solid ${C.emerald}`, color: C.emerald, background: `${C.emerald}14` }
          : { border: `2px solid ${C.indigo}`, color: C.indigo, background: `${C.indigo}14` }}
      >
        {added ? '✓ ' : '+ '}{s.title}
      </button>
    );
  };

  // Step-up PIN gate: high-risk (stepup-tier) drafts require the security PIN before approval (A3).
  const [pinForId, setPinForId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const resetPin = () => { setPinForId(null); setPin(''); setPinErr(null); setVerifying(false); };
  const onApprove = (id: string, riskTier: string) => {
    if (riskTier === 'stepup') {
      setPinForId(id); setPin(''); setPinErr(hasStepUpPin ? null : 'Set a security PIN in Manage first.');
      return;
    }
    approveLedgerEntry(id);
  };
  const submitPin = async (id: string) => {
    if (verifying) return; // concurrency guard against double-submit
    if (!hasStepUpPin) { setPinErr('Set a security PIN in Manage first.'); return; }
    setVerifying(true); setPinErr(null);
    const ok = await verifyStepUpPin(pin);
    setVerifying(false);
    if (ok) { resetPin(); approveLedgerEntry(id, true); } // verified → logic layer allows the stepup approve
    else setPinErr('Incorrect PIN.');
  };

  // HITL "Modify" (#4): steer a pending draft in plain language instead of rejecting it.
  const [modifyForId, setModifyForId] = useState<string | null>(null);
  const [modifyText, setModifyText] = useState('');
  const [revising, setRevising] = useState(false);
  const [modifyErr, setModifyErr] = useState<string | null>(null);
  const resetModify = () => { setModifyForId(null); setModifyText(''); setRevising(false); setModifyErr(null); };
  const submitModify = async (id: string) => {
    if (revising || !modifyText.trim()) return;
    setRevising(true); setModifyErr(null);
    const r = await reviseLedgerEntry(id, modifyText.trim());
    setRevising(false);
    if (r.ok) resetModify();
    else setModifyErr(r.error || 'Could not revise that draft.');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = copilotInput.trim();
    if (!text) return;
    setCopilotInput('');
    handleSendCopilotMessage(text);
    setOpen(true);
  };

  // Voice input (W6): interim transcripts stream into the input; the FINAL transcript submits through
  // the exact same pipeline as typing (grounding, critic, confirm tiers, Approvals) — hands-free entry,
  // identical safety. Unsupported browsers never render the mic.
  const speech = useSpeechInput((text, isFinal) => {
    setCopilotInput(text);
    if (isFinal && text.trim()) {
      setCopilotInput('');
      handleSendCopilotMessage(text.trim());
      setOpen(true);
    }
  });

  // Per-turn escalate: re-run the user question that produced THIS local reply, forced to the cloud agent.
  const escalateTurn = (assistantIdx: number) => {
    if (isCopilotThinking) return;
    const userText = [...copilotMessages.slice(0, assistantIdx)].reverse().find(m => m.role === 'user')?.text;
    if (userText) { handleSendCopilotMessage(userText, { forced: true }); setOpen(true); }
  };

  // Retry a failed turn (both engines were down): re-run the SAME user question through the normal routing.
  const retryTurn = (assistantIdx: number) => {
    if (isCopilotThinking) return;
    const userText = [...copilotMessages.slice(0, assistantIdx)].reverse().find(m => m.role === 'user')?.text;
    if (userText) { handleSendCopilotMessage(userText); setOpen(true); }
  };

  const colLabel = (text: string, color: string) => (
    <div className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.12em]" style={{ color }}>{text}</div>
  );

  return (
    <div
      className="flex-shrink-0 px-4 py-3 md:px-8"
      style={{ background: C.app, borderBottom: '2px solid #161c2e', zIndex: 20, paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
    >
      {/* Mobile: the input wraps to its OWN full-width row below the icon cluster (so you see what you type —
          on a narrow phone the 5 trailing icons otherwise squeeze it to ~5 characters). Desktop: one row. */}
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-2.5 md:flex-nowrap md:gap-3.5">
        {/* Logo doubles as the AI toggle: click to collapse the open thread back to the clean bar (#5). */}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-label={open ? 'Collapse copilot' : 'Open copilot'}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Open copilot'}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[14px] text-xl font-black md:h-11 md:w-11"
          style={{ background: C.indigo, color: '#fff', border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 4) }}
        >
          ✦
        </button>

        {/* The single copilot input — full-width on its own row on mobile (order-last + w-full), inline flex-1 on desktop. */}
        <form onSubmit={submit} className="order-last flex w-full items-center gap-2 md:order-none md:w-auto md:flex-1">
          <input
            value={copilotInput}
            onChange={e => setCopilotInput(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder={speech.listening ? 'Listening…' : 'Ask me, or tell me to do it…'}
            aria-label="Ask the copilot"
            className="w-full min-w-0 flex-1 rounded-[14px] px-4 py-3 text-base font-semibold outline-none"
            style={{ border: `2px solid ${speech.listening ? C.emerald : C.elevated}`, boxShadow: brutShadow(C.elevated, 4), background: C.pill, color: C.primary }}
          />
          {/* Mic (W6, feature-detected): tap to speak; the final transcript submits like a typed ask. */}
          {speech.supported && (
            <button
              type="button"
              onClick={speech.toggle}
              aria-label={speech.listening ? 'Stop listening' : 'Speak to the copilot'}
              title={speech.listening ? 'Listening — tap to stop' : 'Speak instead of typing'}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[13px] text-lg"
              style={speech.listening
                ? { border: `2px solid ${C.emerald}`, background: `${C.emerald}1a`, color: C.emerald, animation: 'screensaverPulse 1.6s ease-in-out infinite' }
                : { border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
            >
              🎤
            </button>
          )}
        </form>

        {/* Actions (#) — proactive email finds to act on + manual inbox scans; opens the Actions modal.
            Always available (so a manual scan is reachable); prominent when there are finds, subtle at 0.
            Kid mode hides Actions/Approvals/Import/Manage below — the bar becomes ask-only; the input stays
            because every destructive tool is confirm-tier, so a kid's request can only STAGE a draft. */}
        {!kidMode && <button
          type="button"
          onClick={() => setActionsOpen(true)}
          aria-label={`Actions (${actionsCount})`}
          title="Things for you to do — email finds + booking/pass handoffs to open & complete"
          className="flex min-h-[44px] flex-shrink-0 items-center gap-1.5 rounded-[13px] px-3 py-2.5 text-xs font-extrabold"
          style={actionsCount > 0
            ? { border: `2px solid ${C.emerald}`, background: `${C.emerald}14`, color: C.emerald }
            : { border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
        >
          <Mail size={14} /><span className="hidden sm:inline">Actions</span>
          {actionsCount > 0 && (
            <span className="flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-1 text-[11px] font-black" style={{ background: C.emerald, color: C.app }}>{actionsCount}</span>
          )}
        </button>}

        {/* Approvals (#) — drafts awaiting approval; opens the Approvals modal. Stays present (subtle) once the
            queue empties but history exists, so the approved/rejected audit trail doesn't become unreachable. */}
        {!kidMode && (pendingApprovals.length > 0 || resolvedApprovals.length > 0) && (
          <button
            type="button"
            onClick={() => { setApprovalsOpen(true); setHistoryOpen(false); }}
            aria-label={pendingApprovals.length > 0 ? `Approvals (${pendingApprovals.length})` : `Approvals history (${resolvedApprovals.length})`}
            title={pendingApprovals.length > 0 ? 'Changes the copilot will make once you approve' : 'History of approved / rejected actions'}
            className="flex min-h-[44px] flex-shrink-0 items-center gap-2 rounded-[13px] px-3 py-2.5 text-xs font-extrabold uppercase tracking-[0.06em] md:px-4"
            style={pendingApprovals.length > 0
              ? { border: `2px solid ${C.amber}`, boxShadow: brutShadow(C.amberShadow, 4), background: `${C.amber}14`, color: C.amber }
              : { border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
          >
            {/* Show a COUNT only when something is actually pending; history-only renders just "Approvals"
                (always visible — it's the button's only content then). The audit trail stays reachable via
                the aria-label/title, without a tag that reads as something new to handle. */}
            <span className={pendingApprovals.length > 0 ? 'hidden sm:inline' : undefined}>Approvals</span>
            {pendingApprovals.length > 0 && (
              <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-[11px] font-black" style={{ background: C.amber, color: C.app }}>{pendingApprovals.length}</span>
            )}
          </button>
        )}

        {/* Import (URL / text / PDF → calendar) */}
        {!kidMode && <button
          type="button"
          onClick={() => setImportOpen(o => !o)}
          aria-label="Import"
          title="Import from URL, text, or PDF"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] md:h-11 md:w-11"
          style={importOpen
            ? { border: `2px solid ${C.indigo}`, background: `${C.indigo}1a`, color: C.indigo }
            : { border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
        >
          <Paperclip size={18} />
        </button>}

        {/* Manage — replaced in kid mode by the 🔒 hold-to-exit chip (3s hold, then PIN if set). */}
        {!kidMode ? (
          <button
            type="button"
            onClick={onOpenManage}
            aria-label="Manage"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] md:h-11 md:w-11"
            style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
          >
            <Settings size={18} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Exit kid mode (press and hold)"
            title="Kid mode is on — press and hold 3 seconds to exit"
            onPointerDown={startExitHold}
            onPointerUp={cancelExitHold}
            onPointerLeave={cancelExitHold}
            className="flex h-10 w-10 flex-shrink-0 select-none items-center justify-center rounded-[13px] text-base md:h-11 md:w-11"
            style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted, touchAction: 'none' }}
          >
            🔒
          </button>
        )}
      </div>

      {importOpen && <ImportDrawer onClose={() => setImportOpen(false)} />}

      {/* ONE surface: a single scrollable chat window. Actions + Approvals live behind the two badges above. */}
      {open && (
        <div className="mx-auto mt-2.5 max-w-[1200px] rounded-[14px] p-3.5" style={{ border: `2px solid ${C.elevated}`, background: C.pill }}>
          <div className="mb-2.5 flex items-center justify-between gap-2">
            {colLabel(copilotName, C.indigo)}
            <div className="flex items-center gap-3">
              {!kidMode && actionsCount > 0 && <button type="button" onClick={() => setActionsOpen(true)} className="text-[10px] font-bold uppercase" style={{ color: C.emerald }}>Actions ({actionsCount})</button>}
              {!kidMode && pendingApprovals.length > 0 && <button type="button" onClick={() => setApprovalsOpen(true)} className="text-[10px] font-bold uppercase" style={{ color: C.amber }}>Approvals ({pendingApprovals.length})</button>}
              {/* Clear the on-screen thread (declutter) — view-only; history + agent memory are kept. */}
              {!noneVisible && <button type="button" onClick={() => setViewHiddenBefore(copilotMessages.length)} className="text-[10px] font-bold uppercase" style={{ color: C.ink }}>Clear</button>}
              <button type="button" onClick={() => setOpen(false)} className="text-[10px] font-bold uppercase" style={{ color: C.ink }}>Close</button>
            </div>
          </div>
          <div ref={scrollRef} className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
            {noneVisible && (
              <div className="text-[13px]" style={{ color: C.ink }}>Ask about your week, plans, or what's free — or tell me to add something.</div>
            )}
            {copilotMessages.map((m, i) => (
              i < viewHiddenBefore ? null :
              <div key={i} className="flex flex-col gap-1.5">
                <div
                  className="px-3 py-2 text-[13px] font-medium"
                  style={m.role === 'user'
                    ? { background: C.indigo, color: '#fff', borderRadius: '10px 10px 2px 10px' }
                    : { background: C.elevated, color: C.primary, borderRadius: '2px 10px 10px 10px' }}
                >
                  {m.role === 'assistant' ? <ChatMarkdown text={m.text} /> : m.text}
                </div>
                {/* ONE concierge to the user — this is a SUBTLE engine+model tag (which engine served the
                    concierge), not a separate-assistant brand. Kept muted so cloud/local stays visible through
                    the cloud→local migration. */}
                {m.role === 'assistant' && m.source === 'agent' && (
                  <span className="px-1 text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: C.muted }}>☁ cloud{m.model ? ` · ${m.model}` : ''}</span>
                )}
                {/* The concierge's full (tool-using) engine was unreachable, so this is the limited stand-in —
                    same brand, just degraded. NOT "offline" (it still runs on the cloud), NOT a second assistant. */}
                {m.role === 'assistant' && m.source === 'fallback' && (
                  <span className="px-1 text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: '#fbbf24' }}>⚠ limited mode</span>
                )}
                {/* Dead-end failure (both engines down): one-tap Retry re-runs the same question. */}
                {m.role === 'assistant' && m.error && (
                  <button
                    type="button"
                    onClick={() => retryTurn(i)}
                    disabled={isCopilotThinking}
                    className="flex w-fit items-center gap-1 rounded-[8px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors disabled:opacity-40"
                    style={{ color: C.indigo, border: `1.5px solid ${C.indigo}` }}
                  >
                    <RotateCcw size={12} /> Retry
                  </button>
                )}
                {/* Per-turn escalate — GREYED for now (owner): the concierge defaults to its full (cloud)
                    engine, so manual escalate is redundant. KEPT (disabled) as the hook for when the LOCAL
                    tool-using engine (gpt-oss) comes online — escalateTurn stays wired for that revival. */}
                {m.role === 'assistant' && m.source === 'local' && AGENT_ON && (
                  <button
                    type="button"
                    onClick={() => escalateTurn(i)}
                    disabled
                    title="Use the full copilot — disabled for now (returns when the local engine is enabled)"
                    className="flex w-fit cursor-not-allowed items-center gap-1 rounded-[8px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] opacity-40"
                    style={{ color: C.muted }}
                  >
                    <Cloud size={12} /> Escalate
                  </button>
                )}
                {m.role === 'assistant' && m.suggestions && m.suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.suggestions.map((s, si) => suggestionChip(s, si))}
                  </div>
                )}
              </div>
            ))}
            {isCopilotThinking && (
              <div className="flex items-center gap-1.5 text-[13px]" style={{ color: C.ink }}>
                <span>Thinking</span>
                <span className="flex items-center gap-1">
                  {[0, 1, 2].map(d => (
                    <span
                      key={d}
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: C.ink, animation: 'typingDot 1.2s ease-in-out infinite', animationDelay: `${d * 0.15}s` }}
                    />
                  ))}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Actions modal — proactive email finds to act on + on-demand inbox scans */}
      {actionsOpen && (
        <Modal label="Actions" accent={C.emerald} onClose={() => setActionsOpen(false)}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-base font-extrabold" style={{ color: C.emerald }}>⚡ Actions{actionsCount ? ` (${actionsCount})` : ''}</div>
              <button type="button" onClick={() => setActionsOpen(false)} className="rounded-[9px] px-3 py-1.5 text-[12px] font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.primary }}>Close</button>
            </div>
            {/* Staged handoffs the concierge prepared for YOU to finish (bookings, passes, carts). The agent
                can't submit/pay — you Open the page, complete it, then mark Done. Full text wraps (no clamp). */}
            {pendingActions.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wide" style={{ color: C.emerald }}>🛎️ Staged for you — open &amp; complete</div>
                <div className="flex flex-col gap-2">
                  {pendingActions.map(e => (
                    <div key={e.id} className="rounded-[10px] p-2.5" style={{ border: `2px solid ${C.elevated}` }}>
                      <div className="mb-1.5 text-[13px] font-bold" style={{ color: C.primary }}>{e.summary || e.tool}</div>
                      <div className="flex flex-wrap gap-2">
                        {e.link && /^https?:\/\//i.test(e.link) && (
                          <button type="button" onClick={() => openLink(e.link)} className="rounded-[7px] px-3 py-1.5 text-[11px] font-extrabold" style={{ background: C.indigo, color: '#fff' }}>Open →</button>
                        )}
                        <button type="button" onClick={() => approveLedgerEntry(e.id)} className="rounded-[7px] px-3 py-1.5 text-[11px] font-extrabold" style={{ background: C.emerald, color: C.app }}>Done</button>
                        <button type="button" onClick={() => rejectLedgerEntry(e.id)} className="rounded-[7px] px-3 py-1.5 text-[11px] font-bold" style={{ background: 'transparent', color: C.ink, border: `2px solid ${C.elevated}` }}>Dismiss</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Completed/dismissed handoffs stay discoverable HERE (where you did them) — a booking you marked
                Done may still be openable (you might not have finished submitting). Not in Approvals history. */}
            {resolvedActions.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wide" style={{ color: C.ink }}>✓ Done</div>
                <div className="flex flex-col gap-1.5">
                  {resolvedActions.slice().reverse().map(e => (
                    <div key={e.id} className="flex items-center justify-between gap-2 rounded-[10px] px-2.5 py-1.5" style={{ border: `2px solid ${C.elevated}` }}>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" style={{ color: C.muted }}>{e.summary || e.tool}</span>
                      {e.link && /^https?:\/\//i.test(e.link) && (
                        <button type="button" onClick={() => openLink(e.link)} className="flex-shrink-0 text-[10px] font-extrabold uppercase" style={{ color: C.indigo }}>Open →</button>
                      )}
                      <span className="text-[10px] font-extrabold uppercase" style={{ color: e.status === 'rejected' ? C.ink : C.emerald }}>{e.status === 'rejected' ? 'dismissed' : 'done'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {newEmail.length > 0 ? (
              <div className="mb-3">
                <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wide" style={{ color: C.emerald }}>📬 New from email — tap to add</div>
                <div className="flex flex-wrap gap-1.5">{newEmail.map((s, i) => suggestionChip(s, `auto-${i}`))}</div>
              </div>
            ) : autoScanActive ? (
              <div className="mb-3 text-[12px] font-semibold" style={{ color: C.ink }}>📭 Auto-scan on — checking your inbox every 30 min. Nothing new right now.</div>
            ) : null}
            <div className="mb-2 text-[12px] font-medium" style={{ color: C.ink }}>Scan your email now:</div>
            <div className="flex flex-wrap gap-1.5">
              {(['bills', 'packages', 'kids'] as ScanKind[]).map(kind => (
                <button key={kind} type="button" disabled={scanning !== null} onClick={() => runScan(kind)} className="flex items-center gap-1 rounded-[9px] px-2.5 py-1.5 text-[11px] font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.muted, opacity: scanning !== null ? 0.6 : 1 }}>
                  <Mail size={12} /> {scanning === kind ? 'Scanning…' : SCAN_LABEL[kind]}
                </button>
              ))}
            </div>
            {scanMsg && <div className="mt-2 text-[11px] font-semibold" style={{ color: C.muted }}>{scanMsg}</div>}
            {scanResults.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">{scanResults.map((s, i) => suggestionChip(s, `scan-${i}`))}</div>
            )}
        </Modal>
      )}

      {/* Approvals modal — drafts awaiting approval + the step-up PIN gate. onClose is guarded so a stray
          backdrop/Escape can't discard a half-typed step-up PIN (the explicit Close button still works). */}
      {approvalsOpen && (
        <Modal label="Approvals" accent={C.amber} onClose={() => { if (pinForId) return; setApprovalsOpen(false); }}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-base font-extrabold" style={{ color: C.amber }}>🛎️ Approvals{pendingApprovals.length ? ` (${pendingApprovals.length})` : ''}</div>
              <div className="flex items-center gap-2">
                {resolvedApprovals.length > 0 && (
                  <button type="button" onClick={() => setHistoryOpen(h => !h)} className="text-[10px] font-bold uppercase" style={{ color: C.ink }}>{historyOpen ? 'Pending' : 'History'}</button>
                )}
                <button type="button" onClick={() => setApprovalsOpen(false)} className="rounded-[9px] px-3 py-1.5 text-[12px] font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.primary }}>Close</button>
              </div>
            </div>
            {historyOpen ? (
              <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
                {resolvedApprovals.slice().reverse().map(e => (
                  <div key={e.id} className="flex items-center justify-between gap-2 rounded-[10px] px-2.5 py-1.5" style={{ border: `2px solid ${C.elevated}` }}>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" style={{ color: C.muted }}>{e.summary || e.tool}</span>
                    {/* An approved booking is still openable from history — the parent may not have submitted it yet. */}
                    {e.link && /^https?:\/\//i.test(e.link) && (
                      <button type="button" onClick={() => openLink(e.link)} className="flex-shrink-0 text-[10px] font-extrabold uppercase" style={{ color: C.indigo }}>Open →</button>
                    )}
                    <span className="text-[10px] font-extrabold uppercase" style={{ color: e.status === 'applied' || e.status === 'approved' ? C.emerald : e.status === 'failed' || e.status === 'rejected' ? C.red : C.muted }}>{e.status}</span>
                  </div>
                ))}
              </div>
            ) : pendingApprovals.length === 0 ? (
              <div className="text-[13px] font-medium" style={{ color: C.ink }}>Nothing to approve. Changes the copilot will make for you — deleting/rescheduling an event, pushing to Google — collect here for your OK. (Bookings you complete yourself live under Actions.)</div>
            ) : (
              <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
                {pendingApprovals.map(e => (
                  <div key={e.id} className="rounded-[10px] p-2.5" style={{ border: `2px solid ${C.elevated}` }}>
                    <div className="mb-1 text-[13px] font-bold" style={{ color: C.primary }}>{e.summary || e.tool}</div>
                    {e.riskTier === 'stepup' && (
                      <div className="mb-2 text-[10px] font-extrabold uppercase tracking-wide" style={{ color: C.amber }}>🔒 PIN required</div>
                    )}
                    {pinForId === e.id ? (
                      <form onSubmit={ev => { ev.preventDefault(); submitPin(e.id); }} className="flex flex-col gap-1.5">
                        <input
                          value={pin}
                          onChange={ev => setPin(ev.target.value)}
                          inputMode="numeric"
                          autoFocus
                          disabled={verifying}
                          placeholder="Enter security PIN"
                          aria-label="Security PIN"
                          className="rounded-[7px] px-2.5 py-1.5 text-[13px] outline-none"
                          style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }}
                        />
                        <div className="flex gap-2">
                          <button type="submit" disabled={verifying || !hasStepUpPin} className="rounded-[7px] px-3 py-1.5 text-[11px] font-extrabold" style={{ background: C.brut, color: C.app, opacity: verifying || !hasStepUpPin ? 0.5 : 1 }}>
                            {verifying ? 'Verifying…' : 'Confirm'}
                          </button>
                          <button type="button" onClick={resetPin} className="rounded-[7px] px-3 py-1.5 text-[11px] font-bold" style={{ background: 'transparent', color: C.ink, border: `2px solid ${C.elevated}` }}>Cancel</button>
                        </div>
                        {pinErr && <div className="text-[11px] font-semibold" style={{ color: C.red }}>{pinErr}</div>}
                      </form>
                    ) : modifyForId === e.id ? (
                      <form onSubmit={ev => { ev.preventDefault(); submitModify(e.id); }} className="flex flex-col gap-1.5">
                        <input
                          value={modifyText}
                          onChange={ev => setModifyText(ev.target.value)}
                          autoFocus
                          disabled={revising}
                          placeholder="What should change? e.g. “make it vegetarian”"
                          aria-label="How to change this draft"
                          className="rounded-[7px] px-2.5 py-1.5 text-[13px] outline-none"
                          style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }}
                        />
                        <div className="flex gap-2">
                          <button type="submit" disabled={revising || !modifyText.trim()} className="rounded-[7px] px-3 py-1.5 text-[11px] font-extrabold" style={{ background: C.brut, color: C.app, opacity: revising || !modifyText.trim() ? 0.5 : 1 }}>
                            {revising ? 'Revising…' : 'Revise'}
                          </button>
                          <button type="button" onClick={resetModify} className="rounded-[7px] px-3 py-1.5 text-[11px] font-bold" style={{ background: 'transparent', color: C.ink, border: `2px solid ${C.elevated}` }}>Cancel</button>
                        </div>
                        {modifyErr && <div className="text-[11px] font-semibold" style={{ color: C.red }}>{modifyErr}</div>}
                      </form>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {/* Defensive: most approvals (event edits, Google-push) carry no link — handoffs you open
                            yourself live under Actions now. If an approval does have a link, just open it. */}
                        {e.link && /^https?:\/\//i.test(e.link) && (
                          <button type="button" onClick={() => openLink(e.link)} className="rounded-[7px] px-3 py-1.5 text-[11px] font-extrabold" style={{ background: C.indigo, color: '#fff' }}>Open →</button>
                        )}
                        <button type="button" onClick={() => onApprove(e.id, e.riskTier)} className="rounded-[7px] px-3 py-1.5 text-[11px] font-extrabold" style={{ background: C.brut, color: C.app }}>Approve</button>
                        <button type="button" onClick={() => { resetModify(); setModifyForId(e.id); }} className="rounded-[7px] px-3 py-1.5 text-[11px] font-bold" style={{ background: 'transparent', color: C.primary, border: `2px solid ${C.elevated}` }}>Modify</button>
                        <button type="button" onClick={() => rejectLedgerEntry(e.id)} className="rounded-[7px] px-3 py-1.5 text-[11px] font-bold" style={{ background: 'transparent', color: C.ink, border: `2px solid ${C.elevated}` }}>Dismiss</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
        </Modal>
      )}
    </div>
  );
}
