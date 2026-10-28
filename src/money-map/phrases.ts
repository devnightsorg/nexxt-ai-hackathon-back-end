/** User-facing English phrasing shared by the headline and the actions' "Why?" facts. */
export const lei = (n: number): string => `${Math.round(n).toLocaleString('en-US')} lei`;

/** "about 3 weeks", "just under a month", else "3.9 months" (floored, so 0.97 never reads as a full month). */
export function spanOf(months: number): string {
  if (months >= 0.9 && months < 1) return 'just under a month';
  if (months < 1) {
    const weeks = Math.max(1, Math.floor(months * 4.33));
    return `about ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
  }
  const m = Math.floor(months * 10) / 10;
  return `${m} ${m === 1 ? 'month' : 'months'}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  groceries: 'Groceries',
  dining: 'Eating out',
  shopping: 'Shopping',
  entertainment: 'Entertainment',
  transport: 'Transport',
  travel: 'Travel',
  subscriptions: 'Subscriptions',
};
