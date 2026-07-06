import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { C } from './shell/theme';
import { apiFetch } from '../supabase';
import { buildPhotoOrder, type PhotoMeta } from '../utils/photoPicks';

export interface ScreensaverWeather {
  tempF: number | null;
  condition: string;
  aqi: number | null;
  aqiLabel: string;
  aqiColor: string;
  uv: number | null;
  uvLabel: string;
  uvColor: string;
  homeLabel?: string;
}

interface IdleScreensaverProps {
  onWake: () => void;            // called on first activity; the parent refreshes data, then unmounts this
  refreshing: boolean;          // while true, we're reloading fresh data — ignore further taps
  weather?: ScreensaverWeather | null;
  photosEnabled?: boolean;      // device pref (W6): family photos behind the clock, date-window weighted
}

const PHOTO_ROTATE_MS = 20 * 1000;

// Photos rotation (W6): fetch the local corpus list once, build the date-window-WEIGHTED order
// (last 90 days + 1–5 years ago ±30d surface most), then rotate with a crossfade. Images come
// through the authed API (apiFetch → blob → object URL — an <img src> can't carry the JWT).
// Best-effort by design: no photos / any failure → photoUrl stays null → the classic clock look.
function usePhotoRotation(enabled: boolean): string | null {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const show = async (p: PhotoMeta) => {
      try {
        const res = await apiFetch(`/api/photos/file/${encodeURIComponent(p.name)}`);
        if (!res.ok || !alive) return;
        const url = URL.createObjectURL(await res.blob());
        if (!alive) { URL.revokeObjectURL(url); return; }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPhotoUrl(url);
      } catch { /* keep the current photo (or the plain clock) */ }
    };
    (async () => {
      try {
        const res = await apiFetch('/api/photos/list');
        if (!res.ok || !alive) return;
        const { photos } = await res.json().catch(() => ({ photos: [] }));
        const order = buildPhotoOrder(Array.isArray(photos) ? photos : [], new Date().toISOString());
        if (!order.length || !alive) return;
        let i = 0;
        void show(order[0]);
        timer = setInterval(() => { i = (i + 1) % order.length; void show(order[i]); }, PHOTO_ROTATE_MS);
      } catch { /* no corpus → plain clock */ }
    })();
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
      setPhotoUrl(null);
    };
  }, [enabled]);
  return photoUrl;
}

function clockStrings(d: Date) {
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return { time, date };
}

/**
 * Dark idle screensaver for an always-on kitchen display (spec §9). Near-black background draws
 * ~no power on OLED; a big pulsing clock + date + live weather chips. The clock ticks every 10s
 * (not 1s) for power saving. Any activity calls onWake; the parent refreshes data in the
 * background (showing "Refreshing…") before revealing fresh content.
 */
export default function IdleScreensaver({ onWake, refreshing, weather, photosEnabled }: IdleScreensaverProps) {
  const [now, setNow] = useState(() => new Date());
  const photoUrl = usePhotoRotation(!!photosEnabled);

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 10 * 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (refreshing) return;
    const onKey = () => onWake();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refreshing, onWake]);

  const { time, date } = clockStrings(now);

  const chip = (text: string, color: string) => (
    <span
      className="rounded-2xl px-5 py-2.5 text-base font-bold"
      style={{ color, background: `${color}12`, border: `2px solid ${color}28` }}
    >
      {text}
    </span>
  );

  return (
    <div
      className="fixed inset-0 z-[200] overflow-hidden select-none cursor-pointer flex flex-col items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Screensaver"
      style={{ background: C.screensaver }}
      onPointerDown={() => { if (!refreshing) onWake(); }}
    >
      {/* Family-photo backdrop (W6): crossfading Ken-Burns layer under the clock. `key` remounts the
          img per photo so the CSS animation restarts; the dark scrim keeps the clock readable. */}
      {photoUrl && !refreshing && (
        <>
          <img
            key={photoUrl}
            src={photoUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ animation: 'screensaverKenBurns 20s ease-in-out forwards, screensaverFadeIn 1.2s ease-in' }}
          />
          <div className="absolute inset-0" style={{ background: 'rgba(5,8,16,0.45)' }} />
        </>
      )}
      {refreshing ? (
        <div className="flex flex-col items-center justify-center gap-3" style={{ color: `${C.primary}80` }}>
          <RefreshCw size={26} className="animate-spin" />
          <span className="text-base tracking-wide font-semibold">Refreshing…</span>
        </div>
      ) : (
        <div className="relative z-10 flex flex-col items-center justify-center">
          <div
            className="font-extrabold leading-none tabular-nums text-[76px] md:text-[144px]"
            style={{ color: C.primary, letterSpacing: '-0.03em', animation: 'screensaverPulse 4s ease-in-out infinite', textShadow: photoUrl ? '0 2px 24px rgba(0,0,0,0.85)' : undefined }}
            aria-hidden="true"
          >
            {time}
          </div>
          <div className="mt-3.5 text-base md:text-[22px] font-semibold" style={{ color: C.ink, letterSpacing: '0.06em' }}>
            {date}
          </div>

          {weather && weather.tempF != null && (
            <div className="mt-12 flex flex-wrap items-center justify-center gap-3.5">
              {chip(`${weather.tempF}° ${weather.condition}${weather.homeLabel ? ` · ${weather.homeLabel}` : ''}`, C.emerald)}
              {weather.aqi != null && chip(`AQI ${weather.aqi} · ${weather.aqiLabel}`, weather.aqiColor)}
              {weather.uv != null && chip(`UV ${weather.uv} · ${weather.uvLabel}`, weather.uvColor)}
            </div>
          )}

          <div className="mt-20 text-xs font-semibold uppercase" style={{ color: photoUrl ? '#c8cede' : '#191e2e', letterSpacing: '0.16em', textShadow: photoUrl ? '0 1px 10px rgba(0,0,0,0.9)' : undefined }}>
            tap or press any key to wake
          </div>
        </div>
      )}
    </div>
  );
}
