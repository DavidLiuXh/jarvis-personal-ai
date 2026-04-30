/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure date-range extraction from natural-language time references.
 *
 * Design principles:
 * - All logic is in code (not LLM) — deterministic and fully testable.
 * - `now` is injected so tests can freeze time.
 * - Returns { from, to } as local-midnight timestamps (ms).
 *   `to` is the start of the day AFTER the last day in the range,
 *   so SQL queries can use `timestamp >= from AND timestamp < to`.
 * - Returns null when no temporal expression is found.
 */

export type DateRange = { from: number; to: number };

// Weekday name → index (Mon=0 … Sun=6), matches (dayOfWeek+6)%7 formula
const WEEKDAY_INDEX: Record<string, number> = {
  monday: 0,
  周一: 0,
  星期一: 0,
  tuesday: 1,
  周二: 1,
  星期二: 1,
  wednesday: 2,
  周三: 2,
  星期三: 2,
  thursday: 3,
  周四: 3,
  星期四: 3,
  friday: 4,
  周五: 4,
  星期五: 4,
  saturday: 5,
  周六: 5,
  星期六: 5,
  sunday: 6,
  周日: 6,
  周天: 6,
  星期日: 6,
  星期天: 6,
};

// Chinese month names
const CN_MONTH: Record<string, number> = {
  一月: 1,
  二月: 2,
  三月: 3,
  四月: 4,
  五月: 5,
  六月: 6,
  七月: 7,
  八月: 8,
  九月: 9,
  十月: 10,
  十一月: 11,
  十二月: 12,
};

