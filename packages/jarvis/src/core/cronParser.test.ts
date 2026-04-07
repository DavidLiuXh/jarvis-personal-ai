/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseNaturalTimeToCron } from './cronParser.js';

describe('parseNaturalTimeToCron', () => {
  // Daily
  it('parses "every day at 8am"', () => {
    expect(parseNaturalTimeToCron('every day at 8am')).toBe('0 8 * * *');
  });
  it('parses "每天早上8点"', () => {
    expect(parseNaturalTimeToCron('每天早上8点')).toBe('0 8 * * *');
  });
  it('parses "每天下午3点"', () => {
    expect(parseNaturalTimeToCron('每天下午3点')).toBe('0 15 * * *');
  });
  it('parses "每天晚上10点"', () => {
    expect(parseNaturalTimeToCron('每天晚上10点')).toBe('0 22 * * *');
  });
  it('parses "daily at 22:30"', () => {
    expect(parseNaturalTimeToCron('daily at 22:30')).toBe('30 22 * * *');
  });

  // Weekdays
  it('parses "每周一到周五下午3点"', () => {
    expect(parseNaturalTimeToCron('每周一到周五下午3点')).toBe('0 15 * * 1-5');
  });
  it('parses "weekdays at 9am"', () => {
    expect(parseNaturalTimeToCron('weekdays at 9am')).toBe('0 9 * * 1-5');
  });
  it('parses "工作日早上9点"', () => {
    expect(parseNaturalTimeToCron('工作日早上9点')).toBe('0 9 * * 1-5');
  });

  // Specific weekday
  it('parses "every monday at 10am"', () => {
    expect(parseNaturalTimeToCron('every monday at 10am')).toBe('0 10 * * 1');
  });
  it('parses "每周一早上10点"', () => {
    expect(parseNaturalTimeToCron('每周一早上10点')).toBe('0 10 * * 1');
  });
  it('parses "每周五晚上8点"', () => {
    expect(parseNaturalTimeToCron('每周五晚上8点')).toBe('0 20 * * 5');
  });

  // Interval
  it('parses "every 30 minutes"', () => {
    expect(parseNaturalTimeToCron('every 30 minutes')).toBe('*/30 * * * *');
  });
  it('parses "每隔2小时"', () => {
    expect(parseNaturalTimeToCron('每隔2小时')).toBe('0 */2 * * *');
  });
  it('parses "每小时"', () => {
    expect(parseNaturalTimeToCron('每小时')).toBe('0 * * * *');
  });

  // Already valid cron — pass through
  it('passes through valid cron expression unchanged', () => {
    expect(parseNaturalTimeToCron('0 8 * * 1-5')).toBe('0 8 * * 1-5');
  });

  // Unrecognized — returns null
  it('returns null for unrecognized input', () => {
    expect(parseNaturalTimeToCron('sometime next week')).toBeNull();
  });
});
