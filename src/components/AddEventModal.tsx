import { X } from 'lucide-react';
import { useApp } from '../AppContext';
import type { Category } from '../types';

export default function AddEventModal() {
  const {
    selectedDayToAdd, setSelectedDayToAdd, setIsAddingEvent,
    handleAddCustomEvent,
    customEventTitle, setCustomEventTitle,
    customEventCategory, setCustomEventCategory,
    customEventLocation, setCustomEventLocation,
    customEventEnd, setCustomEventEnd,
    customEventStartTime, setCustomEventStartTime,
    customEventEndTime, setCustomEventEndTime,
    customEventFreeBusy, setCustomEventFreeBusy,
    customEventRepeat, setCustomEventRepeat,
    customEventDescription, setCustomEventDescription,
    customEventMembers, toggleEventMember,
    familyMembers,
  } = useApp();

  return (
    <div className="fixed inset-0 bg-indigo-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in" id="add-event-modal">
      <div className="bg-white rounded-3xl max-w-md w-full p-6 border border-slate-100 shadow-2xl relative">
        <button
          id="close-add-modal"
          onClick={() => {
            setIsAddingEvent(false);
            setSelectedDayToAdd(null);
          }}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
        >
          <X size={18} />
        </button>

        <span className="text-[10px] font-extrabold uppercase tracking-widest text-indigo-500 block mb-1">Manual Timeline Entry</span>
        <h3 className="text-base font-black text-slate-900 mb-4">
          Add Event for Date: <span className="text-orange-500 font-bold underline decoration-2">{selectedDayToAdd}</span>
        </h3>

        <form onSubmit={handleAddCustomEvent} className="space-y-3.5">
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Activity Title</label>
            <input
              id="modal-evt-title"
              type="text"
              placeholder="e.g. YMCA Camp Day or Backyard Pool Party"
              value={customEventTitle}
              onChange={e => setCustomEventTitle(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Category Type</label>
              <select
                id="modal-evt-category"
                value={customEventCategory}
                onChange={e => setCustomEventCategory(e.target.value as Category)}
                className="w-full px-2.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="School">School Event</option>
                <option value="Camp">Summer Camp</option>
                <option value="Sports">Sports Practice/Game</option>
                <option value="Arts">Arts/Creative Lab</option>
                <option value="Holiday">Vacation/Holiday</option>
                <option value="Other">Other Listing</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Location / Venue</label>
              <input
                id="modal-evt-location"
                type="text"
                placeholder="e.g. Magnuson Park"
                value={customEventLocation}
                onChange={e => setCustomEventLocation(e.target.value)}
                className="w-full px-2.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Date Range End (Optional)</label>
            <input
              id="modal-evt-end-date"
              type="date"
              value={customEventEnd}
              onChange={e => setCustomEventEnd(e.target.value)}
              min={selectedDayToAdd ?? undefined}
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Start Time (Optional)</label>
              <input
                id="modal-evt-start-time"
                type="time"
                value={customEventStartTime}
                onChange={e => setCustomEventStartTime(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">End Time (Optional)</label>
              <input
                id="modal-evt-end-time"
                type="time"
                value={customEventEndTime}
                onChange={e => setCustomEventEndTime(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Counts as (for the copilot)</label>
            <div className="flex gap-1.5 mt-1">
              {([
                { val: '', label: 'Auto' },
                { val: 'busy', label: 'Busy' },
                { val: 'free', label: 'Free' },
              ] as const).map(opt => {
                const isSelected = customEventFreeBusy === opt.val;
                return (
                  <button
                    key={opt.val || 'auto'}
                    id={`modal-evt-freebusy-${opt.val || 'auto'}`}
                    type="button"
                    onClick={() => setCustomEventFreeBusy(opt.val)}
                    className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border transition-all ${
                      isSelected ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[9px] text-slate-400 mt-1">“Free” (holidays, OOO, no-school, time off) leaves the day open for planning; “Busy” occupies it. Auto guesses from the title/category.</p>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Repeats</label>
            <div className="flex gap-1.5 mt-1">
              {([
                { val: '', label: 'One-off' },
                { val: 'daily', label: 'Daily × 30' },
                { val: 'weekly', label: 'Weekly × 12' },
              ] as const).map(opt => {
                const isSelected = customEventRepeat === opt.val;
                return (
                  <button
                    key={opt.val || 'none'}
                    id={`modal-evt-repeat-${opt.val || 'none'}`}
                    type="button"
                    onClick={() => setCustomEventRepeat(opt.val)}
                    className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border transition-all ${
                      isSelected ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {/* RRULE-lite: repeating adds concrete instances (like a Google pull), so each one can be
                edited/deleted individually — and the whole series bulk-deleted from the recurring notice. */}
            {customEventRepeat && <p className="text-[9px] text-slate-400 mt-1">Adds {customEventRepeat === 'daily' ? '30 daily' : '12 weekly'} entries you can edit or bulk-delete as a series.</p>}
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Assign to Family Members</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {[{ name: 'Family', color: 'green', role: 'Group' } as any, ...familyMembers].map(m => {
                const isSelected = customEventMembers.includes(m.name);
                return (
                  <button
                    key={m.name}
                    id={`modal-assign-member-${m.name}`}
                    type="button"
                    onClick={() => toggleEventMember(m.name)}
                    className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border transition-all ${
                      isSelected ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {m.name === 'Family' ? '🟢 Family' : `👤 ${m.name}`}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Description / Registrations / Cost</label>
            <textarea
              id="modal-evt-desc"
              placeholder="Insert registration details, pricing, or coordinator alerts..."
              value={customEventDescription}
              onChange={e => setCustomEventDescription(e.target.value)}
              rows={2}
              className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500"
            ></textarea>
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <button
              id="modal-cancel-btn"
              type="button"
              onClick={() => {
                setIsAddingEvent(false);
                setSelectedDayToAdd(null);
              }}
              className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              id="modal-save-btn"
              type="submit"
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition font-semibold"
            >
              Save to Calendar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
