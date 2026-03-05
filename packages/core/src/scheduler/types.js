/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {} from '../policy/types.js';
export const ROOT_SCHEDULER_ID = 'root';
/**
 * Internal core statuses for the tool call state machine.
 */
export var CoreToolCallStatus;
(function (CoreToolCallStatus) {
    CoreToolCallStatus["Validating"] = "validating";
    CoreToolCallStatus["Scheduled"] = "scheduled";
    CoreToolCallStatus["Error"] = "error";
    CoreToolCallStatus["Success"] = "success";
    CoreToolCallStatus["Executing"] = "executing";
    CoreToolCallStatus["Cancelled"] = "cancelled";
    CoreToolCallStatus["AwaitingApproval"] = "awaiting_approval";
})(CoreToolCallStatus || (CoreToolCallStatus = {}));
//# sourceMappingURL=types.js.map