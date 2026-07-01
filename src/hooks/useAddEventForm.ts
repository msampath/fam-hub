import { useState, type Dispatch, type SetStateAction, type FormEvent } from 'react';
import { uuid } from '../utils/uuid';
import type { Category, CalendarEvent, Authored } from '../types';

// The manual "add event for a date" form. Cohesive UI state + its submit/reset, extracted from App.
// The modal-open state (selectedDayToAdd / isAddingEvent) stays in App because it's set from several
// places (calendar overlay, event sheet); it's injected here along with the shared event-create deps.
export interface AddEventFormDeps {
  selectedDayToAdd: string | null;
  setSelectedDayToAdd: Dispatch<SetStateAction<string | null>>;
  setIsAddingEvent: Dispatch<SetStateAction<boolean>>;
  setEvents: Dispatch<SetStateAction<CalendarEvent[]>>;
  authorStamp: () => Authored;
}

export interface AddEventForm {
  customEventTitle: string; setCustomEventTitle: Dispatch<SetStateAction<string>>;
  customEventCategory: Category; setCustomEventCategory: Dispatch<SetStateAction<Category>>;
  customEventMembers: string[]; setCustomEventMembers: Dispatch<SetStateAction<string[]>>;
  customEventDescription: string; setCustomEventDescription: Dispatch<SetStateAction<string>>;
  customEventEnd: string; setCustomEventEnd: Dispatch<SetStateAction<string>>;
  customEventLocation: string; setCustomEventLocation: Dispatch<SetStateAction<string>>;
  customEventStartTime: string; setCustomEventStartTime: Dispatch<SetStateAction<string>>;
  customEventEndTime: string; setCustomEventEndTime: Dispatch<SetStateAction<string>>;
  customEventFreeBusy: '' | 'busy' | 'free'; setCustomEventFreeBusy: Dispatch<SetStateAction<'' | 'busy' | 'free'>>;
  toggleEventMember: (m: string) => void;
  handleAddCustomEvent: (e: FormEvent) => void;
}

export function useAddEventForm(deps: AddEventFormDeps): AddEventForm {
  const { selectedDayToAdd, setSelectedDayToAdd, setIsAddingEvent, setEvents, authorStamp } = deps;

  const [customEventTitle, setCustomEventTitle] = useState('');
  const [customEventCategory, setCustomEventCategory] = useState<Category>('Camp');
  const [customEventMembers, setCustomEventMembers] = useState<string[]>([]);
  const [customEventDescription, setCustomEventDescription] = useState('');
  const [customEventEnd, setCustomEventEnd] = useState('');
  const [customEventLocation, setCustomEventLocation] = useState('');
  const [customEventStartTime, setCustomEventStartTime] = useState(''); // 'HH:MM' or '' = all-day
  const [customEventEndTime, setCustomEventEndTime] = useState('');
  const [customEventFreeBusy, setCustomEventFreeBusy] = useState<'' | 'busy' | 'free'>(''); // '' = auto

  const toggleEventMember = (m: string) => {
    setCustomEventMembers(prev => (prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]));
  };

  const handleAddCustomEvent = (e: FormEvent) => {
    e.preventDefault();
    if (!customEventTitle || !selectedDayToAdd) return;

    const newEvt: CalendarEvent = {
      id: 'usr-' + uuid(),
      title: customEventTitle,
      start: selectedDayToAdd,
      end: customEventEnd || undefined,
      startTime: customEventStartTime || undefined,
      endTime: customEventEndTime || undefined,
      description: customEventDescription,
      location: customEventLocation,
      category: customEventCategory,
      freeBusy: customEventFreeBusy || undefined,
      ageGroup: 'All ages',
      members: customEventMembers.length > 0 ? customEventMembers : ['Everyone'],
      ...authorStamp(),
    };

    setEvents(prev => [newEvt, ...prev]);

    setCustomEventTitle('');
    setCustomEventDescription('');
    setCustomEventLocation('');
    setCustomEventEnd('');
    setCustomEventStartTime('');
    setCustomEventEndTime('');
    setCustomEventFreeBusy('');
    setCustomEventMembers([]);
    setIsAddingEvent(false);
    setSelectedDayToAdd(null);
  };

  return {
    customEventTitle, setCustomEventTitle,
    customEventCategory, setCustomEventCategory,
    customEventMembers, setCustomEventMembers,
    customEventDescription, setCustomEventDescription,
    customEventEnd, setCustomEventEnd,
    customEventLocation, setCustomEventLocation,
    customEventStartTime, setCustomEventStartTime,
    customEventEndTime, setCustomEventEndTime,
    customEventFreeBusy, setCustomEventFreeBusy,
    toggleEventMember,
    handleAddCustomEvent,
  };
}
