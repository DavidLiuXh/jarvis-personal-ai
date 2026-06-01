/**
 * Backend-aware smoke evals for the neutral LLM backend/tool-loop contract.
 *
 * These evals are intentionally offline. They validate provider adapters and
 * the shared ToolLoopRuntime contract without requiring live API credentials.
 */

import { ToolLoopRuntime } from "../packages/agent-runtime/src/llmBackend.js";
import {
  OpenAiChatCompletionsBackend,
  OpenAiPromptCompiler,
} from "../packages/agent-runtime/src/openAiBackend.js";
import { GeminiPromptCompiler } from "../jarvis/src/core/geminiBackendAdapter.js";
import type {
  LlmBackend,
  LlmEvent,
} from "../packages/agent-runtime/src/llmBackend.js";
import type {
  RuntimeToolRequest,
  RuntimeToolResult,
} from "../packages/intent-runtime/src/index.js";

type EvalCase = {
  name: string;
  run: () => Promise<void>;
};

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function mockBackend(turns: LlmEvent[][]): LlmBackend {
  let index = 0;
  return {
    getModel: () => "mock",
    getCapabilities: () => ({
      streaming: true,
      nativeToolCalling: true,
      jsonMode: false,
      multimodalInput: false,
      maxContextTokens: 4096,
      modes: ["native_tool_calling"],
    }),
    async *sendTurn() {
      yield* turns[index++] ?? [];
    },
  };
}

function sse(...payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

const cases: EvalCase[] = [
  {
    name: "gemini-compatible-prompt-compiler-tool-loop",
    async run() {
      const toolResults: RuntimeToolResult[] = [];
      const runtime = new ToolLoopRuntime({
        backend: mockBackend([
          [
            {
              type: "tool_call",
              request: {
                name: "task_add",
                callId: "call-1",
                args: { title: "review" },
              },
            },
          ],
          [{ type: "content", text: "done" }],
        ]),
        promptCompiler: new GeminiPromptCompiler(),
        toolExecutor: {
          executeTools: async (requests: RuntimeToolRequest[]) =>
            requests.map((request) => ({
              name: request.name,
              callId: request.callId,
              status: "success",
              output: { ok: true },
            })),
        },
        onToolResult: (result) => toolResults.push(result),
      });
      const result = await runtime.run({
        userPrompt: "schedule review",
        initialMessages: [
          { role: "user", blocks: [{ type: "text", text: "schedule review" }] },
        ],
        signal: new AbortController().signal,
      });
      assert(result.toolsCalled.has("task_add"), "task_add was not called");
      assert(toolResults[0]?.status === "success", "tool result failed");
    },
  },
  {
    name: "openai-compatible-streaming-tool-call",
    async run() {
      const backend = new OpenAiChatCompletionsBackend({
        apiKey: "test-key",
        model: "gpt-test",
        fetchFn: (async () =>
          new Response(
            sse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        function: {
                          name: "task_add",
                          arguments: '{"title":"review"}',
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      });
      const events = [];
      for await (const event of backend.sendTurn(
        {
          messages: [
            {
              role: "user",
              blocks: [{ type: "text", text: "schedule review" }],
            },
          ],
          tools: [{ name: "task_add", parameters: { type: "object" } }],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      assert(events[0]?.type === "tool_call", "OpenAI tool call missing");
      assert(
        (events[0] as any).request.args.title === "review",
        "OpenAI tool args not reconstructed",
      );
      const compiled = new OpenAiPromptCompiler().compileToolResults(
        [
          {
            name: "task_add",
            callId: "call-1",
            status: "success",
            output: { ok: true },
          },
        ],
        [{ name: "task_add", callId: "call-1", args: { title: "review" } }],
      );
      assert(compiled[0]?.role === "assistant", "assistant tool call missing");
      assert(compiled[1]?.role === "tool", "tool result missing");
    },
  },
];

let failed = 0;
for (const testCase of cases) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failed++;
    console.error(
      `FAIL ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failed > 0) process.exit(1);
console.log(`Result: ${cases.length}/${cases.length} passed`);
