import { useEffect, useRef } from 'react';

// Shared modal accessibility (§7.3 review): on open, move focus into the dialog; trap Tab within it; close
// on Escape; restore focus to the trigger on close. Attach the returned ref to the dialog container and give
// it tabIndex={-1}. Keep the listener in capture phase so it wins over inner handlers.
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Stack of currently-open modal instances (top = last opened). Every modal registers its own
// capture-phase keydown listener on `document`, so with modals stacked (e.g. EventSheet opened from
// on top of CalendarOverlay) a single Escape press would otherwise fire EVERY listener — stopPropagation
// only blocks the rest of that one listener's path, not sibling listeners registered independently on
// the same target. Gating Escape on "am I the topmost modal" makes one press close only the top one.
let modalStack: symbol[] = [];

export function useModalA11y<T extends HTMLElement = HTMLDivElement>(onClose: () => void, active = true) {
  const ref = useRef<T>(null);
  // Read onClose via a ref so the effect can run only when `active` flips. If it depended on `onClose` (a new
  // closure each parent render) the effect would re-run on every render and `el.focus()` would steal focus back
  // to the dialog mid-typing — breaking any input inside the modal.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const idRef = useRef(Symbol('modal'));
  // `active` lets always-mounted modals (e.g. EventSheet returns null when closed) get focus-on-OPEN: pass the
  // open boolean. Mount-on-open modals just leave it default true → runs once on mount.
  useEffect(() => {
    if (!active) return;
    const id = idRef.current;
    modalStack.push(id);
    const el = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Only the topmost modal reacts — an Escape while a modal is stacked underneath another
        // shouldn't close both at once.
        if (modalStack[modalStack.length - 1] !== id) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
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
      modalStack = modalStack.filter(x => x !== id);
      prevFocus?.focus?.();
    };
  }, [active]);
  return ref;
}
