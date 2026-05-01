/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AgentCard, AgentTask } from "./externalAgent.js";

/** How long to wait for the agent process to become ready (ms) */
const READY_TIMEOUT_MS = 30_000;
/** How often to poll the health endpoint while waiting (ms) */
const READY_POLL_INTERVAL_MS = 500;
/** HTTP read timeout for A2A streaming calls (ms) */
const STREAM_TIMEOUT_MS = 300_000; // 5 minutes

// ── Port allocation ──────────────────────────────────────────────────────────

/** Finds a free TCP port on localhost. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

// ── Process health check ─────────────────────────────────────────────────────

/**
 * Polls the agent's /.well-known/agent.json endpoint until it returns 200
 * or the timeout expires. Returns true when ready.
 */
async function waitForReady(
  port: number,
  isExited: () => boolean,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/.well-known/agent-card.json`;
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Fast-fail: if the process already exited, no point continuing to poll
    if (isExited()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // process not yet listening — wait and retry
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  return false;
}

// ── A2A event helpers ─────────────────────────────────────────────────────────

/**
 * Normalise A2A task state strings.
 * The spec uses SCREAMING_SNAKE_CASE in proto and lower-kebab in JSON.
 * We accept both.
 */
function normalizeState(raw: string): string {
  return raw.toLowerCase().replace(/_/g, "-");
}

// ── A2A JSON-RPC helpers ─────────────────────────────────────────────────────

// a2a-sdk serializes protobuf via json_format.MessageToDict which produces camelCase.
// Verified format from official Python client (a2a-sdk 1.0.2):
//   Message: { messageId, role: "ROLE_USER", parts: [{ text }] }
//   StreamResponse: { statusUpdate: { status: { state: "TASK_STATE_*" } } }
//                   { artifactUpdate: { artifact: { parts: [{ text }] } } }
type A2ATextPart = { text: string };
type A2AMessage = {
  role: "ROLE_USER";
  parts: A2ATextPart[];
  messageId: string;
};

function buildA2AMessage(text: string): A2AMessage {
  return {
    role: "ROLE_USER",
    parts: [{ text }],
    messageId: crypto.randomUUID(),
  };
}

// ── Streaming SSE parser ─────────────────────────────────────────────────────

/** Yields parsed JSON objects from an SSE stream body. */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // malformed SSE chunk — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Main launcher ────────────────────────────────────────────────────────────

export type LaunchCallbacks = {
  onChunk: (chunk: string) => void;
  onComplete: (output: string) => void;
  onFailed: (error: string) => void;
  onInputRequired: (question: string, contextId: string) => void;
  onLog?: (line: string) => void;
};

/**
 * Spawns an ADK agent process, waits until it is ready, sends the task via
 * A2A streaming, relays chunks back through callbacks, then kills the process.
 */
export async function launchAgent(
  card: AgentCard,
  task: AgentTask,
  callbacks: LaunchCallbacks,
): Promise<{ pid: number; port: number } | null> {
  let child: ChildProcess | null = null;
  let port = 0;

  try {
    // ── 1. Allocate port + Spawn Python process ──────────────────────────────
    // findFreePort is inside try so port-allocation failures call onFailed
    // instead of propagating as an unhandled rejection.
    port = await findFreePort();
    child = spawn("python3", [card.entrypoint], {
      env: {
        ...process.env,
        JARVIS_AGENT_PORT: String(port),
        JARVIS_AGENT_ID: card.agentId,
        JARVIS_TASK_ID: task.taskId,
        JARVIS_SESSION_ID: task.sessionId,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const pid = child.pid!;

    const logLine = (line: string) => {
      console.error(`[Agent:${card.agentId}:${pid}] ${line}`);
      callbacks.onLog?.(line);
    };
    child.stdout?.on("data", (d: Buffer) =>
      d.toString().split("\n").filter(Boolean).forEach(logLine),
    );
    child.stderr?.on("data", (d: Buffer) =>
      d.toString().split("\n").filter(Boolean).forEach(logLine),
    );

    let processExited = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      child!.on("exit", (code) => {
        processExited = true;
        resolve(code);
      });
    });

    console.error(
      `🚀 [AgentLauncher] Spawned ${card.agentId} (pid=${pid}, port=${port})`,
    );

    // ── 2. Wait for agent to be ready ────────────────────────────────────────
    const ready = await waitForReady(port, () => processExited);
    if (!ready || processExited) {
      const msg = processExited
        ? `Agent process exited before becoming ready`
        : `Agent did not become ready within ${READY_TIMEOUT_MS}ms`;
      callbacks.onFailed(msg);
      child.kill();
      return null;
    }

    console.error(
      `✅ [AgentLauncher] Agent ${card.agentId} ready on port ${port}`,
    );

    // ── 3. Build A2A request payload ─────────────────────────────────────────
    // Serialize task input as a human-readable text message
    const inputText = JSON.stringify(task.input, null, 2);
    const a2aMessage = buildA2AMessage(inputText);

    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: task.taskId,
      method: "SendStreamingMessage",
      params: {
        message: a2aMessage,
        configuration: { acceptedOutputModes: ["text/plain"] },
      },
    });

    // ── 4. Call agent via A2A streaming ──────────────────────────────────────
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "A2A-Version": "1.0",
      },
      body: rpcBody,
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
      callbacks.onFailed(`A2A call failed: HTTP ${response.status}`);
      child.kill();
      return null;
    }

    // ── 5. Stream SSE events ─────────────────────────────────────────────────
    // a2a-sdk 1.0 StreamResponse structure (camelCase from MessageToDict):
    //   { result: { artifactUpdate: { artifact: { parts: [{ text }] } } } }
    //   { result: { statusUpdate: { status: { state: "TASK_STATE_*" } } } }
    //   { result: { task: { ... } } }  (initial task object)
    let finalOutput = "";
    let taskCompleted = false;

    for await (const event of parseSSE(response.body)) {
      const e = event as any;
      const result = e?.result;
      if (!result) continue;

      // TaskArtifactUpdateEvent — streaming text chunk
      if (result.artifactUpdate) {
        const parts: any[] = result.artifactUpdate.artifact?.parts ?? [];
        for (const part of parts) {
          if (part.text) {
            callbacks.onChunk(part.text);
            finalOutput += part.text;
          }
        }
        continue;
      }

      // TaskStatusUpdateEvent
      if (result.statusUpdate) {
        const state = normalizeState(result.statusUpdate.status?.state ?? "");

        if (
          state === "task-state-input-required" ||
          state === "input-required"
        ) {
          const msgParts: any[] =
            result.statusUpdate.status?.message?.parts ?? [];
          const question =
            msgParts.find((p: any) => p.text)?.text ??
            "Agent requires additional input.";
          const contextId: string =
            result.statusUpdate.contextId ?? task.taskId;
          callbacks.onInputRequired(question, contextId);
          response.body?.cancel().catch(() => {});
          return { pid, port };
        }

        if (state === "task-state-completed" || state === "completed") {
          taskCompleted = true;
          continue;
        }

        if (
          state === "task-state-failed" ||
          state === "failed" ||
          state === "task-state-rejected" ||
          state === "rejected"
        ) {
          const errMsg =
            result.statusUpdate.status?.message?.parts?.find((p: any) => p.text)
              ?.text ?? "Agent task failed";
          callbacks.onFailed(errMsg);
          child.kill();
          return null;
        }
      }

      // Top-level Message result (non-streaming fallback)
      if (result.message?.parts) {
        const parts: any[] = result.message.parts;
        for (const part of parts) {
          if (part.text) {
            finalOutput += part.text;
          }
        }
        taskCompleted = true;
      }
    }

    // ── 6. Finalize ──────────────────────────────────────────────────────────
    if (!taskCompleted && !finalOutput) {
      // Stream ended without a clear completion event — use what we got
      console.error(
        `⚠️ [AgentLauncher] Stream ended without explicit completion for task ${task.taskId}`,
      );
    }

    callbacks.onComplete(finalOutput || "(no output)");

    // Wait for process to exit cleanly, then kill if it doesn't
    const exitCode = await Promise.race([
      exitPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (exitCode === null) {
      console.error(
        `⚠️ [AgentLauncher] Agent did not exit within 5s, force-killing (pid=${pid})`,
      );
      child.kill("SIGKILL");
    }

    return { pid, port };
  } catch (err: any) {
    callbacks.onFailed(`Launcher error: ${err.message}`);
    child?.kill();
    return null;
  }
}

/**
 * Sends user input to an already-running agent task (INPUT_REQUIRED state).
 * Resumes the stream and relays remaining output through callbacks.
 */
export async function sendAgentInput(
  port: number,
  taskId: string,
  contextId: string,
  value: string,
  callbacks: LaunchCallbacks,
): Promise<void> {
  const a2aMessage = buildA2AMessage(value);
  const rpcBody = JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "SendStreamingMessage",
    params: {
      message: { ...a2aMessage, taskId, contextId },
      configuration: { acceptedOutputModes: ["text/plain"] },
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "A2A-Version": "1.0",
      },
      body: rpcBody,
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
      callbacks.onFailed(`A2A resume failed: HTTP ${response.status}`);
      return;
    }

    let finalOutput = "";
    for await (const event of parseSSE(response.body)) {
      const e = event as any;
      const result = e?.result;
      if (!result) continue;

      if (result.artifactUpdate) {
        for (const part of result.artifactUpdate.artifact?.parts ?? []) {
          if (part.text) {
            callbacks.onChunk(part.text);
            finalOutput += part.text;
          }
        }
      }

      if (result.statusUpdate) {
        const state = normalizeState(result.statusUpdate.status?.state ?? "");
        if (state === "task-state-completed" || state === "completed") break;
        if (
          state === "task-state-failed" ||
          state === "failed" ||
          state === "task-state-rejected" ||
          state === "rejected"
        ) {
          const errMsg =
            result.statusUpdate.status?.message?.parts?.find((p: any) => p.text)
              ?.text ?? "Agent task failed";
          callbacks.onFailed(errMsg);
          return;
        }
        if (
          state === "task-state-input-required" ||
          state === "input-required"
        ) {
          const msgParts: any[] =
            result.statusUpdate.status?.message?.parts ?? [];
          const question =
            msgParts.find((p: any) => p.text)?.text ??
            "Agent requires additional input.";
          const newContextId: string =
            result.statusUpdate.contextId ?? contextId;
          callbacks.onInputRequired(question, newContextId);
          return;
        }
      }
    }
    callbacks.onComplete(finalOutput || "(no output)");
  } catch (err: any) {
    callbacks.onFailed(`sendAgentInput error: ${err.message}`);
  }
}
