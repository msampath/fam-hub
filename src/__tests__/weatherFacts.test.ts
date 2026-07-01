import { describe, it, expect } from 'vitest';
import { describeWeatherCode, buildWeatherFacts, buildBriefingWeather, isPlanningQuery, usAqiLabel, dailyMaxFromHourly, parseGooglePollen } from '../utils/weatherFacts';

describe('describeWeatherCode (WMO code → label + wet flag)', () => {
  it('maps clear/cloudy codes to dry (outdoor-friendly)', () => {
    expect(describeWeatherCode(0)).toEqual({ label: 'Clear', wet: false });
    expect(describeWeatherCode(2)).toEqual({ label: 'Partly cloudy', wet: false });
    expect(describeWeatherCode(3)).toEqual({ label: 'Overcast', wet: false });
  });

  it('maps rain/snow/storm/fog codes to wet (prefer indoor)', () => {
    expect(describeWeatherCode(65).wet).toBe(true); // heavy rain
    expect(describeWeatherCode(75).wet).toBe(true); // heavy snow
    expect(describeWeatherCode(95).wet).toBe(true); // thunderstorm
    expect(describeWeatherCode(45).wet).toBe(true); // fog
  });

  it('returns Unknown (dry) for an unmapped code', () => {
    expect(describeWeatherCode(123)).toEqual({ label: 'Unknown', wet: false });
  });
});

