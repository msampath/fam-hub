import { useEffect, useRef } from 'react';

// Shared modal accessibility (§7.3 review): on open, move focus into the dialog; trap Tab within it; close
// on Escape; restore focus to the trigger on close. Attach the returned ref to the dialog container and give
// it tabIndex={-1}. Keep the listener in capture phase so it wins over inner handlers.
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useModalA11y<T extends HTMLElement = HTMLDivElement>(onClose: () => void, active = true) {
  const ref = useRef<T>(null);
  // Read onClose via a ref so the effect can run only when `active` flips. If it depended on `onClose` (a new
  // closure each parent render) the effect would re-run on every render and `el.focus()` would steal focus back
  // to the dialog mid-typing — breaking any input inside the modal.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // `active` lets always-mounted modals (e.g. EventSheet returns null when closed) get focus-on-OPEN: pass the
  // open boolean. Mount-on-open modals just leave it default true → runs once on mount.
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !el) return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(n => n.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
    };
  }, [active]);
  return ref;
}
