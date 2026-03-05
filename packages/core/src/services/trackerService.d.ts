/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type TrackerTask } from './trackerTypes.js';
export declare class TrackerService {
    readonly trackerDir: string;
    private readonly tasksDir;
    private initialized;
    constructor(trackerDir: string);
    private ensureInitialized;
    /**
     * Generates a 6-character hex ID.
     */
    private generateId;
    /**
     * Creates a new task and saves it to disk.
     */
    createTask(taskData: Omit<TrackerTask, 'id'>): Promise<TrackerTask>;
    /**
     * Helper to read and validate a JSON file.
     */
    private readJsonFile;
    /**
     * Reads a task by ID.
     */
    getTask(id: string): Promise<TrackerTask | null>;
    /**
     * Lists all tasks in the tracker.
     */
    listTasks(): Promise<TrackerTask[]>;
    /**
     * Updates an existing task and saves it to disk.
     */
    updateTask(id: string, updates: Partial<TrackerTask>): Promise<TrackerTask>;
    /**
     * Saves a task to disk.
     */
    private saveTask;
    /**
     * Validates that a task can be closed (all dependencies must be closed).
     */
    private validateCanClose;
    /**
     * Validates that there are no circular dependencies.
     */
    private validateNoCircularDependencies;
}
