import { useState, type Dispatch, type SetStateAction, type FormEvent } from 'react';
import { uuid } from '../utils/uuid';
import { safeParseArray } from './usePersistedCollection';
import { availableXp } from '../utils/chores';
import { getCurrentTimeOfDay } from '../utils/dates';
import type { Chore, Reward, Redemption, XpBankEntry } from '../types';

export interface UseChores {
  choresList: Chore[]; setChoresList: Dispatch<SetStateAction<Chore[]>>;
  rewardsList: Reward[]; setRewardsList: Dispatch<SetStateAction<Reward[]>>;
  redemptionsList: Redemption[]; setRedemptionsList: Dispatch<SetStateAction<Redemption[]>>;
  xpBankList: XpBankEntry[]; setXpBankList: Dispatch<SetStateAction<XpBankEntry[]>>;
  choreWeekList: { week: string; day?: string }[]; setChoreWeekList: Dispatch<SetStateAction<{ week: string; day?: string }[]>>;
  newChoreTitle: string; setNewChoreTitle: Dispatch<SetStateAction<string>>;
  newChoreAssigned: string; setNewChoreAssigned: Dispatch<SetStateAction<string>>;
  newChorePoints: number; setNewChorePoints: Dispatch<SetStateAction<number>>;
  newChoreTimesPerDay: number; setNewChoreTimesPerDay: Dispatch<SetStateAction<number>>;
  newChoreRepeatType: 'daily' | 'weekly'; setNewChoreRepeatType: Dispatch<SetStateAction<'daily' | 'weekly'>>;
  newChoreScheduleTime: string; setNewChoreScheduleTime: Dispatch<SetStateAction<string>>;
  newChoreNotes: string; setNewChoreNotes: Dispatch<SetStateAction<string>>;
  choreTimeFilter: string; setChoreTimeFilter: Dispatch<SetStateAction<string>>;
  newRewardTitle: string; setNewRewardTitle: Dispatch<SetStateAction<string>>;
  newRewardCost: number; setNewRewardCost: Dispatch<SetStateAction<number>>;
  handleAddReward: (e: FormEvent) => void;
  handleDeleteReward: (id: string) => void;
  handleRedeemReward: (reward: Reward, memberName: string) => void;
}

// Chores domain: the chore board + the add-chore form fields, the XP ledgers (rewards catalog,
// redemptions, banked XP, week marker), and the reward add/delete/redeem handlers. Self-contained —
// the weekly RESET (cross-cutting: cloud save + bootstrap) stays in App as a coordinator and uses the
// setters exposed here.
export function useChores(): UseChores {
  // Persisted collections (ride App's COLLECTIONS/usePersistedCollection plumbing via the setters).
  const [choresList, setChoresList] = useState<Chore[]>(() => {
    const saved = localStorage.getItem('famplan_chores');
    return safeParseArray(saved);
  });
  const [rewardsList, setRewardsList] = useState<Reward[]>(() => {
    const saved = localStorage.getItem('famplan_rewards');
    return safeParseArray(saved);
  });
  const [redemptionsList, setRedemptionsList] = useState<Redemption[]>(() => {
    const saved = localStorage.getItem('famplan_redemptions');
    return safeParseArray(saved);
  });
  const [xpBankList, setXpBankList] = useState<XpBankEntry[]>(() => {
    const saved = localStorage.getItem('famplan_xpbank');
    return safeParseArray(saved);
  });
  const [choreWeekList, setChoreWeekList] = useState<{ week: string; day?: string }[]>(() => {
    const saved = localStorage.getItem('famplan_choreweek');
    return safeParseArray(saved);
  });

  // Add-chore form
  const [newChoreTitle, setNewChoreTitle] = useState('');
  const [newChoreAssigned, setNewChoreAssigned] = useState('Leo');
  const [newChorePoints, setNewChorePoints] = useState<number>(10);
  const [newChoreTimesPerDay, setNewChoreTimesPerDay] = useState<number>(1);
  const [newChoreRepeatType, setNewChoreRepeatType] = useState<'daily' | 'weekly'>('daily');
  const [newChoreScheduleTime, setNewChoreScheduleTime] = useState('Morning');
  const [newChoreNotes, setNewChoreNotes] = useState('');
  // Chore board filter — defaults to the current time-of-day slot so kids see "now" first.
  const [choreTimeFilter, setChoreTimeFilter] = useState<string>(() => getCurrentTimeOfDay());

  // Reward catalog form
  const [newRewardTitle, setNewRewardTitle] = useState('');
  const [newRewardCost, setNewRewardCost] = useState(50);

  const handleAddReward = (e: FormEvent) => {
    e.preventDefault();
    const title = newRewardTitle.trim();
    const cost = Number(newRewardCost);
    if (!title || !cost || cost <= 0) return;
    setRewardsList(prev => [...prev, { id: 'reward-' + uuid(), title, cost }]);
    setNewRewardTitle('');
    setNewRewardCost(50);
  };

  const handleDeleteReward = (id: string) => {
    setRewardsList(prev => prev.filter(r => r.id !== id));
  };

  // Redeem a reward for a kid. Guards against redeeming below the available balance.
  const handleRedeemReward = (reward: Reward, memberName: string) => {
    const available = availableXp(xpBankList, choresList, redemptionsList, memberName);
    if (reward.cost > available) {
      alert(`${memberName} has ${available} XP — not enough for "${reward.title}" (${reward.cost} XP).`);
      return;
    }
    if (!window.confirm(`Redeem "${reward.title}" for ${memberName}? This spends ${reward.cost} XP.`)) return;
    setRedemptionsList(prev => [
      { id: 'redemption-' + uuid(), rewardTitle: reward.title, cost: reward.cost, member: memberName, date: new Date().toISOString() },
      ...prev,
    ]);
  };

  return {
    choresList, setChoresList,
    rewardsList, setRewardsList,
    redemptionsList, setRedemptionsList,
    xpBankList, setXpBankList,
    choreWeekList, setChoreWeekList,
    newChoreTitle, setNewChoreTitle,
    newChoreAssigned, setNewChoreAssigned,
    newChorePoints, setNewChorePoints,
    newChoreTimesPerDay, setNewChoreTimesPerDay,
    newChoreRepeatType, setNewChoreRepeatType,
    newChoreScheduleTime, setNewChoreScheduleTime,
    newChoreNotes, setNewChoreNotes,
    choreTimeFilter, setChoreTimeFilter,
    newRewardTitle, setNewRewardTitle,
    newRewardCost, setNewRewardCost,
    handleAddReward, handleDeleteReward, handleRedeemReward,
  };
}
