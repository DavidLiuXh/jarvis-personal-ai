/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RuntimeConversationContent } from "./runtimeTypes.js";

/**
 * Returns true for any network-level error that is worth retrying:
 * - TypeError: fetch failed  (DNS/connection refused before stream starts)
 * - Premature close          (stream cut mid-response)
 * - ECONNRESET               (TCP reset)
 * - ERR_STREAM_PREMATURE_CLOSE
 */
export function isFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    err instanceof TypeError &&
    err.message.toLowerCase().includes("fetch failed")
  )
    return true;
  if (err.message?.includes("Premature close")) return true;
  if (err.message?.includes("ECONNRESET")) return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET")
    return true;
  return false;
}

/**
 * Removes a trailing orphaned user turn from history.
 *
 * An orphaned turn is a user message at the end of history that has no
 * corresponding model response — it was pushed before the API call but the
 * call failed, leaving the history in an inconsistent state.
 *
 * functionResponse parts (tool results) are NOT considered orphaned; they
 * are always paired with a preceding model functionCall and must be kept.
 */
export function cleanOrphanedUserTurn<T extends RuntimeConversationContent>(
  history: T[],
): T[] {
  if (history.length === 0) return history;

  const last = history[history.length - 1];
  if (last.role !== "user") return history;

  // Keep functionResponse turns — they are tool results paired with model calls
  const isFunctionResponse = last.parts?.some((p) => "functionResponse" in p);
  if (isFunctionResponse) return history;

  // Trailing plain user message with no model response → orphaned
  return history.slice(0, -1);
}