// English month names → month number (1-indexed)
const EN_MONTH: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** Returns local-midnight ms for a given year/month(1-12)/day */
function localMidnight(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

/** Returns { from: start-of-day, to: start-of-next-day } */
function singleDay(year: number, month: number, day: number): DateRange {
  const from = localMidnight(year, month, day);
  const to = localMidnight(year, month, day + 1); // JS Date handles month overflow
  return { from, to };
}

/** Returns { from: start-of-first-day, to: start-of-day-after-last-day } */
function dayRange(
  fromYear: number,
  fromMonth: number,
  fromDay: number,
  toYear: number,
  toMonth: number,
  toDay: number,
): DateRange {
  return {
    from: localMidnight(fromYear, fromMonth, fromDay),
    to: localMidnight(toYear, toMonth, toDay + 1),
  };
}

/**
 * Shifts `d` by `days` days and returns a new Date (does not mutate).
 */
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/**
 * Returns the ISO date (YYYY-MM-DD) components of a Date as { y, m, d }.
 */
function ymd(d: Date): { y: number; m: number; d: number } {
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/**
 * Returns the date of the most recent occurrence of `weekdayIdx` (Mon=0…Sun=6)
 * that is at most `maxWeeksBack` weeks before `now`, counting back `weeksBack`
 * full weeks from the current week.
 *
 * weeksBack=0 → this week's occurrence (may be today or a future day this week
 *               if today is before that weekday — in that case returns last week's)
 * weeksBack=1 → last week's occurrence
 * weeksBack=2 → the week before last
 */
function weekdayDateBack(
  now: Date,
  weekdayIdx: number,
  weeksBack: number,
): Date {
  // daysSinceMonday: 0=Mon, 1=Tue, …, 6=Sun
  const daysSinceMonday = (now.getDay() + 6) % 7;
  // offset of target weekday from THIS Monday (negative = earlier in week)
  const offsetFromThisMonday = weekdayIdx - daysSinceMonday;
  // days ago from today to reach the target day in the current week
  // (negative offsetFromThisMonday means it's already passed this week)
  let daysAgo = -offsetFromThisMonday + weeksBack * 7;
  // If daysAgo <= 0 the day is today or in the future — push back a full week
  // so we always return a past date (never today for "周X" unless today IS that day)
  if (daysAgo < 0) daysAgo += 7;
  return addDays(now, -daysAgo);
}

/**
 * Main entry point. Extracts a DateRange from a natural-language string.
 * Returns null if no temporal expression is found.
 *
 * @param text  The user's message (lower-cased inside)
 * @param now   Injected "current time" for testability (default: new Date())
 */
export function extractDateRange(
  text: string,
  now: Date = new Date(),
): DateRange | null {
  const s = text.trim();
  const lo = s.toLowerCase();

  // ── 1. Absolute ISO date: 2026-04-16 ──────────────────────────────────────
  {
    const m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (m) return singleDay(+m[1], +m[2], +m[3]);
  }

  // ── 2. Chinese date: 2026年4月16日 / 4月16日 ─────────────────────────────
  {
    const m = s.match(/(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日/);
    if (m) {
      const year = m[1] ? +m[1] : now.getFullYear();
      return singleDay(year, +m[2], +m[3]);
    }
  }

  // ── 3. English date: April 16 / April 16, 2026 / 16 April 2026 ──────────
  {
    // "April 16, 2026" or "April 16"
    const m1 = lo.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/,
    );
    if (m1) {
      const month = EN_MONTH[m1[1]];
      const day = +m1[2];
      const year = m1[3] ? +m1[3] : now.getFullYear();
      if (month && day >= 1 && day <= 31) return singleDay(year, month, day);
    }
    // "16 April 2026"
    const m2 = lo.match(
      /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/,
    );
    if (m2) {
      const day = +m2[1];
      const month = EN_MONTH[m2[2]];
      const year = m2[3] ? +m2[3] : now.getFullYear();
      if (month && day >= 1 && day <= 31) return singleDay(year, month, day);
    }
  }

  // ── 4. Today ──────────────────────────────────────────────────────────────
  if (/今天|today|just now|刚才|just now/.test(lo)) {
    const { y, m, d } = ymd(now);
    return singleDay(y, m, d);
  }

  // ── 5. Yesterday ─────────────────────────────────────────────────────────
  if (/昨天|yesterday/.test(lo)) {
    const { y, m, d } = ymd(addDays(now, -1));
    return singleDay(y, m, d);
  }

  // ── 6. 大前天 (3 days ago) — must come before 前天 to avoid substring match ──
  if (/大前天/.test(s)) {
    const { y, m, d } = ymd(addDays(now, -3));
    return singleDay(y, m, d);
  }

  // ── 7. Day before yesterday (前天) ────────────────────────────────────────
  if (/前天|the day before yesterday/.test(lo)) {
    const { y, m, d } = ymd(addDays(now, -2));
    return singleDay(y, m, d);
  }

  // ── 8. N天前 / N days ago ─────────────────────────────────────────────────
  {
    const m = lo.match(/(\d+)\s*天前/) || lo.match(/(\d+)\s*days?\s*ago/);
    if (m) {
      const { y, mn, d } = (() => {
        const t = addDays(now, -+m[1]);
        return { y: t.getFullYear(), mn: t.getMonth() + 1, d: t.getDate() };
      })();
      return singleDay(y, mn, d);
    }
  }

  // ── 9. Week and month ranges — must come BEFORE weekday detection ────────
  // "上上周" stacked (as range, no trailing weekday)
  {
    // Match "上上周" or "上上上周" NOT followed by a weekday character
    const cnStackedWeekRange = s.match(/(上{2,})周(?![一二三四五六日天]|星期)/);
    if (cnStackedWeekRange) {
      const weeksBack = cnStackedWeekRange[1].length;
      const daysSinceMonday = (now.getDay() + 6) % 7;
      const thisMonday = addDays(now, -daysSinceMonday);
      const rangeMonday = addDays(thisMonday, -weeksBack * 7);
      const rangeSunday = addDays(rangeMonday, 6);
      const f = ymd(rangeMonday);
      const t = ymd(rangeSunday);
      return dayRange(f.y, f.m, f.d, t.y, t.m, t.d);
    }
  }

  // "上周" / "last week" (as range, no trailing weekday)
  if (
    /上周(?![一二三四五六日天]|星期)|上个星期(?![一二三四五六日天])|\blast\s+week\b/.test(
      s + lo,
    )
  ) {
    const daysSinceMonday = (now.getDay() + 6) % 7;
    const thisMonday = addDays(now, -daysSinceMonday);
    const lastMonday = addDays(thisMonday, -7);
    const lastSunday = addDays(lastMonday, 6);
    const f = ymd(lastMonday);
    const t = ymd(lastSunday);
    return dayRange(f.y, f.m, f.d, t.y, t.m, t.d);
  }

  // "这周" / "本周" / "this week"
  if (/这周|本周|\bthis\s+week\b/.test(lo)) {
    const daysSinceMonday = (now.getDay() + 6) % 7;
    const thisMonday = addDays(now, -daysSinceMonday);
    const f = ymd(thisMonday);
    const t = ymd(now);
    return dayRange(f.y, f.m, f.d, t.y, t.m, t.d);
  }

  // ── 9b. Weekday references ────────────────────────────────────────────────
  // Detect "N个星期前的周X" / "N周前周X" / "两周前的周X" / "三周前的周X"
  // Also handles "上上周X", "上上上周X" (Chinese stacked 上)
  // And "last Monday", "two weeks ago Thursday", etc.
  {
    // Chinese: 上(上(上...))周X — count the number of 上
    const cnStacked = s.match(
      /^(上+)(周[一二三四五六日天]|星期[一二三四五六日天])/,
    );
    if (cnStacked) {
      const weeksBack = cnStacked[1].length; // number of 上
      const wdKey = cnStacked[2];
      const wdIdx = WEEKDAY_INDEX[wdKey];
      if (wdIdx !== undefined) {
        const target = weekdayDateBack(now, wdIdx, weeksBack);
        const { y, m, d } = ymd(target);
        return singleDay(y, m, d);
      }
    }

    // Chinese: N个星期前的周X / N周前周X / N周前的周X
    const cnNWeeks = s.match(
      /(\d+|两|三|四|五|六|七|八|九|十)[个]?(?:星期|周)前(?:的)?(周[一二三四五六日天]|星期[一二三四五六日天])/,
    );
    if (cnNWeeks) {
      const nStr = cnNWeeks[1];
      const numMap: Record<string, number> = {
        两: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
        十: 10,
      };
      const weeksBack = numMap[nStr] ?? +nStr;
      const wdKey = cnNWeeks[2];
      const wdIdx = WEEKDAY_INDEX[wdKey];
      if (wdIdx !== undefined && weeksBack > 0) {
        const target = weekdayDateBack(now, wdIdx, weeksBack);
        const { y, m, d } = ymd(target);
        return singleDay(y, m, d);
      }
    }

    // English: "two/three/N weeks ago (on) Thursday"
    const enNWeeks = lo.match(
      /(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+weeks?\s+ago(?:\s+(?:on\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)?/,
    );
    if (enNWeeks && enNWeeks[2]) {
      const numMap: Record<string, number> = {
        two: 2,
        three: 3,
        four: 4,
        five: 5,
        six: 6,
        seven: 7,
        eight: 8,
        nine: 9,
        ten: 10,
      };
      const weeksBack = numMap[enNWeeks[1]] ?? +enNWeeks[1];
      const wdIdx = WEEKDAY_INDEX[enNWeeks[2]];
      if (wdIdx !== undefined && weeksBack > 0) {
        const target = weekdayDateBack(now, wdIdx, weeksBack);
        const { y, m, d } = ymd(target);
        return singleDay(y, m, d);
      }
    }

    // English: "last Monday/Tuesday/…" → 1 week back
    const enLast = lo.match(
      /\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    );
    if (enLast) {
      const wdIdx = WEEKDAY_INDEX[enLast[1]];
      if (wdIdx !== undefined) {
        const target = weekdayDateBack(now, wdIdx, 1);
        const { y, m, d } = ymd(target);
        return singleDay(y, m, d);
      }
    }

    // Chinese: 上周X (exactly one 上, already handled by stacked above,
    // but keep for safety with alternative forms like "上星期四")
    const cnLastWeek = s.match(/上(?:个)?(?:星期|周)([一-龥])/);
    if (cnLastWeek) {
      const wdKey =
        `周${cnLastWeek[1]}` in WEEKDAY_INDEX
          ? `周${cnLastWeek[1]}`
          : `星期${cnLastWeek[1]}`;
      const wdIdx =
        WEEKDAY_INDEX[`周${cnLastWeek[1]}`] ??
        WEEKDAY_INDEX[`星期${cnLastWeek[1]}`];
      if (wdIdx !== undefined) {
        const target = weekdayDateBack(now, wdIdx, 1);
        const { y, m, d } = ymd(target);
        return singleDay(y, m, d);
      }
      void wdKey; // suppress unused warning
    }

    // Plain weekday reference: "周四" / "星期四" / "Thursday"
    // (this week's occurrence; if today IS that day → today)
    const plainWd = Object.keys(WEEKDAY_INDEX).find(
      (k) => s.includes(k) || lo.includes(k),
    );
    if (plainWd) {
      const wdIdx = WEEKDAY_INDEX[plainWd];
      // 0 weeks back = this week's day
      const target = weekdayDateBack(now, wdIdx, 0);
      const { y, m, d } = ymd(target);
      return singleDay(y, m, d);
    }
  }

  // ── 10. Month ranges ─────────────────────────────────────────────────────
  // "上上个月" / "上上月"
  if (/上上[个]?月/.test(lo)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return dayRange(
      d.getFullYear(),
      d.getMonth() + 1,
      1,
      lastDay.getFullYear(),
      lastDay.getMonth() + 1,
      lastDay.getDate(),
    );
  }

  // "上个月" / "上月" / "last month"
  if (/上[个]?月|\blast\s+month\b/.test(lo)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return dayRange(
      d.getFullYear(),
      d.getMonth() + 1,
      1,
      lastDay.getFullYear(),
      lastDay.getMonth() + 1,
      lastDay.getDate(),
    );
  }

  // "这个月" / "本月" / "this month"
  if (/这[个]?月|本月|\bthis\s+month\b/.test(lo)) {
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const f = ymd(firstOfMonth);
    const t = ymd(now);
    return dayRange(f.y, f.m, f.d, t.y, t.m, t.d);
  }

  // Specific month: "3月" / "March" (current year assumed)
  {
    const cnMonthMatch = Object.keys(CN_MONTH).find((k) => s.includes(k));
    if (cnMonthMatch) {
      const month = CN_MONTH[cnMonthMatch];
      const year = now.getFullYear();
      const lastDay = new Date(year, month, 0);
      return dayRange(year, month, 1, year, month, lastDay.getDate());
    }
    const enMonthMatch = Object.keys(EN_MONTH).find(
      (k) => k.length > 3 && lo.includes(k), // avoid "may" false-positives with short keys
    );
    if (enMonthMatch) {
      const month = EN_MONTH[enMonthMatch];
      const year = now.getFullYear();
      const lastDay = new Date(year, month, 0);
      return dayRange(year, month, 1, year, month, lastDay.getDate());
    }
  }

  // ── 12. 最近N天 / 过去N天 / last N days / recent N days ──────────────────
  {
    const m =
      lo.match(/(?:最近|过去)\s*(\d+)\s*天/) ||
      lo.match(/(?:last|past|recent)\s+(\d+)\s+days?/);
    if (m) {
      const t = ymd(now);
      const f = ymd(addDays(now, -+m[1]));
      return dayRange(f.y, f.m, f.d, t.y, t.m, t.d);
    }
  }

  // ── 13. "最近" / "recently" (default 3 days) ─────────────────────────────
  if (/最近|近期|recently|these days|这两天/.test(lo)) {
    const t = ymd(now);
    const f = ymd(addDays(now, -3));
    return dayRange(f.y, f.m, f.d, t.y, t.m, t.d);
  }

  return null;
}
