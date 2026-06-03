/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type RuntimeLogger = {
  debug(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

class ConsoleRuntimeLogger implements RuntimeLogger {
  debug(...args: unknown[]): void {
    if (process.env.JARVIS_DEBUG === "1") console.error(...args);
  }

  log(...args: unknown[]): void {
    console.log(...args);
  }

  warn(...args: unknown[]): void {
    console.warn(...args);
  }

  error(...args: unknown[]): void {
    console.error(...args);
  }
}

export const runtimeLogger: RuntimeLogger = new ConsoleRuntimeLogger();
