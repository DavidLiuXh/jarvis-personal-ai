import {
  IntentExecutor,
  type RuntimeToolRequest,
  type RuntimeToolResult,
  type ToolExecutorAdapter,
} from "@jarvis/intent-runtime";
import { createSampleIntent } from "./sampleIntent.js";

const toolExecutor: ToolExecutorAdapter = {
  async executeTools(
    requests: RuntimeToolRequest[],
  ): Promise<RuntimeToolResult[]> {
    return requests.map((request) => ({
      name: request.name,
      callId: request.callId,
      status: "success",
      output: { ok: true, args: request.args },
    }));
  },
};

const intent = createSampleIntent({
  subject: "mixed",
  taskType: "schedule",
  needsTool: true,
  needsScheduling: true,
  reason: "Create every Friday 14:00 weekly report",
  evidence: ["Create every Friday 14:00 weekly report"],
  intentSteps: [
    {
      id: "step-1",
      type: "schedule",
      action: "create every Friday 14:00",
      target: "weekly report",
      operation: {
        domain: "task_management",
        action: "create",
        targetType: "task",
        target: "weekly report",
        scope: "scheduled_tasks",
        riskLevel: "medium",
      },
      dependsOn: [],
      requiresConfirmation: false,
      riskLevel: "medium",
    },
  ],
});

const executor = new IntentExecutor(toolExecutor);
const result = await executor.execute({
  intent,
  context: { userPrompt: "Create a weekly report task" },
});

console.log(result.status, result.completedTools);
