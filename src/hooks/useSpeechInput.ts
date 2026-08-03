// Voice input (W6): Web Speech API speech-to-text for the copilot bar — the phone-first "talk to
// the hub" path. Feature-detected (Chrome/Edge/Safari expose webkitSpeechRecognition; Firefox has
// none) and gracefully absent: unsupported browsers simply never see the mic button. The transcript
// rides the EXISTING input → copilot pipeline, so every safety gate (critic, confirm tiers,
// Approvals) applies to a spoken request exactly as to a typed one.
//
// Press-and-hold, not tap-to-toggle: a tap-to-toggle mic with continuous=false let the recognizer's
// own utterance-boundary detection end the session — on desktop this could fire well under a second
// after start, reading as "it just quits." start()/stop() are driven by the caller's own press/release
// gesture instead, with continuous=true so the session only ends when the user releases (or a real
// error/timeout occurs), and the transcript submits on release (onend), not on the first detected
// pause mid-session.
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

export interface SpeechInput {
  supported: boolean;
  listening: boolean;
  /** Call on press (mousedown/touchstart). Interim transcripts stream via onTranscript(text, false). */
  start: () => void;
  /** Call on release (mouseup/mouseleave/touchend). The accumulated transcript arrives as (text, true). */
  stop: () => void;
}

export function useSpeechInput(onTranscript: (text: string, isFinal: boolean) => void): SpeechInput {
  const [listening, setListening] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;
  const lastTextRef = useRef('');
  const supported = typeof window !== 'undefined' && !!getRecognitionCtor();

  useEffect(() => () => { recRef.current?.abort?.(); }, []); // unmount: kill any live session

  const start = () => {
    if (recRef.current) return; // already listening — a stray second press-down is a no-op
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true; // the hold/release gesture controls the session, not the first detected pause
    lastTextRef.current = '';
    rec.onresult = (e: any) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0]?.transcript || '';
      text = text.trim();
      lastTextRef.current = text;
      if (text) cbRef.current(text, false); // stream interim text while held; final submit happens on release
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      if (lastTextRef.current) cbRef.current(lastTextRef.current, true);
    };
    rec.onerror = (e: any) => {
      console.warn('[speech] recognition error:', e?.error || e); // mic denied / no speech / etc — was silent before
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch { setListening(false); recRef.current = null; }
  };

  const stop = () => { recRef.current?.stop?.(); };

  return { supported, listening, start, stop };
}
