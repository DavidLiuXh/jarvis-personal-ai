/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { debugLogger } from '../utils/debugLogger.js';
import { coreEvents } from '../utils/events.js';
import { TrackerTaskSchema, TaskStatus, } from './trackerTypes.js';
import {} from 'zod';
export class TrackerService {
    trackerDir;
    tasksDir;
    initialized = false;
    constructor(trackerDir) {
        this.trackerDir = trackerDir;
        this.tasksDir = trackerDir;
    }
    async ensureInitialized() {
        if (!this.initialized) {
            await fs.mkdir(this.tasksDir, { recursive: true });
            this.initialized = true;
        }
    }
    /**
     * Generates a 6-character hex ID.
     */
    generateId() {
        return randomBytes(3).toString('hex');
    }
    /**
     * Creates a new task and saves it to disk.
     */
    async createTask(taskData) {
        await this.ensureInitialized();
        const id = this.generateId();
        const task = {
            ...taskData,
            id,
        };
        if (task.parentId) {
            const parentList = await this.listTasks();
            if (!parentList.find((t) => t.id === task.parentId)) {
                throw new Error(`Parent task with ID ${task.parentId} not found.`);
            }
        }
        TrackerTaskSchema.parse(task);
        await this.saveTask(task);
        return task;
    }
    /**
     * Helper to read and validate a JSON file.
     */
    async readJsonFile(filePath, schema) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            return schema.parse(data);
        }
        catch (error) {
            if (error &&
                typeof error === 'object' &&
                'code' in error &&
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                error.code === 'ENOENT') {
                return null;
            }
            const fileName = path.basename(filePath);
            debugLogger.warn(`Failed to read or parse task file ${fileName}:`, error);
            coreEvents.emitFeedback('warning', `Task tracker encountered an issue reading ${fileName}. The data might be corrupted.`, error);
            throw error;
        }
    }
    /**
     * Reads a task by ID.
     */
    async getTask(id) {
        await this.ensureInitialized();
        const taskPath = path.join(this.tasksDir, `${id}.json`);
        return this.readJsonFile(taskPath, TrackerTaskSchema);
    }
    /**
     * Lists all tasks in the tracker.
     */
    async listTasks() {
        await this.ensureInitialized();
        try {
            const files = await fs.readdir(this.tasksDir);
            const jsonFiles = files.filter((f) => f.endsWith('.json'));
            const tasks = await Promise.all(jsonFiles.map(async (f) => {
                const taskPath = path.join(this.tasksDir, f);
                return this.readJsonFile(taskPath, TrackerTaskSchema);
            }));
            return tasks.filter((t) => t !== null);
        }
        catch (error) {
            if (error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }
    /**
     * Updates an existing task and saves it to disk.
     */
    async updateTask(id, updates) {
        const isClosing = updates.status === TaskStatus.CLOSED;
        const changingDependencies = updates.dependencies !== undefined;
        let taskMap;
        if (isClosing || changingDependencies) {
            const allTasks = await this.listTasks();
            taskMap = new Map(allTasks.map((t) => [t.id, t]));
        }
        const task = taskMap ? taskMap.get(id) : await this.getTask(id);
        if (!task) {
            throw new Error(`Task with ID ${id} not found.`);
        }
        const updatedTask = { ...task, ...updates, id: task.id };
        if (updatedTask.parentId) {
            const parentExists = taskMap
                ? taskMap.has(updatedTask.parentId)
                : !!(await this.getTask(updatedTask.parentId));
            if (!parentExists) {
                throw new Error(`Parent task with ID ${updatedTask.parentId} not found.`);
            }
        }
        if (taskMap) {
            if (isClosing && task.status !== TaskStatus.CLOSED) {
                this.validateCanClose(updatedTask, taskMap);
            }
            if (changingDependencies) {
                taskMap.set(updatedTask.id, updatedTask);
                this.validateNoCircularDependencies(updatedTask, taskMap);
            }
        }
        TrackerTaskSchema.parse(updatedTask);
        await this.saveTask(updatedTask);
        return updatedTask;
    }
    /**
     * Saves a task to disk.
     */
    async saveTask(task) {
        const taskPath = path.join(this.tasksDir, `${task.id}.json`);
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), 'utf8');
    }
    /**
     * Validates that a task can be closed (all dependencies must be closed).
     */
    validateCanClose(task, taskMap) {
        for (const depId of task.dependencies) {
            const dep = taskMap.get(depId);
            if (!dep) {
                throw new Error(`Dependency ${depId} not found for task ${task.id}.`);
            }
            if (dep.status !== TaskStatus.CLOSED) {
                throw new Error(`Cannot close task ${task.id} because dependency ${depId} is still ${dep.status}.`);
            }
        }
    }
    /**
     * Validates that there are no circular dependencies.
     */
    validateNoCircularDependencies(task, taskMap) {
        const visited = new Set();
        const stack = new Set();
        const check = (currentId) => {
            if (stack.has(currentId)) {
                throw new Error(`Circular dependency detected involving task ${currentId}.`);
            }
            if (visited.has(currentId)) {
                return;
            }
            visited.add(currentId);
            stack.add(currentId);
            const currentTask = taskMap.get(currentId);
            if (!currentTask) {
                throw new Error(`Dependency ${currentId} not found.`);
            }
            for (const depId of currentTask.dependencies) {
                check(depId);
            }
            stack.delete(currentId);
        };
        check(task.id);
    }
}
//# sourceMappingURL=trackerService.js.map