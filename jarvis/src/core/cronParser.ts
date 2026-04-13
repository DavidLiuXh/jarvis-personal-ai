/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import cron from 'node-cron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Returns a valid cron expression, or null if the input cannot be parsed. */
export function parseNaturalTimeToCron(input: string): string | null {
  const s = input.trim();

  // Already a valid cron expression — pass through
  if (cron.validate(s)) return s;

  // Normalise for matching
  const lower = s.toLowerCase();

  // --- Extract hour and minute ---
  const time = extractTime(lower);

  // --- Interval patterns ---
  // "every N minutes" / "每N分钟"
  const everyMinutes = lower.match(/every\s+(\d+)\s*min|每\s*(\d+)\s*分钟/);
  if (everyMinutes) {
    const n = parseInt(everyMinutes[1] ?? everyMinutes[2]);
    return `*/${n} * * * *`;
  }
  // "every hour" / "每小时"
  if (/every\s+hour|每小时/.test(lower)) return '0 * * * *';
  // "every N hours" / "每隔N小时"
  const everyHours = lower.match(/every\s+(\d+)\s*hour|每\s*隔?\s*(\d+)\s*小时/);
  if (everyHours) {
    const n = parseInt(everyHours[1] ?? everyHours[2]);
    return `0 */${n} * * *`;
  }

  // Need a time for the remaining patterns
  if (time === null) return null;
  const { h, m } = time;

  // --- Weekday range: weekdays / 工作日 / 周一到周五 ---
  if (/weekday|工作日|周一到周五|monday.*friday|mon.*fri/.test(lower)) {
    return `${m} ${h} * * 1-5`;
  }

  // --- Specific weekday ---
  const weekdayMap: Record<string, number> = {
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
    周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 0, 周天: 0,
  };
  for (const [name, num] of Object.entries(weekdayMap)) {
    if (lower.includes(name)) {
      return `${m} ${h} * * ${num}`;
    }
  }

  // --- Daily ---
  if (/every\s*day|daily|每天|每日/.test(lower)) {
    return `${m} ${h} * * *`;
  }

  // If we have a time but no schedule qualifier, assume daily
  if (time !== null) {
    return `${m} ${h} * * *`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TimeResult = { h: number; m: number };

function extractTime(lower: string): TimeResult | null {
  // HH:MM format
  const hhmm = lower.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) {
    return { h: parseInt(hhmm[1]), m: parseInt(hhmm[2]) };
  }

  // "8am" / "10pm" / "8a.m."
  const ampm = lower.match(/(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const period = ampm[2].replace(/\./g, '');
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return { h, m: 0 };
  }

  // Chinese time expressions
  // 早上/上午 → AM, 下午/傍晚 → PM (+12), 晚上/夜 → PM (+12, treat 10-11 as 22-23)
  const cnTime = lower.match(/(早上|上午|下午|傍晚|晚上|夜间|凌晨)?\s*(\d{1,2})\s*[点时:：]/);
  if (cnTime) {
    let h = parseInt(cnTime[2]);
    const period = cnTime[1] ?? '';
    if (/下午|傍晚/.test(period) && h < 12) h += 12;
    if (/晚上|夜间/.test(period) && h < 12) h += 12;
    if (/凌晨/.test(period) && h === 12) h = 0;
    return { h, m: 0 };
  }

  return null;
}
