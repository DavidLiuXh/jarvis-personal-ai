/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type RuntimeFunctionResponsePart = {
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
};

export type RuntimeContentPart = RuntimeFunctionResponsePart & {
  text?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  thoughtSignature?: unknown;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
  [key: string]: unknown;
};

export type RuntimeToolResultLike = {
  name: string;
  callId: string;
  status: "success" | "failed" | "blocked";
  output: unknown;
};

export type RuntimeConversationContent = {
  role: "user" | "model" | "assistant" | "tool" | "system";
  parts: RuntimeContentPart[];
};

export const JarvisRuntimeEventType = {
  CONTENT: "content",
  TOOL_CALL_REQUEST: "tool_call_request",
  ERROR: "error",
  MODEL_INFO: "model_info",
} as const;

export function runtimeFunctionResponseToToolResult(
  part: RuntimeFunctionResponsePart,
): RuntimeToolResultLike | null {
  const response = part.functionResponse;
  if (!response?.name) return null;
  const output = response.response;
  const failed =
    !!output &&
    typeof output === "object" &&
    ("error" in output || (output as { status?: unknown }).status === "error");
  return {
    name: response.name,
    callId: response.id ?? response.name,
    status: failed ? "failed" : "success",
    output,
  };
}

export function toolResultToRuntimeFunctionResponse(
  result: RuntimeToolResultLike,
): RuntimeFunctionResponsePart {
  return {
    functionResponse: {
      id: result.callId,
      name: result.name,
      response: result.output,
    },
  };
}
