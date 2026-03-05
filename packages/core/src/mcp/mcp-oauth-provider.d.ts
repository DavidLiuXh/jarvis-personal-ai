/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformation, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
/**
 * OAuth authorization response.
 */
export interface OAuthAuthorizationResponse {
    code: string;
    state: string;
}
type CallbackServer = {
    port: Promise<number>;
    waitForResponse: () => Promise<OAuthAuthorizationResponse>;
    close: () => Promise<void>;
};
export declare class MCPOAuthClientProvider implements OAuthClientProvider {
    private readonly _redirectUrl;
    private readonly _clientMetadata;
    private readonly _state?;
    private readonly _onRedirect;
    private _clientInformation?;
    private _tokens?;
    private _codeVerifier?;
    private _cbServer?;
    constructor(_redirectUrl: string | URL, _clientMetadata: OAuthClientMetadata, _state?: string | undefined, _onRedirect?: (url: URL) => void);
    get redirectUrl(): string | URL;
    get clientMetadata(): OAuthClientMetadata;
    saveCallbackServer(server: CallbackServer): void;
    getSavedCallbackServer(): CallbackServer | undefined;
    clientInformation(): OAuthClientInformation | undefined;
    saveClientInformation(clientInformation: OAuthClientInformation): void;
    tokens(): OAuthTokens | undefined;
    saveTokens(tokens: OAuthTokens): void;
    redirectToAuthorization(authorizationUrl: URL): Promise<void>;
    saveCodeVerifier(codeVerifier: string): void;
    codeVerifier(): string;
    state(): string;
}
export {};
