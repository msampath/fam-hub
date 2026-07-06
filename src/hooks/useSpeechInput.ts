// Voice input (W6): Web Speech API speech-to-text for the copilot bar — the phone-first "talk to
// the hub" path. Feature-detected (Chrome/Edge/Safari expose webkitSpeechRecognition; Firefox has
// none) and gracefully absent: unsupported browsers simply never see the mic button. The transcript
// rides the EXISTING input → copilot pipeline, so every safety gate (critic, confirm tiers,
// Approvals) applies to a spoken request exactly as to a typed one.
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
  /** Toggle listening. Interim transcripts stream via onTranscript(text, false); the final one arrives (text, true). */
  toggle: () => void;
}

export function useSpeechInput(onTranscript: (text: string, isFinal: boolean) => void): SpeechInput {
  const [listening, setListening] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;
  const supported = typeof window !== 'undefined' && !!getRecognitionCtor();

  useEffect(() => () => { recRef.current?.abort?.(); }, []); // unmount: kill any live session

  const toggle = () => {
    if (listening) { recRef.current?.stop?.(); return; }
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false; // one utterance per tap — the quick-add/copilot shape
    rec.onresult = (e: any) => {
      let text = '';
      let isFinal = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0]?.transcript || '';
        if (e.results[i].isFinal) isFinal = true;
      }
      if (text.trim()) cbRef.current(text.trim(), isFinal);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false); // mic denied / no speech → just stop; the input stays usable
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch { setListening(false); }
  };

  return { supported, listening, toggle };
}
