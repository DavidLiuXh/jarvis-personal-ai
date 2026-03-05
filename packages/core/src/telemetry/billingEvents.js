/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getCommonAttributes } from './telemetryAttributes.js';
// ============================================================================
// Event: Overage Menu Shown
// ============================================================================
export const EVENT_OVERAGE_MENU_SHOWN = 'gemini_cli.overage_menu_shown';
export class OverageMenuShownEvent {
    'event.name';
    'event.timestamp';
    model;
    credit_balance;
    overage_strategy;
    constructor(model, creditBalance, overageStrategy) {
        this['event.name'] = 'overage_menu_shown';
        this['event.timestamp'] = new Date().toISOString();
        this.model = model;
        this.credit_balance = creditBalance;
        this.overage_strategy = overageStrategy;
    }
    toOpenTelemetryAttributes(config) {
        return {
            ...getCommonAttributes(config),
            'event.name': EVENT_OVERAGE_MENU_SHOWN,
            'event.timestamp': this['event.timestamp'],
            model: this.model,
            credit_balance: this.credit_balance,
            overage_strategy: this.overage_strategy,
        };
    }
    toLogBody() {
        return `Overage menu shown for model ${this.model} with ${this.credit_balance} credits available.`;
    }
}
// ============================================================================
// Event: Overage Option Selected
// ============================================================================
export const EVENT_OVERAGE_OPTION_SELECTED = 'gemini_cli.overage_option_selected';
export class OverageOptionSelectedEvent {
    'event.name';
    'event.timestamp';
    model;
    selected_option;
    credit_balance;
    constructor(model, selectedOption, creditBalance) {
        this['event.name'] = 'overage_option_selected';
        this['event.timestamp'] = new Date().toISOString();
        this.model = model;
        this.selected_option = selectedOption;
        this.credit_balance = creditBalance;
    }
    toOpenTelemetryAttributes(config) {
        return {
            ...getCommonAttributes(config),
            'event.name': EVENT_OVERAGE_OPTION_SELECTED,
            'event.timestamp': this['event.timestamp'],
            model: this.model,
            selected_option: this.selected_option,
            credit_balance: this.credit_balance,
        };
    }
    toLogBody() {
        return `Overage option '${this.selected_option}' selected for model ${this.model}.`;
    }
}
// ============================================================================
// Event: Empty Wallet Menu Shown
// ============================================================================
export const EVENT_EMPTY_WALLET_MENU_SHOWN = 'gemini_cli.empty_wallet_menu_shown';
export class EmptyWalletMenuShownEvent {
    'event.name';
    'event.timestamp';
    model;
    constructor(model) {
        this['event.name'] = 'empty_wallet_menu_shown';
        this['event.timestamp'] = new Date().toISOString();
        this.model = model;
    }
    toOpenTelemetryAttributes(config) {
        return {
            ...getCommonAttributes(config),
            'event.name': EVENT_EMPTY_WALLET_MENU_SHOWN,
            'event.timestamp': this['event.timestamp'],
            model: this.model,
        };
    }
    toLogBody() {
        return `Empty wallet menu shown for model ${this.model}.`;
    }
}
// ============================================================================
// Event: Credit Purchase Click
// ============================================================================
export const EVENT_CREDIT_PURCHASE_CLICK = 'gemini_cli.credit_purchase_click';
export class CreditPurchaseClickEvent {
    'event.name';
    'event.timestamp';
    source;
    model;
    constructor(source, model) {
        this['event.name'] = 'credit_purchase_click';
        this['event.timestamp'] = new Date().toISOString();
        this.source = source;
        this.model = model;
    }
    toOpenTelemetryAttributes(config) {
        return {
            ...getCommonAttributes(config),
            'event.name': EVENT_CREDIT_PURCHASE_CLICK,
            'event.timestamp': this['event.timestamp'],
            source: this.source,
            model: this.model,
        };
    }
    toLogBody() {
        return `Credit purchase clicked from ${this.source} for model ${this.model}.`;
    }
}
// ============================================================================
// Event: Credits Used
// ============================================================================
export const EVENT_CREDITS_USED = 'gemini_cli.credits_used';
export class CreditsUsedEvent {
    'event.name';
    'event.timestamp';
    model;
    credits_consumed;
    credits_remaining;
    constructor(model, creditsConsumed, creditsRemaining) {
        this['event.name'] = 'credits_used';
        this['event.timestamp'] = new Date().toISOString();
        this.model = model;
        this.credits_consumed = creditsConsumed;
        this.credits_remaining = creditsRemaining;
    }
    toOpenTelemetryAttributes(config) {
        return {
            ...getCommonAttributes(config),
            'event.name': EVENT_CREDITS_USED,
            'event.timestamp': this['event.timestamp'],
            model: this.model,
            credits_consumed: this.credits_consumed,
            credits_remaining: this.credits_remaining,
        };
    }
    toLogBody() {
        return `${this.credits_consumed} credits consumed for model ${this.model}. ${this.credits_remaining} remaining.`;
    }
}
// ============================================================================
// Event: API Key Updated (Auth Type Changed)
// ============================================================================
export const EVENT_API_KEY_UPDATED = 'gemini_cli.api_key_updated';
export class ApiKeyUpdatedEvent {
    'event.name';
    'event.timestamp';
    previous_auth_type;
    new_auth_type;
    constructor(previousAuthType, newAuthType) {
        this['event.name'] = 'api_key_updated';
        this['event.timestamp'] = new Date().toISOString();
        this.previous_auth_type = previousAuthType;
        this.new_auth_type = newAuthType;
    }
    toOpenTelemetryAttributes(config) {
        return {
            ...getCommonAttributes(config),
            'event.name': EVENT_API_KEY_UPDATED,
            'event.timestamp': this['event.timestamp'],
            previous_auth_type: this.previous_auth_type,
            new_auth_type: this.new_auth_type,
        };
    }
    toLogBody() {
        return `Auth type changed from ${this.previous_auth_type} to ${this.new_auth_type}.`;
    }
}
//# sourceMappingURL=billingEvents.js.map