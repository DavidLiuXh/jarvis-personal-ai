/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmMessage } from "../agent-runtime/index.js";
import type { SessionTranscript } from "../memory-runtime/index.js";
import type { RuntimeConversationContent } from "./runtimeTypes.js";

function roleToLlmRole(
  role: SessionTranscript["turns"][number]["role"],
): LlmMessage["role"] {
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  return "user";
}

export function transcriptToLlmMessages(
  transcript: SessionTranscript,
): LlmMessage[] {
  return transcript.turns
    .map((turn): LlmMessage | null => {
      const content = turn.content.trim();
      if (!content) return null;
      return {
        role: roleToLlmRole(turn.role),
        blocks: [{ type: "text", text: content }],
        metadata: {
          timestamp: turn.timestamp,
          source: transcript.source,
          sessionId: transcript.sessionId,
          ...turn.metadata,
        },
      };
    })
    .filter((message): message is LlmMessage => Boolean(message));
}

export function transcriptToRuntimeConversation(
  transcript: SessionTranscript,
): RuntimeConversationContent[] {
  return transcript.turns
    .map((turn): RuntimeConversationContent | null => {
      const content = turn.content.trim();
      if (!content) return null;
      return {
        role: turn.role === "assistant" ? "model" : turn.role,
        parts: [{ text: content }],
      };
    })
    .filter((turn): turn is RuntimeConversationContent => Boolean(turn));
}
