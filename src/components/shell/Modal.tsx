import { type ReactNode } from 'react';
import { useModalA11y } from '../../hooks/useModalA11y';
import { C } from './theme';

// Shared modal shell: backdrop + accessibility (focus move-in / trap / restore + Escape, via useModalA11y) +
// the accent-bordered card. Rendered as `{open && <Modal/>}` so it MOUNTS on open → focus moves into the
// dialog. Backdrop click + Escape both call onClose (pass a guarded onClose to block close mid-input).
export default function Modal({ label, accent, onClose, children }: {
  label: string;
  accent: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="fixed inset-0 z-[160] flex items-start justify-center overflow-y-auto p-4" style={{ background: 'rgba(3,6,8,0.85)' }} onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} onClick={e => e.stopPropagation()} className="mt-10 w-full max-w-[520px] rounded-[18px] p-4 outline-none" style={{ border: `2px solid ${accent}`, boxShadow: `6px 6px 0 0 ${accent}`, background: C.card }}>
        {children}
      </div>
    </div>
  );
}
