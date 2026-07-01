import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { C } from './shell/theme';

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
export default function IdleScreensaver({ onWake, refreshing, weather }: IdleScreensaverProps) {
  const [now, setNow] = useState(() => new Date());

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
      {refreshing ? (
        <div className="flex flex-col items-center justify-center gap-3" style={{ color: `${C.primary}80` }}>
          <RefreshCw size={26} className="animate-spin" />
          <span className="text-base tracking-wide font-semibold">Refreshing…</span>
        </div>
      ) : (
        <>
          <div
            className="font-extrabold leading-none tabular-nums text-[76px] md:text-[144px]"
            style={{ color: C.primary, letterSpacing: '-0.03em', animation: 'screensaverPulse 4s ease-in-out infinite' }}
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

          <div className="mt-20 text-xs font-semibold uppercase" style={{ color: '#191e2e', letterSpacing: '0.16em' }}>
            tap or press any key to wake
          </div>
        </>
      )}
    </div>
  );
}
