// Voice input (W6): Web Speech API speech-to-text for the copilot bar — the phone-first "talk to
// the hub" path. Feature-detected (Chrome/Edge/Safari expose webkitSpeechRecognition; Firefox has
// none) and gracefully absent: unsupported browsers simply never see the mic button. The transcript
// rides the EXISTING input → copilot pipeline, so every safety gate (critic, confirm tiers,
// Approvals) applies to a spoken request exactly as to a typed one.
//
// Press-and-hold with SESSION RESTART — the second iteration of this fix. The first press-and-hold
// version (start on press, stop on release, continuous=true) still cut out in under a second on
// desktop, because Chrome's recognition SERVICE ends sessions on its own (silence detection, speech-
// service hiccups) regardless of `continuous` — and any session end looked like a release. So the
// hold gesture and the recognition session are now decoupled: while the button is physically held
// (`holding`), a session that ends gets RESTARTED immediately and its text accumulates across
// sub-sessions; only a real release (or a run of consecutive errored sessions — dead mic, no speech
// service) finalizes and submits. This is the standard dictation-app pattern for Chrome's Web Speech.
import { useEffect, useRef, useState } from 'react';

type RecognitionLike = {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
};

const getRecognitionCtor = (): (new () => RecognitionLike) | null =>
  ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) ?? null;

// Give up restarting after this many CONSECUTIVE sub-sessions that errored without producing any
// speech (mic dead / service unreachable) — a working session resets the run via onresult.
const MAX_ERROR_RUN = 3;

export interface SpeechInput {
  supported: boolean;
  listening: boolean;
  /** Call on press (pointerdown). Interim transcripts stream via onTranscript(text, false). */
  start: () => void;
  /** Call on release (pointerup/pointercancel). The accumulated transcript arrives as (text, true). */
  stop: () => void;
}

export function useSpeechInput(onTranscript: (text: string, isFinal: boolean) => void): SpeechInput {
  const [listening, setListening] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);
  const holdingRef = useRef(false); // physical press state — outlives any one recognition session
  const baseTextRef = useRef('');   // text carried over from earlier sub-sessions of THIS hold
  const sessTextRef = useRef('');   // the current sub-session's text (its result indices restart at 0)
  const errRunRef = useRef(0);      // consecutive sub-sessions that ended in error with no speech
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;
  const supported = typeof window !== 'undefined' && !!getRecognitionCtor();

  useEffect(() => () => { holdingRef.current = false; recRef.current?.abort?.(); }, []); // unmount: kill any live session

  // One recognition sub-session. Returns false if it could not start (feature/permission failure).
  const spawn = (): boolean => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true; // the hold/release gesture controls the session, not the first detected pause
    sessTextRef.current = '';
    rec.onresult = (e: any) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0]?.transcript || '';
      sessTextRef.current = text.trim();
      errRunRef.current = 0; // real audio flowed — this hold's mic works, keep restarting freely
      const full = [baseTextRef.current, sessTextRef.current].filter(Boolean).join(' ');
      if (full) cbRef.current(full, false); // stream interim text while held; final submit happens on release
    };
    rec.onerror = (e: any) => {
      console.warn('[speech] recognition error:', e?.error || e); // the exact reason, for diagnosis
      errRunRef.current += 1;
      // Chrome fires onend right after onerror — the restart/finalize decision lives there.
    };
    rec.onend = () => {
      recRef.current = null;
      if (sessTextRef.current) {
        baseTextRef.current = [baseTextRef.current, sessTextRef.current].filter(Boolean).join(' ');
        sessTextRef.current = '';
      }
      // Still held → the service ended the session on its own; restart seamlessly (unless the mic
      // is provably dead — MAX_ERROR_RUN consecutive errored sessions with no speech).
      if (holdingRef.current && errRunRef.current < MAX_ERROR_RUN && spawn()) return;
      holdingRef.current = false;
      setListening(false);
      const finalText = baseTextRef.current;
      baseTextRef.current = '';
      if (finalText) cbRef.current(finalText, true);
    };
    recRef.current = rec;
    try { rec.start(); return true; } catch { recRef.current = null; return false; }
  };

  const start = () => {
    if (holdingRef.current || recRef.current) return; // already listening — a stray second press-down is a no-op
    holdingRef.current = true;
    baseTextRef.current = '';
    errRunRef.current = 0;
    if (spawn()) setListening(true);
    else { holdingRef.current = false; setListening(false); }
  };

  const stop = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    recRef.current?.stop?.(); // → onend finalizes and submits the accumulated transcript
  };

  return { supported, listening, start, stop };
}
