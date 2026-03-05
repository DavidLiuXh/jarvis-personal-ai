/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { debugLogger } from '../utils/debugLogger.js';
export class MCPOAuthClientProvider {
    _redirectUrl;
    _clientMetadata;
    _state;
    _onRedirect;
    _clientInformation;
    _tokens;
    _codeVerifier;
    _cbServer;
    constructor(_redirectUrl, _clientMetadata, _state, _onRedirect = (url) => {
        debugLogger.log(`Redirect to: ${url.toString()}`);
    }) {
        this._redirectUrl = _redirectUrl;
        this._clientMetadata = _clientMetadata;
        this._state = _state;
        this._onRedirect = _onRedirect;
    }
    get redirectUrl() {
        return this._redirectUrl;
    }
    get clientMetadata() {
        return this._clientMetadata;
    }
    saveCallbackServer(server) {
        this._cbServer = server;
    }
    getSavedCallbackServer() {
        return this._cbServer;
    }
    clientInformation() {
        return this._clientInformation;
    }
    saveClientInformation(clientInformation) {
        this._clientInformation = clientInformation;
    }
    tokens() {
        return this._tokens;
    }
    saveTokens(tokens) {
        this._tokens = tokens;
    }
    async redirectToAuthorization(authorizationUrl) {
        this._onRedirect(authorizationUrl);
    }
    saveCodeVerifier(codeVerifier) {
        this._codeVerifier = codeVerifier;
    }
    codeVerifier() {
        if (!this._codeVerifier) {
            throw new Error('No code verifier saved');
        }
        return this._codeVerifier;
    }
    state() {
        if (!this._state) {
            throw new Error('No code state saved');
        }
        return this._state;
    }
}
//# sourceMappingURL=mcp-oauth-provider.js.map