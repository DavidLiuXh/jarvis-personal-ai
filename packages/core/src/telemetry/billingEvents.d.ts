/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { LogAttributes } from '@opentelemetry/api-logs';
import type { BaseTelemetryEvent } from './types.js';
import type { OverageStrategy } from '../billing/billing.js';
/** Overage menu option that can be selected by the user */
export type OverageOption = 'use_credits' | 'use_fallback' | 'manage' | 'stop' | 'get_credits';
export declare const EVENT_OVERAGE_MENU_SHOWN = "gemini_cli.overage_menu_shown";
export declare class OverageMenuShownEvent implements BaseTelemetryEvent {
    'event.name': 'overage_menu_shown';
    'event.timestamp': string;
    model: string;
    credit_balance: number;
    overage_strategy: OverageStrategy;
    constructor(model: string, creditBalance: number, overageStrategy: OverageStrategy);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_OVERAGE_OPTION_SELECTED = "gemini_cli.overage_option_selected";
export declare class OverageOptionSelectedEvent implements BaseTelemetryEvent {
    'event.name': 'overage_option_selected';
    'event.timestamp': string;
    model: string;
    selected_option: OverageOption;
    credit_balance: number;
    constructor(model: string, selectedOption: OverageOption, creditBalance: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_EMPTY_WALLET_MENU_SHOWN = "gemini_cli.empty_wallet_menu_shown";
export declare class EmptyWalletMenuShownEvent implements BaseTelemetryEvent {
    'event.name': 'empty_wallet_menu_shown';
    'event.timestamp': string;
    model: string;
    constructor(model: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CREDIT_PURCHASE_CLICK = "gemini_cli.credit_purchase_click";
export declare class CreditPurchaseClickEvent implements BaseTelemetryEvent {
    'event.name': 'credit_purchase_click';
    'event.timestamp': string;
    source: 'overage_menu' | 'empty_wallet_menu' | 'manage';
    model: string;
    constructor(source: 'overage_menu' | 'empty_wallet_menu' | 'manage', model: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CREDITS_USED = "gemini_cli.credits_used";
export declare class CreditsUsedEvent implements BaseTelemetryEvent {
    'event.name': 'credits_used';
    'event.timestamp': string;
    model: string;
    credits_consumed: number;
    credits_remaining: number;
    constructor(model: string, creditsConsumed: number, creditsRemaining: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_API_KEY_UPDATED = "gemini_cli.api_key_updated";
export declare class ApiKeyUpdatedEvent implements BaseTelemetryEvent {
    'event.name': 'api_key_updated';
    'event.timestamp': string;
    previous_auth_type: string;
    new_auth_type: string;
    constructor(previousAuthType: string, newAuthType: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
/** Union type of all billing-related telemetry events */
export type BillingTelemetryEvent = OverageMenuShownEvent | OverageOptionSelectedEvent | EmptyWalletMenuShownEvent | CreditPurchaseClickEvent | CreditsUsedEvent | ApiKeyUpdatedEvent;
