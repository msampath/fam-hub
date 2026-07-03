import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { IDLE_TIMEOUT_MS } from '../useIdleTimeout';

// Per-device preferences (idle screensaver, auto-sign-out, the local daily reminder). These persist
// to localStorage only (per-device, NOT to the cloud / COLLECTIONS), so the engine is fully
// self-contained here. The reminder *scheduler* (which reads events/chores) stays in App — only the
// prefs + the user-initiated toggle live here.
export interface DevicePrefs {
  idleTimeoutMs: number;
  setIdleTimeoutMs: Dispatch<SetStateAction<number>>;
  signOutMs: number;
  setSignOutMs: Dispatch<SetStateAction<number>>;
  remindersEnabled: boolean;
  setRemindersEnabled: Dispatch<SetStateAction<boolean>>;
  reminderTime: number;
  setReminderTime: Dispatch<SetStateAction<number>>;
  reminderLeadMinutes: number;
  setReminderLeadMinutes: Dispatch<SetStateAction<number>>;
  handleToggleReminders: (enabled: boolean) => void;
  autoScanEnabled: boolean;
  setAutoScanEnabled: Dispatch<SetStateAction<boolean>>;
  kidMode: boolean;
  setKidMode: Dispatch<SetStateAction<boolean>>;
}

export function useDevicePrefs(): DevicePrefs {
  // Idle screensaver (power-save / burn-in) timeout (0 = Off).
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(() => {
    // Distinguish "unset" from a stored 0 (Off): Number(null) === 0 would otherwise pin a fresh device to
    // Off and make the IDLE_TIMEOUT_MS default unreachable (no burn-in protection on always-on hardware).
    const raw = localStorage.getItem('famplan_idle_timeout');
    const saved = Number(raw);
    return raw !== null && Number.isFinite(saved) && saved >= 0 ? saved : IDLE_TIMEOUT_MS;
  });
  // Optional security auto-sign-out after a longer idle (0 = Off by default).
  const [signOutMs, setSignOutMs] = useState<number>(() => {
    const saved = Number(localStorage.getItem('famplan_signout_timeout'));
    return Number.isFinite(saved) && saved >= 0 ? saved : 0;
  });
  // Local daily reminder (per-device): a configurable morning notification. No server/push.
  const [remindersEnabled, setRemindersEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('famplan_reminders_enabled');
    return saved ? JSON.parse(saved) : false;
  });
  const [reminderTime, setReminderTime] = useState<number>(() => {
    const saved = Number(localStorage.getItem('famplan_reminder_time'));
    return Number.isFinite(saved) && saved > 0 ? saved : 8 * 60; // minutes since midnight; default 8:00 AM
  });
  // How long before a timed event the per-event reminder fires (minutes; 0 = at start).
  const [reminderLeadMinutes, setReminderLeadMinutes] = useState<number>(() => {
    const saved = Number(localStorage.getItem('famplan_reminder_lead'));
    return Number.isFinite(saved) && saved >= 0 ? saved : 30;
  });
  // Opt-in proactive email scan (default off) — auto-scan the inbox on an interval while signed in.
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('famplan_autoscan');
    return saved ? JSON.parse(saved) : false;
  });
  // Kid mode (default off): locks THIS device to the kid-safe surface — Manage/Approvals/Actions/Import
  // and chore delete/add are hidden. Per-device on purpose (a wall tablet is the kid surface; a parent's
  // phone isn't), same rationale as the screensaver prefs above.
  const [kidMode, setKidMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('famplan_kidmode');
    return saved ? JSON.parse(saved) : false;
  });

  useEffect(() => { localStorage.setItem('famplan_idle_timeout', String(idleTimeoutMs)); }, [idleTimeoutMs]);
  useEffect(() => { localStorage.setItem('famplan_autoscan', JSON.stringify(autoScanEnabled)); }, [autoScanEnabled]);
  useEffect(() => { localStorage.setItem('famplan_kidmode', JSON.stringify(kidMode)); }, [kidMode]);
  useEffect(() => { localStorage.setItem('famplan_signout_timeout', String(signOutMs)); }, [signOutMs]);
  useEffect(() => { localStorage.setItem('famplan_reminders_enabled', JSON.stringify(remindersEnabled)); }, [remindersEnabled]);
  useEffect(() => { localStorage.setItem('famplan_reminder_time', String(reminderTime)); }, [reminderTime]);
  useEffect(() => { localStorage.setItem('famplan_reminder_lead', String(reminderLeadMinutes)); }, [reminderLeadMinutes]);

  // Enable/disable the local daily reminder. Requesting permission must be user-initiated, so it
  // happens here on toggle-on (not in an effect).
  const handleToggleReminders = (enabled: boolean) => {
    setRemindersEnabled(enabled);
    if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  };

  return {
    idleTimeoutMs, setIdleTimeoutMs,
    signOutMs, setSignOutMs,
    remindersEnabled, setRemindersEnabled,
    reminderTime, setReminderTime,
    reminderLeadMinutes, setReminderLeadMinutes,
    handleToggleReminders,
    autoScanEnabled, setAutoScanEnabled,
    kidMode, setKidMode,
  };
}
