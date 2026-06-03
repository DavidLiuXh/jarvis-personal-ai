/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  RuntimeToolRequest,
  RuntimeToolResult,
} from "../intent-runtime/index.js";
import type { MemoryContract } from "../memory-runtime/index.js";

export type SafetyPolicyDecision = {
  allowed: boolean;
  reasonCode: string;
  message?: string;
};

export type SafetyPolicyContext = {
  memoryContract?: MemoryContract | null;
  userPrompt?: string;
  metadata?: Record<string, unknown>;
};

export interface SafetyPolicyEngine {
  checkPrompt(
    prompt: string,
    context?: SafetyPolicyContext,
  ): Promise<SafetyPolicyDecision>;
  checkToolCall(
    request: RuntimeToolRequest,
    context?: SafetyPolicyContext,
  ): Promise<SafetyPolicyDecision>;
  checkToolResult(
    result: RuntimeToolResult,
    context?: SafetyPolicyContext,
  ): Promise<SafetyPolicyDecision>;
  checkResponse(
    response: string,
    context?: SafetyPolicyContext,
  ): Promise<SafetyPolicyDecision>;
}

const ALLOW: SafetyPolicyDecision = {
  allowed: true,
  reasonCode: "JARVIS_POLICY_ALLOW",
};

export class JarvisSafetyPolicyEngine implements SafetyPolicyEngine {
  async checkPrompt(): Promise<SafetyPolicyDecision> {
    return ALLOW;
  }

  async checkToolCall(
    request: RuntimeToolRequest,
    context: SafetyPolicyContext = {},
  ): Promise<SafetyPolicyDecision> {
    const contract = context.memoryContract;
    if (
      request.name === "recall_memory" &&
      contract &&
      (contract.subjectBoundary === "external" ||
        !contract.needMemory ||
        !contract.targetScopes.includes("entry"))
    ) {
      return {
        allowed: false,
        reasonCode: "MEMORY_CONTRACT_DENIES_RECALL",
        message:
          "PERSONAL MEMORY ACCESS DENIED by current MemoryContract. Proceed without personal long-term memory.",
      };
    }
    return ALLOW;
  }

  async checkToolResult(): Promise<SafetyPolicyDecision> {
    return ALLOW;
  }

  async checkResponse(): Promise<SafetyPolicyDecision> {
    return ALLOW;
  }
}
