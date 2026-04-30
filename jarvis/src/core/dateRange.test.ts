/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "vitest";
import { extractDateRange } from "./dateRange.js";

// Freeze time: 2026-04-30 (Thursday)
// dayOfWeek=4 (Thu), daysSinceMonday=3
// This week: Mon=04-27, Tue=04-28, Wed=04-29, Thu=04-30
// Last week: Mon=04-20, Tue=04-21, Wed=04-22, Thu=04-23, Fri=04-24, Sat=04-25, Sun=04-26
// 2 weeks ago: Mon=04-13, Tue=04-14, Wed=04-15, Thu=04-16, Fri=04-17
// 3 weeks ago: Mon=04-06, Tue=04-07, Wed=04-08, Thu=04-09, Fri=04-10

const NOW = new Date(2026, 3, 30, 10, 0, 0); // 2026-04-30 10:00 local

function local(y: number, m: number, d: number) {
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function range(
  fy: number,
  fm: number,
  fd: number,
  ty: number,
  tm: number,
  td: number,
) {
  return { from: local(fy, fm, fd), to: local(ty, tm, td + 1) };
}

function day(y: number, m: number, d: number) {
  return range(y, m, d, y, m, d);
}

describe("extractDateRange", () => {
  // ── Absolute dates ────────────────────────────────────────────────────────

  it("ISO date: 2026-04-16", () => {
    expect(extractDateRange("2026-04-16的讨论", NOW)).toEqual(day(2026, 4, 16));
  });

  it("Chinese date with year: 2026年4月16日", () => {
    expect(extractDateRange("2026年4月16日讨论了什么", NOW)).toEqual(
      day(2026, 4, 16),
    );
  });

  it("Chinese date without year: 4月16日", () => {
    expect(extractDateRange("4月16日讨论了什么", NOW)).toEqual(
      day(2026, 4, 16),
    );
  });

  it("English date: April 16", () => {
    expect(extractDateRange("April 16 discussion", NOW)).toEqual(
      day(2026, 4, 16),
    );
  });

  it("English date with year: April 16, 2026", () => {
    expect(extractDateRange("April 16, 2026", NOW)).toEqual(day(2026, 4, 16));
  });

  it("English date reversed: 16 April 2026", () => {
    expect(extractDateRange("16 April 2026", NOW)).toEqual(day(2026, 4, 16));
  });

  // ── Relative day references ───────────────────────────────────────────────

  it("今天 (today)", () => {
    expect(extractDateRange("今天讨论了什么", NOW)).toEqual(day(2026, 4, 30));
  });

  it("today", () => {
    expect(extractDateRange("what did we discuss today", NOW)).toEqual(
      day(2026, 4, 30),
    );
  });

  it("昨天 (yesterday)", () => {
    expect(extractDateRange("昨天我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 29),
    );
  });

  it("yesterday", () => {
    expect(extractDateRange("yesterday's discussion", NOW)).toEqual(
      day(2026, 4, 29),
    );
  });

  it("前天 (day before yesterday)", () => {
    expect(extractDateRange("前天讨论了什么", NOW)).toEqual(day(2026, 4, 28));
  });

  it("大前天 (3 days ago)", () => {
    expect(extractDateRange("大前天讨论了什么", NOW)).toEqual(day(2026, 4, 27));
  });

  it("3天前 (3 days ago)", () => {
    expect(extractDateRange("3天前我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 27),
    );
  });

  it("5 days ago", () => {
    expect(extractDateRange("5 days ago discussion", NOW)).toEqual(
      day(2026, 4, 25),
    );
  });

  // ── This week weekdays (weeksBack=0) ─────────────────────────────────────
  // NOW = Thursday 2026-04-30
  // This week: Mon=04-27, Tue=04-28, Wed=04-29, Thu=04-30(today)

  it("周一 → this week Monday 2026-04-27", () => {
    expect(extractDateRange("周一讨论了什么", NOW)).toEqual(day(2026, 4, 27));
  });

  it("星期二 → this week Tuesday 2026-04-28", () => {
    expect(extractDateRange("星期二我们聊了什么", NOW)).toEqual(
      day(2026, 4, 28),
    );
  });

  it("周三 → this week Wednesday 2026-04-29", () => {
    expect(extractDateRange("周三我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 29),
    );
  });

  it("周四 → today 2026-04-30", () => {
    expect(extractDateRange("周四我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 30),
    );
  });

  it("Thursday → today 2026-04-30", () => {
    expect(extractDateRange("Thursday discussion", NOW)).toEqual(
      day(2026, 4, 30),
    );
  });

  it("周五 → last Friday 2026-04-24 (hasn't happened yet this week)", () => {
    // Friday hasn't come yet this week, weekdayDateBack returns last Friday
    expect(extractDateRange("周五讨论了什么", NOW)).toEqual(day(2026, 4, 24));
  });

  it("周六 → last Saturday 2026-04-25", () => {
    expect(extractDateRange("周六讨论了什么", NOW)).toEqual(day(2026, 4, 25));
  });

  it("周日 → last Sunday 2026-04-26", () => {
    expect(extractDateRange("周日讨论了什么", NOW)).toEqual(day(2026, 4, 26));
  });

  // ── Last week weekdays (上周 / last X) ───────────────────────────────────
  // Last week: Mon=04-20, Tue=04-21, Wed=04-22, Thu=04-23, Fri=04-24, Sat=04-25, Sun=04-26

  it("上周一 → 2026-04-20", () => {
    expect(extractDateRange("上周一我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 20),
    );
  });

  it("上周四 → 2026-04-23", () => {
    expect(extractDateRange("上周四我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 23),
    );
  });

  it("last Thursday → 2026-04-23", () => {
    expect(extractDateRange("last Thursday discussion", NOW)).toEqual(
      day(2026, 4, 23),
    );
  });

  it("last Monday → 2026-04-20", () => {
    expect(extractDateRange("last Monday", NOW)).toEqual(day(2026, 4, 20));
  });

  it("上星期三 → 2026-04-22", () => {
    expect(extractDateRange("上星期三我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 22),
    );
  });

  // ── Two weeks ago (上上周X / two weeks ago X) ─────────────────────────────
  // 2 weeks ago: Mon=04-13, Tue=04-14, Wed=04-15, Thu=04-16, Fri=04-17

  it("上上周四 → 2026-04-16", () => {
    expect(extractDateRange("上上周四我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 16),
    );
  });

  it("上上周一 → 2026-04-13", () => {
    expect(extractDateRange("上上周一讨论", NOW)).toEqual(day(2026, 4, 13));
  });

  it("两周前的周四 → 2026-04-16", () => {
    expect(extractDateRange("两周前的周四我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 16),
    );
  });

  it("2周前周五 → 2026-04-17", () => {
    expect(extractDateRange("2周前周五讨论了什么", NOW)).toEqual(
      day(2026, 4, 17),
    );
  });

  it("two weeks ago Thursday → 2026-04-16", () => {
    expect(extractDateRange("two weeks ago Thursday", NOW)).toEqual(
      day(2026, 4, 16),
    );
  });

  // ── Three weeks ago (上上上周X) ───────────────────────────────────────────
  // 3 weeks ago: Mon=04-06, Tue=04-07, Wed=04-08, Thu=04-09, Fri=04-10

  it("上上上周四 → 2026-04-09", () => {
    expect(extractDateRange("上上上周四我们讨论了什么", NOW)).toEqual(
      day(2026, 4, 9),
    );
  });

  it("三周前的周一 → 2026-04-06", () => {
    expect(extractDateRange("三周前的周一讨论", NOW)).toEqual(day(2026, 4, 6));
  });

  it("three weeks ago Monday → 2026-04-06", () => {
    expect(extractDateRange("three weeks ago Monday", NOW)).toEqual(
      day(2026, 4, 6),
    );
  });

  // ── Week ranges ───────────────────────────────────────────────────────────

  it("上周 → last week Mon-Sun 04-20~04-26", () => {
    expect(extractDateRange("上周我们讨论了什么", NOW)).toEqual(
      range(2026, 4, 20, 2026, 4, 26),
    );
  });

  it("last week → 04-20~04-26", () => {
    expect(extractDateRange("last week discussion", NOW)).toEqual(
      range(2026, 4, 20, 2026, 4, 26),
    );
  });

  it("上上周 (as range) → 04-13~04-19", () => {
    expect(extractDateRange("上上周我们讨论了什么", NOW)).toEqual(
      range(2026, 4, 13, 2026, 4, 19),
    );
  });

  it("这周 → this week Mon-today", () => {
    expect(extractDateRange("这周讨论了什么", NOW)).toEqual(
      range(2026, 4, 27, 2026, 4, 30),
    );
  });

  // ── Month ranges ──────────────────────────────────────────────────────────

  it("上个月 → March 2026", () => {
    expect(extractDateRange("上个月我们讨论了什么", NOW)).toEqual(
      range(2026, 3, 1, 2026, 3, 31),
    );
  });

  it("last month → March 2026", () => {
    expect(extractDateRange("last month discussion", NOW)).toEqual(
      range(2026, 3, 1, 2026, 3, 31),
    );
  });

  it("上上个月 → February 2026", () => {
    expect(extractDateRange("上上个月讨论了什么", NOW)).toEqual(
      range(2026, 2, 1, 2026, 2, 28),
    );
  });

  it("这个月 → April 1~30", () => {
    expect(extractDateRange("这个月讨论了什么", NOW)).toEqual(
      range(2026, 4, 1, 2026, 4, 30),
    );
  });

  // ── Recent N days ─────────────────────────────────────────────────────────

  it("最近3天 → 04-27~04-30", () => {
    expect(extractDateRange("最近3天我们讨论了什么", NOW)).toEqual(
      range(2026, 4, 27, 2026, 4, 30),
    );
  });

  it("最近7天", () => {
    expect(extractDateRange("最近7天", NOW)).toEqual(
      range(2026, 4, 23, 2026, 4, 30),
    );
  });

  it("last 7 days", () => {
    expect(extractDateRange("last 7 days", NOW)).toEqual(
      range(2026, 4, 23, 2026, 4, 30),
    );
  });

  it("最近 (default 3 days)", () => {
    expect(extractDateRange("最近讨论了什么", NOW)).toEqual(
      range(2026, 4, 27, 2026, 4, 30),
    );
  });

  it("recently (default 3 days)", () => {
    expect(extractDateRange("recently discussed", NOW)).toEqual(
      range(2026, 4, 27, 2026, 4, 30),
    );
  });

  // ── No temporal reference → null ─────────────────────────────────────────

  it("no time ref → null", () => {
    expect(extractDateRange("what is my investment style", NOW)).toBeNull();
  });

  it("external question → null", () => {
    expect(extractDateRange("what is the capital of France", NOW)).toBeNull();
  });

  it("empty string → null", () => {
    expect(extractDateRange("", NOW)).toBeNull();
  });

  // ── Edge: today IS the referenced weekday ────────────────────────────────
  // NOW = Thursday 2026-04-30; "周四" should return today

  it("周四 when today is Thursday → today", () => {
    expect(extractDateRange("周四", NOW)).toEqual(day(2026, 4, 30));
  });

  // ── Edge: cross-month/year arithmetic ────────────────────────────────────

  it("上上周 wraps to March when now=2026-04-07", () => {
    const nowEarly = new Date(2026, 3, 7, 10, 0, 0); // 2026-04-07 (Tuesday)
    // daysSinceMonday=1; thisMonday=04-06; 2 weeks back Monday=03-23
    expect(extractDateRange("上上周讨论了什么", nowEarly)).toEqual(
      range(2026, 3, 23, 2026, 3, 29),
    );
  });

  it("三周前的周四 when now=2026-04-07 → 2026-03-19", () => {
    const nowEarly = new Date(2026, 3, 7, 10, 0, 0); // Tuesday 2026-04-07
    // daysSinceMonday=1; Thu is weekdayIndex=3
    // weekdayDateBack(now, 3, 3): daysAgo = -(3-1) + 3*7 = -2+21 = 19
    // 04-07 - 19 = 03-19
    expect(extractDateRange("三周前的周四", nowEarly)).toEqual(
      day(2026, 3, 19),
    );
  });

  it("上个月 when now=2026-01-15 → December 2025", () => {
    const nowJan = new Date(2026, 0, 15, 10, 0, 0);
    expect(extractDateRange("上个月", nowJan)).toEqual(
      range(2025, 12, 1, 2025, 12, 31),
    );
  });
});
