/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {} from '@google/genai';
export var MessageBusType;
(function (MessageBusType) {
    MessageBusType["TOOL_CONFIRMATION_REQUEST"] = "tool-confirmation-request";
    MessageBusType["TOOL_CONFIRMATION_RESPONSE"] = "tool-confirmation-response";
    MessageBusType["TOOL_POLICY_REJECTION"] = "tool-policy-rejection";
    MessageBusType["TOOL_EXECUTION_SUCCESS"] = "tool-execution-success";
    MessageBusType["TOOL_EXECUTION_FAILURE"] = "tool-execution-failure";
    MessageBusType["UPDATE_POLICY"] = "update-policy";
    MessageBusType["TOOL_CALLS_UPDATE"] = "tool-calls-update";
    MessageBusType["ASK_USER_REQUEST"] = "ask-user-request";
    MessageBusType["ASK_USER_RESPONSE"] = "ask-user-response";
})(MessageBusType || (MessageBusType = {}));
export var QuestionType;
(function (QuestionType) {
    QuestionType["CHOICE"] = "choice";
    QuestionType["TEXT"] = "text";
    QuestionType["YESNO"] = "yesno";
})(QuestionType || (QuestionType = {}));
//# sourceMappingURL=types.js.map