describe('buildWeatherFacts', () => {
  const daily = {
    time: ['2026-06-20', '2026-06-21'],
    weather_code: [0, 65], // clear, then heavy rain
    temperature_2m_max: [78, 60],
    temperature_2m_min: [55, 50],
    precipitation_probability_max: [5, 80],
  };

  it('formats each day with weekday, conditions, temps, precip, and an indoor/outdoor hint', () => {
    const block = buildWeatherFacts('Sammamish, Washington', daily);
    expect(block).toMatch(/^WEATHER FACTS \(authoritative forecast for Sammamish, Washington/);
    expect(block).toContain('Saturday 2026-06-20: Clear, 78°F/55°F, 5% precip → good for outdoor');
    expect(block).toContain('Sunday 2026-06-21: Heavy rain, 60°F/50°F, 80% precip → prefer indoor');
    expect(block).toContain("If a date isn't listed, you don't have its forecast");
  });

  it('includes the UV index when provided, plus the UV legend (for kid-safety tips)', () => {
    const block = buildWeatherFacts('Home', { ...daily, uv_index_max: [8, 3] });
    expect(block).toContain('78°F/55°F, 5% precip, UV 8 → good for outdoor');
    expect(block).toContain('UV index scale: 0–2 low');
  });

  it('omits UV gracefully when it is missing (back-compat)', () => {
    const block = buildWeatherFacts('Home', daily); // no uv_index_max
    expect(block).toContain('5% precip → good for outdoor'); // no ", UV" inserted
    expect(block).not.toContain('UV'); // no per-day UV and no UV legend
  });

  it('steers indoor on a high precipitation chance even for a dry code', () => {
    const block = buildWeatherFacts('Home', {
      time: ['2026-06-20'], weather_code: [2], temperature_2m_max: [70], temperature_2m_min: [55],
      precipitation_probability_max: [70],
    });
    expect(block).toContain('Partly cloudy');
    expect(block).toContain('→ prefer indoor');
  });

  it('caps the number of days emitted', () => {
    const many = {
      time: Array.from({ length: 16 }, (_, i) => `2026-06-${String(20 + i).padStart(2, '0')}`),
      weather_code: Array(16).fill(0),
      temperature_2m_max: Array(16).fill(70),
      temperature_2m_min: Array(16).fill(55),
      precipitation_probability_max: Array(16).fill(0),
    };
    const block = buildWeatherFacts('Home', many, 10);
    expect((block.match(/→ good for outdoor/g) || []).length).toBe(10);
  });

  it('returns an empty string when there is no usable forecast', () => {
    expect(buildWeatherFacts('Home', null)).toBe('');
    expect(buildWeatherFacts('Home', { time: [] })).toBe('');
  });

  it('omits temps gracefully when they are missing', () => {
    const block = buildWeatherFacts('Home', { time: ['2026-06-20'], weather_code: [0] });
    expect(block).toContain('Saturday 2026-06-20: Clear → good for outdoor');
    expect(block).not.toContain('°F');
  });

  it('merges AQI + High pollen into the day line and adds their legends', () => {
    const block = buildWeatherFacts('Home', daily, 10, {
      aqiByDate: { '2026-06-20': 42, '2026-06-21': 165 },             // good, then unhealthy
      pollenByDate: { '2026-06-20': { label: 'Grass', category: 'High' }, '2026-06-21': { label: 'Tree', category: 'Low' } },
    });
    expect(block).toContain('AQI 42 (Good)');
    expect(block).toContain('Grass pollen High');                     // High → shown
    expect(block).not.toContain('Tree pollen');                       // Low → omitted
    // Unhealthy air (165) steers the otherwise-rainy Sunday indoor and shows the label.
    expect(block).toContain('AQI 165 (Unhealthy)');
    expect(block).toContain('US AQI: 0–50 good');                     // AQI legend present
    expect(block).toContain('bring allergy meds');                    // pollen note present
  });

  it('steers a clear day indoor on unhealthy air (AQI ≥ 151)', () => {
    const block = buildWeatherFacts('Home', { time: ['2026-06-20'], weather_code: [0], temperature_2m_max: [75], temperature_2m_min: [55], precipitation_probability_max: [0] },
      10, { aqiByDate: { '2026-06-20': 180 } });
    expect(block).toContain('→ prefer indoor'); // smoke day
  });
});

describe('air-quality + pollen helpers', () => {
  it('usAqiLabel buckets the US AQI scale', () => {
    expect(usAqiLabel(40)).toBe('Good');
    expect(usAqiLabel(90)).toBe('Moderate');
    expect(usAqiLabel(130)).toBe('Unhealthy for sensitive groups');
    expect(usAqiLabel(180)).toBe('Unhealthy');
    expect(usAqiLabel(350)).toBe('Hazardous');
  });

  it('dailyMaxFromHourly collapses hourly values to a per-date max', () => {
    const out = dailyMaxFromHourly(
      ['2026-06-20T00:00', '2026-06-20T12:00', '2026-06-21T06:00'],
      [30, 55, 12],
    );
    expect(out).toEqual({ '2026-06-20': 55, '2026-06-21': 12 });
  });

  it('parseGooglePollen picks the dominant pollen per date and drops zero days', () => {
    const json = {
      dailyInfo: [
        { date: { year: 2026, month: 6, day: 20 }, pollenTypeInfo: [
          { code: 'GRASS', displayName: 'Grass', indexInfo: { value: 4, category: 'High' } },
          { code: 'TREE', displayName: 'Tree', indexInfo: { value: 2, category: 'Low' } },
        ] },
        { date: { year: 2026, month: 6, day: 21 }, pollenTypeInfo: [
          { code: 'WEED', displayName: 'Weed', indexInfo: { value: 0 } }, // all zero → dropped
        ] },
      ],
    };
    expect(parseGooglePollen(json)).toEqual({ '2026-06-20': { label: 'Grass', category: 'High' } });
  });
});

describe('isPlanningQuery (D9 — gate the weather fetch)', () => {
  it('returns true for planning / weather-relevant queries', () => {
    for (const q of [
      'find me a free day this weekend',
      'is Saturday good for the zoo?',
      'what should we do on Sunday?',
      'suggest a fun outdoor activity',
      'plan a hike',
      'is it raining this weekend?',     // inflection: rain → raining
      'what activities are there?',       // inflection: activit → activities
      'any good hiking trails?',          // inflection: hik → hiking
    ]) {
      expect(isPlanningQuery(q)).toBe(true);
    }
  });

  it('returns false for a direct non-planning lookup', () => {
    expect(isPlanningQuery("what's on tomorrow?")).toBe(false);
    expect(isPlanningQuery('list my events')).toBe(false);
  });
});

describe('buildBriefingWeather (one-line today summary for the digest email)', () => {
  const daily = {
    time: ['2026-06-28', '2026-06-29'],
    weather_code: [61, 0],          // rain today, clear tomorrow
    temperature_2m_max: [68.4, 80],
    temperature_2m_min: [55.1, 60],
    precipitation_probability_max: [70, 0],
  };

  it('summarizes today with temps, precip, and AQI', () => {
    const out = buildBriefingWeather(daily, { '2026-06-28': 42 }, '2026-06-28');
    expect(out).toBe('🌤 Weather: Light rain, 68°/55°F, 70% precip · AQI 42 (Good)');
  });

  it('omits precip when 0 and AQI when absent', () => {
    expect(buildBriefingWeather(daily, {}, '2026-06-29')).toBe('🌤 Weather: Clear, 80°/60°F');
  });

  it('returns empty when today is not in the forecast or there is no data', () => {
    expect(buildBriefingWeather(daily, {}, '2026-07-04')).toBe('');
    expect(buildBriefingWeather(null, {}, '2026-06-28')).toBe('');
  });
});
