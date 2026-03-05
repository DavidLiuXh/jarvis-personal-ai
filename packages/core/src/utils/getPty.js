/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export const getPty = async () => {
    if (process.env['GEMINI_PTY_INFO'] === 'child_process') {
        return null;
    }
    try {
        const lydell = '@lydell/node-pty';
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const module = await import(lydell);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        return { module, name: 'lydell-node-pty' };
    }
    catch (_e) {
        try {
            const nodePty = 'node-pty';
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const module = await import(nodePty);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            return { module, name: 'node-pty' };
        }
        catch (_e2) {
            return null;
        }
    }
};
//# sourceMappingURL=getPty.js.map