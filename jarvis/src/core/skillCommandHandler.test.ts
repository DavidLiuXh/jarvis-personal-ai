/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SkillCommandHandler } from './skillCommandHandler.js';

function makeHandler(skills: Array<{ name: string; description: string }> = []) {
  const setAvailableSkills = vi.fn();
  const reloadSkillManager = vi.fn().mockResolvedValue(undefined);
  const loadSkills = vi.fn().mockResolvedValue(skills);

  const handler = new SkillCommandHandler(setAvailableSkills, reloadSkillManager, loadSkills, skills);
  return { handler, setAvailableSkills, reloadSkillManager, loadSkills };
}

describe('SkillCommandHandler', () => {
  it('handles !skill reload and updates agent skills', async () => {
    const skills = [
      { name: 'test-driven-development', description: 'Use when implementing features' },
    ];
    const { handler, setAvailableSkills, reloadSkillManager, loadSkills } = makeHandler(skills);

    const result = await handler.handle('!skill reload');

    expect(loadSkills).toHaveBeenCalledOnce();
    expect(reloadSkillManager).toHaveBeenCalledOnce();
    expect(setAvailableSkills).toHaveBeenCalledWith(skills);
    expect(result).toContain('1');
    expect(result).toContain('test-driven-development');
  });

  it('handles !skill list to show current skills', async () => {
    const skills = [
      { name: 'brainstorming', description: 'Use before creative work' },
      { name: 'systematic-debugging', description: 'Use when debugging' },
    ];
    const { handler } = makeHandler(skills);

    const result = await handler.handle('!skill list');

    expect(result).toContain('brainstorming');
    expect(result).toContain('systematic-debugging');
    expect(result).toContain('2');
  });

  it('returns help for unknown subcommand', async () => {
    const { handler } = makeHandler();
    const result = await handler.handle('!skill unknown');
    expect(result.toLowerCase()).toContain('usage');
  });

  it('returns empty message when no skills found after reload', async () => {
    const { handler, setAvailableSkills } = makeHandler([]);
    const result = await handler.handle('!skill reload');
    expect(setAvailableSkills).toHaveBeenCalledWith([]);
    expect(result).toContain('0');
  });

  it('ignores non-!skill input', async () => {
    const { handler } = makeHandler();
    const result = await handler.handle('hello');
    expect(result).toBe('');
  });
});
