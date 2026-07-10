import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import CopilotBar from './CopilotBar';
import PageNav from './PageNav';
import TodayPage from './pages/TodayPage';
import ChoresPage from './pages/ChoresPage';
import ShoppingPage from './pages/ShoppingPage';
import LibraryPage from './pages/LibraryPage';
import IdleScreensaver, { type ScreensaverWeather } from '../IdleScreensaver';
import Manage, { type AccountSettings } from './Manage';
import CalendarOverlay from './CalendarOverlay';
import EventSheet from './EventSheet';
import GooglePushPicker from '../calendar/GooglePushPicker';
import { useCalendar } from '../../CalendarContext';
import { useWeather } from './useWeather';
import { aqiColor, aqiLabel, uvColor, uvLabel } from '../../utils/weatherClient';
import { C } from './theme';

const PAGES = ['Today', 'Chores', 'Shopping', 'Library'];
const LAST = PAGES.length - 1;

interface DarkShellProps {
  screensaverOn: boolean;
  onWakeFromScreensaver: () => void;
  isRefreshing: boolean;
  photosScreensaver?: boolean; // device pref: family photos behind the idle clock (W6)
  account: AccountSettings;
}

// The copilot-first dark shell (spec §4): one persistent copilot bar, page dots, and four
// full-bleed horizontally-swipeable context pages. Replaces the old header + quick-add + tab
// switcher. All pages read the existing AppContext / CalendarContext — no new state layer.
export default function DarkShell({ screensaverOn, onWakeFromScreensaver, isRefreshing, photosScreensaver, account }: DarkShellProps) {
  const [activePage, setActivePage] = useState(0);
  const [manageOpen, setManageOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const pagerRef = useRef<HTMLDivElement>(null);

  const { homeLat, homeLng, homeLabel } = useCalendar();
  const weather = useWeather(homeLat, homeLng);
  const ssWeather: ScreensaverWeather | null = weather && weather.tempF != null ? {
    tempF: weather.tempF,
    condition: weather.condition,
    aqi: weather.aqi,
    aqiLabel: weather.aqi != null ? aqiLabel(weather.aqi) : '',
    aqiColor: weather.aqi != null ? aqiColor(weather.aqi) : C.emerald,
    uv: weather.uv,
    uvLabel: weather.uv != null ? uvLabel(weather.uv) : '',
    uvColor: weather.uv != null ? uvColor(weather.uv) : C.emerald,
    homeLabel,
  } : null;

  const go = useCallback((i: number) => setActivePage(Math.max(0, Math.min(LAST, i))), []);

  // Keyboard ← → (desktop / wall-tablet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (el?.closest('[role=dialog]')) return;
      if (e.key === 'ArrowRight') setActivePage(p => Math.min(LAST, p + 1));
      if (e.key === 'ArrowLeft') setActivePage(p => Math.max(0, p - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Touch swipe (≥48px horizontal delta) on the pager
  useEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    let sx = 0;
    let sy = 0;
    const start = (e: TouchEvent) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
    const end = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
        setActivePage(p => (dx < 0 ? Math.min(LAST, p + 1) : Math.max(0, p - 1)));
      }
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', end, { passive: true });
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchend', end); };
  }, []);

  const arrow = (dir: -1 | 1) => {
    const show = dir < 0 ? activePage > 0 : activePage < LAST;
    const edge: CSSProperties = dir < 0 ? { left: 20 } : { right: 20 };
    return (
      <button
        type="button"
        onClick={() => go(activePage + dir)}
        aria-label={dir < 0 ? 'Previous page' : 'Next page'}
        className="absolute top-1/2 z-30 hidden -translate-y-1/2 items-center justify-center rounded-full text-2xl font-black transition-opacity md:flex"
        style={{
          ...edge,
          width: 52, height: 52,
          background: C.card, border: `2px solid ${C.brut}`, boxShadow: `4px 4px 0 0 ${C.brut}`, color: C.brut,
          opacity: show ? 1 : 0, pointerEvents: show ? 'auto' : 'none',
        }}
      >
        {dir < 0 ? '←' : '→'}
      </button>
    );
  };

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: '100dvh', background: C.shell }}>
      <CopilotBar onOpenManage={() => setManageOpen(true)} />
      <PageNav pages={PAGES} active={activePage} onSelect={go} />

      <div className="relative min-h-0 flex-1">
        {arrow(-1)}
        {arrow(1)}

        {/* touch-action pan-y: the app owns horizontal drags (page swipe), so the browser's edge
            back/forward swipe doesn't fire; vertical scrolling still works. */}
        <div ref={pagerRef} className="h-full w-full overflow-hidden" style={{ touchAction: 'pan-y', overscrollBehaviorX: 'contain' }}>
          <div
            className="flex h-full"
            style={{ width: '400%', transform: `translateX(-${activePage * 25}%)`, transition: 'transform 0.36s cubic-bezier(0.4,0,0.2,1)' }}
          >
            {[
              <TodayPage onNavigate={go} onOpenCalendar={() => setCalendarOpen(true)} />,
              <ChoresPage />,
              <ShoppingPage />,
              <LibraryPage />,
            ].map((page, i) => (
              <div
                key={i}
                className="h-full min-w-0"
                // inert: off-screen pages are non-interactive + skipped by screen readers (only the active page is reachable).
                inert={i !== activePage}
                style={{ flex: '0 0 25%', contentVisibility: i === activePage ? 'visible' : 'auto' } as CSSProperties}
              >
                {page}
              </div>
            ))}
          </div>
        </div>
      </div>

      {manageOpen && <Manage account={account} onClose={() => setManageOpen(false)} />}
      {calendarOpen && <CalendarOverlay onClose={() => setCalendarOpen(false)} />}
      <EventSheet />
      <GooglePushPicker />
      {screensaverOn && <IdleScreensaver onWake={onWakeFromScreensaver} refreshing={isRefreshing} weather={ssWeather} photosEnabled={photosScreensaver} />}
    </div>
  );
}
