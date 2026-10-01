import * as client from "openid-client";
import type { AppConfig } from "../../shared/config/config.js";

type AuthService = {
  getConfig: () => Promise<client.Configuration>;
  buildLoginUrl: (codeChallenge: string, state: string, nonce: string) => Promise<URL>;
  exchangeCode: (
    callbackUrl: URL,
    codeVerifier: string,
    expectedState: string,
    expectedNonce: string,
  ) => Promise<TokenSet>;
  refreshToken: (refreshToken: string) => Promise<TokenSet>;
  buildLogoutUrl: (idToken?: string) => Promise<URL>;
  sanitizeReturnPath: (url: string | undefined | null) => string;
  buildClientRedirectUri: (clientBaseRedirectUri: string, returnPath: string) => string;
};

type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
};

let cachedConfig: client.Configuration | null = null;

// Client-side routes the browser may be sent back to after login. Keep this in
// sync with apps/web/src/routes/*. `/` is always allowed (see
// isAllowedDashboardPath); `/login` is deliberately absent — bouncing back to the
// sign-in page is never the right post-login destination. This is NOT the same
// thing as PROXY_ALLOWED_PREFIXES, which gates upstream API paths.
//
// One prefix per top-level route segment the web app actually serves, not one per
// page: `/report` covers /report/machine/by-shift and its siblings, and
// `/oee-performance` covers /oee-performance/machine/monthly. Add a prefix only
// once its routes exist — an entry for a route that does not exist is an
// open-redirect target with nothing to redirect to.
//
// `/oee-performance` WAS deliberately absent while that nav group was a greyed
// placeholder. The OEE Performance dashboard's first screen shipped, so it is here
// now — and the failure it prevents is silent: without the prefix, signing in from
// a deep link to the dashboard lands the operator on `/` with nothing to say why.
// Exported so the tests can derive their cases from it rather than hard-coding
// a route: the allow-path coverage reactivates by itself as prefixes are added,
// instead of quietly staying skipped.
const ALLOWED_PREFIXES: readonly string[] = ["/report", "/oee-performance"];

const DEFAULT_RETURN_PATH = "/";

function createAuthService(appConfig: AppConfig): AuthService {
  async function getConfig(): Promise<client.Configuration> {
    if (cachedConfig) return cachedConfig;

    const serverUrl = new URL(appConfig.oidc.baseUri);
    const config = await client.discovery(
      serverUrl,
      appConfig.oidc.clientId,
      appConfig.oidc.clientSecret,
      undefined,
      {
        execute: [client.allowInsecureRequests],
      },
    );

    cachedConfig = config;
    return config;
  }

  async function buildLoginUrl(codeChallenge: string, state: string, nonce: string): Promise<URL> {
    const config = await getConfig();
    return client.buildAuthorizationUrl(config, {
      redirect_uri: appConfig.oidc.redirectUri,
      scope: appConfig.oidc.scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
  }

  async function exchangeCode(
    callbackUrl: URL,
    codeVerifier: string,
    expectedState: string,
    expectedNonce: string,
  ): Promise<TokenSet> {
    const config = await getConfig();
    const tokenResponse = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState,
      expectedNonce,
    });

    return {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      idToken: tokenResponse.id_token,
    };
  }

  async function refreshToken(refreshTokenValue: string): Promise<TokenSet> {
    const config = await getConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshTokenValue);

    return {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      idToken: tokenResponse.id_token,
    };
  }

  async function buildLogoutUrl(idToken?: string): Promise<URL> {
    const config = await getConfig();
    const params: Record<string, string> = {
      post_logout_redirect_uri: appConfig.clientBaseRedirectUri,
    };
    if (idToken) {
      params.id_token_hint = idToken;
    }
    return client.buildEndSessionUrl(config, params);
  }

  function decodePath(raw: string): string {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function hasForbiddenSegments(path: string): boolean {
    if (!path.startsWith("/")) {
      return true;
    }
    if (path.startsWith("//")) {
      return true;
    }
    if (path.includes(":")) {
      return true;
    }
    if (/%2f/i.test(path) || /%5c/i.test(path)) {
      return true;
    }

    const segments = path.split("/");
    return segments.some((segment) => segment === "..");
  }

  function isAllowedDashboardPath(path: string): boolean {
    if (path === "/") {
      return true;
    }
    return ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  function sanitizeReturnPath(raw: string | undefined | null): string {
    if (!raw || typeof raw !== "string") {
      return DEFAULT_RETURN_PATH;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return DEFAULT_RETURN_PATH;
    }

    const path = decodePath(trimmed.split("?")[0]?.split("#")[0] ?? trimmed);

    if (hasForbiddenSegments(path)) {
      return DEFAULT_RETURN_PATH;
    }

    if (!isAllowedDashboardPath(path)) {
      return DEFAULT_RETURN_PATH;
    }

    return path;
  }

  function buildClientRedirectUri(clientBaseRedirectUri: string, returnPath: string): string {
    const base = clientBaseRedirectUri.replace(/\/$/, "");
    const safePath = sanitizeReturnPath(returnPath);
    if (safePath === "/") {
      return base;
    }
    return `${base}${safePath}`;
  }

  return {
    getConfig,
    buildLoginUrl,
    exchangeCode,
    refreshToken,
    buildLogoutUrl,
    buildClientRedirectUri,
    sanitizeReturnPath,
  };
}

function resetCachedConfig(): void {
  cachedConfig = null;
}

export { createAuthService, resetCachedConfig, ALLOWED_PREFIXES };
export type { AuthService, TokenSet };
