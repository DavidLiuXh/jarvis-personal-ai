/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { BackgroundDistiller } from './backgroundDistiller.js';

describe('BackgroundDistiller', () => {
  it('calls saveFact for each fact found in LLM response', async () => {
    const generateText = vi.fn().mockResolvedValue(
      '{"found": true, "facts": [{"category": "identity", "content": "user prefers dark mode"}]}'
    );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill('what theme do you prefer?', 'I prefer dark mode');

    expect(fakeSaveFact).toHaveBeenCalledOnce();
    expect(fakeSaveFact).toHaveBeenCalledWith('identity', 'user prefers dark mode', 10);
  });

  it('calls no saveFact when LLM reports found: false', async () => {
    const generateText = vi.fn().mockResolvedValue('{"found": false}');
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill('hello', 'hello back');

    expect(fakeSaveFact).not.toHaveBeenCalled();
  });

  it('distill prompt includes all four categories, dedup rule, and preference clarification', async () => {
    const generateText = vi.fn().mockResolvedValue('{"found": false}');
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill('show me data', 'here is a table');

    const calledPrompt = generateText.mock.calls[0][0] as string;
    expect(calledPrompt).toContain('identity');
    expect(calledPrompt).toContain('behavior');
    expect(calledPrompt).toContain('preference');
    expect(calledPrompt).toContain('specification');
    expect(calledPrompt).toContain('exactly ONE category');
    // preference must be restricted to response style, not user traits
    expect(calledPrompt).toContain('FORMAT or STYLE');
  });

  it('saves preference facts with correct category', async () => {
    const generateText = vi.fn().mockResolvedValue(
      '{"found": true, "facts": [{"category": "preference", "content": "user prefers table format for data"}]}'
    );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill('show me the data', 'here is a table...');

    expect(fakeSaveFact).toHaveBeenCalledWith('preference', 'user prefers table format for data', 10);
  });

  it('saves behavior facts with correct category', async () => {
    const generateText = vi.fn().mockResolvedValue(
      '{"found": true, "facts": [{"category": "behavior", "content": "user always asks for background before details"}]}'
    );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill('what is X?', 'X is...');

    expect(fakeSaveFact).toHaveBeenCalledWith('behavior', 'user always asks for background before details', 10);
  });

  it('does not throw when LLM returns malformed JSON', async () => {
    const generateText = vi.fn().mockResolvedValue('not json at all');
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await expect(distiller.distill('hi', 'hi')).resolves.not.toThrow();
    expect(fakeSaveFact).not.toHaveBeenCalled();
  });

  it('does not throw when generateText rejects, and logs the error', async () => {
    const apiError = Object.assign(new Error('models/gemini-1.5-flash is not found'), { status: 404 });
    const generateText = vi.fn().mockRejectedValue(apiError);
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(distiller.distill('hi', 'hi')).resolves.not.toThrow();
    expect(fakeSaveFact).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[BackgroundDistiller] distill failed:'),
      apiError,
    );

    consoleSpy.mockRestore();
  });
});
