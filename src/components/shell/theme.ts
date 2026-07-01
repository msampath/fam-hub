// Dark neo-brutalist palette.
// Used for INLINE styles where the color is dynamic (per-kid accents, brut hard shadows,
// state-driven chip colors) and can't be a static Tailwind class. Static surfaces use the
// @theme tokens in index.css (bg-card, text-muted, …).

export const C = {
  shell: '#050810',
  app: '#0e1117',
  card: '#161b27',
  elevated: '#1e2538',
  pill: '#131827',
  screensaver: '#030608',

  primary: '#e2e8f4',
  // KEEP IN SYNC with the @theme --color-* tokens in src/index.css (same values; these drive inline styles,
  // those drive Tailwind utility classes). muted/ink are secondary-text colors, lightened (from #4a5270 /
  // #383f5c) to clear WCAG contrast on the dark surfaces: muted #828bb0 ≈4.5:1 body on C.card; ink #6b7498
  // ≈3.75:1 (clears the 3:1 minimum for the small icon buttons it styles). Tune here if you want them dimmer.
  muted: '#828bb0',
  faint: '#2a2f44',
  ink: '#6b7498',
  soft: '#6870a0',

  brut: '#c8d0e8',

  indigo: '#818cf8',
  indigoShadow: '#4f56cc',
  amber: '#fbbf24',
  amberShadow: '#7d6000',
  emerald: '#34d399',
  sky: '#38bdf8',
  pink: '#f472b6',
  orange: '#fb923c',
  red: '#f87171',
  purple: '#c084fc',
} as const;

// Per-kid accent + deep card background (spec §6 Chores). Kids are assigned a scheme by
// their index in the roster so a 3rd+ kid still gets a distinct color.
export const KID_SCHEMES = [
  { accent: C.sky,  deepBg: 'rgba(8,36,56,0.92)' },
  { accent: C.pink, deepBg: 'rgba(38,8,28,0.92)' },
  { accent: C.amber, deepBg: 'rgba(40,30,0,0.92)' },
  { accent: C.emerald, deepBg: 'rgba(6,38,28,0.92)' },
  { accent: C.purple, deepBg: 'rgba(30,12,44,0.92)' },
] as const;

export function kidScheme(index: number) {
  return KID_SCHEMES[((index % KID_SCHEMES.length) + KID_SCHEMES.length) % KID_SCHEMES.length];
}

// Member palette id (constants.ts MEMBER_COLORS_LIST) → an accent hex for dark-mode tinting
// (event rows, member pills). Falls back to indigo. 'green'/Family → emerald.
const MEMBER_HEX: Record<string, string> = {
  indigo: C.indigo,
  rose: '#fb7185',
  amber: C.amber,
  teal: '#22d3ee',
  violet: '#a78bfa',
  sky: C.sky,
  orange: C.orange,
  fuchsia: '#e879f9',
  green: C.emerald,
};
export function memberHex(colorId?: string): string {
  return (colorId && MEMBER_HEX[colorId]) || C.indigo;
}

// Event category → a friendly emoji for the Today event rows (matches the prototype's icon badges).
export const CATEGORY_EMOJI: Record<string, string> = {
  School: '🎒',
  Camp: '🏕️',
  Sports: '⚽',
  Arts: '🎨',
  Holiday: '🎉',
  Other: '📌',
};

// Neon-brutalist hard shadow (spec §2): offset scales 4px phone → 6px desktop. We emit a
// responsive value via a CSS var consumed in index.css-free inline styles; callers pass the
// accent color. `size` defaults to the desktop offset; the shell sets --brut-offset per breakpoint.
export function brutShadow(color: string, offset = 5): string {
  return `${offset}px ${offset}px 0 0 ${color}`;
}
