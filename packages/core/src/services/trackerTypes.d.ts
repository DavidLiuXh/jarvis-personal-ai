/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
export declare enum TaskType {
    EPIC = "epic",
    TASK = "task",
    BUG = "bug"
}
export declare const TaskTypeSchema: z.ZodNativeEnum<typeof TaskType>;
export declare enum TaskStatus {
    OPEN = "open",
    IN_PROGRESS = "in_progress",
    BLOCKED = "blocked",
    CLOSED = "closed"
}
export declare const TaskStatusSchema: z.ZodNativeEnum<typeof TaskStatus>;
export declare const TrackerTaskSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    type: z.ZodNativeEnum<typeof TaskType>;
    status: z.ZodNativeEnum<typeof TaskStatus>;
    parentId: z.ZodOptional<z.ZodString>;
    dependencies: z.ZodArray<z.ZodString, "many">;
    subagentSessionId: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    type: TaskType;
    status: TaskStatus;
    description: string;
    title: string;
    id: string;
    dependencies: string[];
    metadata?: Record<string, unknown> | undefined;
    parentId?: string | undefined;
    subagentSessionId?: string | undefined;
}, {
    type: TaskType;
    status: TaskStatus;
    description: string;
    title: string;
    id: string;
    dependencies: string[];
    metadata?: Record<string, unknown> | undefined;
    parentId?: string | undefined;
    subagentSessionId?: string | undefined;
}>;
export type TrackerTask = z.infer<typeof TrackerTaskSchema>;
