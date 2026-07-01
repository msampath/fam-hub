// Shared visual + domain constants for Family-Hub.

// Centralized app name — render this instead of hardcoding the brand string.
export const APP_NAME = 'Family-Hub';

// The canonical shopping stores (single source for validation + the quick-add context).
export const SHOP_STORES = ['Costco', 'Indian Store', 'Grocery Store', 'Other'] as const;

// Configurable idle-screensaver timeouts (ms). 0 = Off (never blank).
export const IDLE_TIMEOUT_OPTIONS: { label: string; ms: number }[] = [
  { label: '5 min', ms: 5 * 60 * 1000 },
  { label: '15 min', ms: 15 * 60 * 1000 },
  { label: '30 min', ms: 30 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: 'Off', ms: 0 },
];

// Configurable security auto-sign-out timeouts (ms). 0 = Off (default — no forced re-login).
export const IDLE_SIGNOUT_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
];

// Daily reminder times (minutes since local midnight) for the local-notification digest.
export const REMINDER_TIME_OPTIONS: { label: string; minutes: number }[] = [
  { label: '7:00 AM', minutes: 7 * 60 },
  { label: '8:00 AM', minutes: 8 * 60 },
  { label: '9:00 AM', minutes: 9 * 60 },
  { label: '12:00 PM', minutes: 12 * 60 },
  { label: '6:00 PM', minutes: 18 * 60 },
];

// How far before a timed event the per-event reminder fires (minutes). 0 = at start.
export const REMINDER_LEAD_OPTIONS: { label: string; minutes: number }[] = [
  { label: 'At start', minutes: 0 },
  { label: '5 min before', minutes: 5 },
  { label: '15 min before', minutes: 15 },
  { label: '30 min before', minutes: 30 },
  { label: '1 hour before', minutes: 60 },
];

export const MEMBER_COLORS_LIST = [
  { id: 'indigo', name: 'Indigo Blue', bg: 'bg-indigo-100 text-indigo-850 border-indigo-200', dot: 'bg-indigo-600', bar: 'bg-indigo-500', color: 'indigo' },
  { id: 'rose', name: 'Rose Red', bg: 'bg-rose-100 text-rose-850 border-rose-200', dot: 'bg-rose-600', bar: 'bg-rose-500', color: 'rose' },
  { id: 'amber', name: 'Amber Yellow', bg: 'bg-amber-100 text-amber-850 border-amber-200', dot: 'bg-amber-600', bar: 'bg-amber-500', color: 'amber' },
  // id kept as 'teal' for backward-compat with stored member data, but recolored to
  // cyan so it doesn't read as green (green is reserved for the Family calendar).
  { id: 'teal', name: 'Cyan Blue', bg: 'bg-cyan-100 text-cyan-850 border-cyan-200', dot: 'bg-cyan-600', bar: 'bg-cyan-500', color: 'teal' },
  { id: 'violet', name: 'Violet Purple', bg: 'bg-violet-100 text-violet-850 border-violet-200', dot: 'bg-violet-600', bar: 'bg-violet-500', color: 'violet' },
  { id: 'sky', name: 'Sky Blue', bg: 'bg-sky-100 text-sky-850 border-sky-200', dot: 'bg-sky-600', bar: 'bg-sky-500', color: 'sky' },
  { id: 'orange', name: 'Orange', bg: 'bg-orange-100 text-orange-900 border-orange-200', dot: 'bg-orange-600', bar: 'bg-orange-500', color: 'orange' },
  { id: 'fuchsia', name: 'Fuchsia Pink', bg: 'bg-fuchsia-100 text-fuchsia-850 border-fuchsia-200', dot: 'bg-fuchsia-600', bar: 'bg-fuchsia-500', color: 'fuchsia' }
];

export const MEMBER_COLORS_MAP: Record<string, typeof MEMBER_COLORS_LIST[0]> = {
  indigo: MEMBER_COLORS_LIST[0],
  rose: MEMBER_COLORS_LIST[1],
  amber: MEMBER_COLORS_LIST[2],
  teal: MEMBER_COLORS_LIST[3],
  violet: MEMBER_COLORS_LIST[4],
  sky: MEMBER_COLORS_LIST[5],
  orange: MEMBER_COLORS_LIST[6],
  fuchsia: MEMBER_COLORS_LIST[7]
};

export const FAMILY_COLOR_THEME = {
  bg: 'bg-green-100 text-green-850 border-green-200',
  dot: 'bg-green-600',
  bar: 'bg-green-500',
  color: 'green'
};

export const CATEGORIES = {
  School: { color: 'bg-indigo-100 text-indigo-800 border-indigo-200', dot: 'bg-indigo-500', bar: 'bg-indigo-500' },
  Camp: { color: 'bg-sky-100 text-sky-800 border-sky-200', dot: 'bg-sky-500', bar: 'bg-sky-500' },
  Sports: { color: 'bg-emerald-100 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500', bar: 'bg-emerald-500' },
  Arts: { color: 'bg-purple-100 text-purple-800 border-purple-200', dot: 'bg-purple-500', bar: 'bg-purple-500' },
  Holiday: { color: 'bg-rose-100 text-rose-800 border-rose-200', dot: 'bg-rose-500', bar: 'bg-rose-500' },
  Other: { color: 'bg-amber-100 text-amber-800 border-amber-200', dot: 'bg-amber-500', bar: 'bg-amber-500' }
};

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Chore time-of-day buckets.
export const CHORE_SLOTS = ['Morning', 'Afternoon', 'Evening'] as const;

// Per-kid accent schemes for the chore board. Literal Tailwind classes (kept whole
// so the JIT compiler doesn't purge them) cycled across however many kids exist.
export const CHORE_SCHEMES = [
  {
    key: 'sky' as const,
    card: 'bg-sky-50/50 border-sky-200', avatar: 'bg-sky-100 border-sky-200 text-sky-800',
    name: 'text-sky-950', sub: 'text-sky-700', xp: 'text-sky-900', xpLabel: 'text-sky-600',
    award: 'text-sky-800', badge: 'bg-sky-100 text-sky-800 border-sky-200',
  },
  {
    key: 'pink' as const,
    card: 'bg-pink-50/50 border-pink-200', avatar: 'bg-pink-100 border-pink-200 text-pink-850',
    name: 'text-pink-950', sub: 'text-pink-700', xp: 'text-pink-900', xpLabel: 'text-pink-650',
    award: 'text-pink-855', badge: 'bg-pink-100 text-pink-800 border-pink-200',
  },
];
