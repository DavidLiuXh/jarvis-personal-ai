/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
export var TaskType;
(function (TaskType) {
    TaskType["EPIC"] = "epic";
    TaskType["TASK"] = "task";
    TaskType["BUG"] = "bug";
})(TaskType || (TaskType = {}));
export const TaskTypeSchema = z.nativeEnum(TaskType);
export var TaskStatus;
(function (TaskStatus) {
    TaskStatus["OPEN"] = "open";
    TaskStatus["IN_PROGRESS"] = "in_progress";
    TaskStatus["BLOCKED"] = "blocked";
    TaskStatus["CLOSED"] = "closed";
})(TaskStatus || (TaskStatus = {}));
export const TaskStatusSchema = z.nativeEnum(TaskStatus);
export const TrackerTaskSchema = z.object({
    id: z.string().length(6),
    title: z.string(),
    description: z.string(),
    type: TaskTypeSchema,
    status: TaskStatusSchema,
    parentId: z.string().optional(),
    dependencies: z.array(z.string()),
    subagentSessionId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
});
//# sourceMappingURL=trackerTypes.js.map