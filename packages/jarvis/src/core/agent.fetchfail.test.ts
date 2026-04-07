/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for fetch-failed retry and orphaned-turn cleanup behaviour.
 *
 * We test the two behaviours in isolation by mocking the internals that
 * agent.ts relies on, without spinning up a real GeminiClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — extracted pure functions that we can unit-test without the full
// agent stack.
// ---------------------------------------------------------------------------

import {
  isFetchError,
  cleanOrphanedUserTurn,
} from './agentNetworkUtils.js';

import type { Content } from '../../../core/src/index.js';

describe('isFetchError', () => {
  it('returns true for TypeError: fetch failed', () => {
    expect(isFetchError(new TypeError('fetch failed'))).toBe(true);
  });

  it('returns true for Premature close', () => {
    const err = Object.assign(new Error('Premature close'), {});
    expect(isFetchError(err)).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(isFetchError(err)).toBe(true);
  });

  it('returns true for ERR_STREAM_PREMATURE_CLOSE', () => {
    const err = Object.assign(new Error('stream error'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    expect(isFetchError(err)).toBe(true);
  });

  it('returns false for non-network errors', () => {
    expect(isFetchError(new Error('some other error'))).toBe(false);
    expect(isFetchError(new Error('invalid JSON'))).toBe(false);
  });
});

describe('cleanOrphanedUserTurn', () => {
  it('removes trailing user turn when there is no model response after it', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'first message' }] },
      { role: 'model', parts: [{ text: 'first response' }] },
      { role: 'user', parts: [{ text: 'second message — orphaned' }] },
      // no model response — orphaned
    ];
    const cleaned = cleanOrphanedUserTurn(history);
    expect(cleaned).toHaveLength(2);
    expect(cleaned[cleaned.length - 1].role).toBe('model');
  });

  it('does not remove user turn when it has a model response', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'message' }] },
      { role: 'model', parts: [{ text: 'response' }] },
    ];
    const cleaned = cleanOrphanedUserTurn(history);
    expect(cleaned).toHaveLength(2);
  });

  it('does not remove functionResponse turns (tool results)', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'message' }] },
      { role: 'model', parts: [{ functionCall: { name: 'tool', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'tool', response: {} } }] },
      // functionResponse turn at end — should NOT be removed
    ];
    const cleaned = cleanOrphanedUserTurn(history);
    expect(cleaned).toHaveLength(3);
  });

  it('returns history unchanged when empty', () => {
    expect(cleanOrphanedUserTurn([])).toEqual([]);
  });

  it('returns history unchanged when last turn is model', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ];
    expect(cleanOrphanedUserTurn(history)).toHaveLength(2);
  });
});
