import { C } from './theme';

interface PageNavProps {
  pages: string[];
  active: number;
  onSelect: (index: number) => void;
}

// Page indicator + jump control (spec §4). Dots for touch, labelled for desktop; the active
// page is indigo. Shown on both devices.
export default function PageNav({ pages, active, onSelect }: PageNavProps) {
  return (
    <div className="flex-shrink-0 py-2" style={{ background: C.app, borderBottom: '2px solid #161c2e', zIndex: 10 }}>
      <div className="mx-auto flex max-w-[1200px] items-center justify-center gap-5 md:gap-7">
        {pages.map((label, i) => {
          const on = active === i;
          return (
            <button
              key={label}
              type="button"
              onClick={() => onSelect(i)}
              aria-current={on ? 'page' : undefined}
              className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 transition-opacity"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full transition-colors"
                style={{ background: on ? C.indigo : C.elevated }}
              />
              <span
                className="text-[11px] font-extrabold uppercase tracking-[0.1em] transition-colors"
                style={{ color: on ? C.indigo : C.muted }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
