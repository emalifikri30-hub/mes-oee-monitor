type AppConfig = {
  oidc: {
    clientId: string;
    clientSecret: string;
    baseUri: string;
    redirectUri: string;
    scope: string;
  };
  cookie: {
    name: string;
    secret: string;
    domain?: string;
    sameSite: CookieSameSite;
    secure: boolean;
  };
  clientBaseRedirectUri: string;
  cors: {
    allowedOrigins: string[];
  };
  coreApi: {
    baseUrl: string;
  };
  proxy: {
    allowedPrefixes: string[];
    upstreamTimeoutMs: number;
  };
  region: string;
};

const REQUIRED_VARS = [
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_BASE_URI",
  "OIDC_REDIRECT_URI",
  "OIDC_CLIENT_SCOPE",
  "COOKIE_NAME",
  "COOKIE_SECRET",
  "CLIENT_BASE_REDIRECT_URI",
  "CORE_API_BASE_URL",
  "PROXY_ALLOWED_PREFIXES",
  "REGION_CODE",
] as const;

const DEFAULT_PROXY_UPSTREAM_TIMEOUT_MS = 30_000;

const COOKIE_SAME_SITE_VALUES = ["lax", "strict", "none"] as const;
type CookieSameSite = (typeof COOKIE_SAME_SITE_VALUES)[number];

function isCookieSameSite(value: string): value is CookieSameSite {
  return (COOKIE_SAME_SITE_VALUES as readonly string[]).includes(value);
}

function parseCookieSameSite(raw: string | undefined): CookieSameSite {
  if (raw === undefined || raw === "") return "lax";
  const value = raw.trim().toLowerCase();
  if (!isCookieSameSite(value)) {
    throw new Error(
      `COOKIE_SAMESITE must be one of ${COOKIE_SAME_SITE_VALUES.join(", ")}: got "${raw}"`,
    );
  }
  return value;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false: got "${raw}"`);
}

// A cookie Domain widens the cookie from host-only to the domain and all of its
// subdomains — that is what lets the SPA's origin and the BFF's origin share one
// session. It must be a bare host that contains a dot: the browser rejects a
// Domain of "localhost" or a bare IP, and it must cover the BFF's own host.
function parseCookieDomain(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = raw.trim();
  if (/[:/\\\s]/.test(value)) {
    throw new Error(
      `COOKIE_DOMAIN must be a bare host without scheme, port or path: got "${value}"`,
    );
  }
  if (!value.replace(/^\./, "").includes(".")) {
    throw new Error(
      `COOKIE_DOMAIN must be a dotted domain the browser will accept: got "${value}"`,
    );
  }
  return value;
}

function parseHttpsUrl(name: string, raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL: got "${raw}"`);
  }
}

function parseListUrl(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseCorsUrl(raw?: string): string[] {
  const corsUrls = parseListUrl(raw ?? "");
  const allowedOrigins = corsUrls.length === 0 ? ["http://localhost:3000"] : corsUrls;
  return allowedOrigins;
}

function parsePrefixes(raw: string): string[] {
  const prefixes = parseListUrl(raw);
  if (prefixes.length === 0) {
    throw new Error("PROXY_ALLOWED_PREFIXES must contain at least one prefix");
  }
  for (const p of prefixes) {
    if (!p.startsWith("/")) {
      throw new Error(`PROXY_ALLOWED_PREFIXES entries must start with '/': got "${p}"`);
    }
  }
  return prefixes;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PROXY_UPSTREAM_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`PROXY_UPSTREAM_TIMEOUT_MS must be a positive number: got "${raw}"`);
  }
  return Math.floor(n);
}

function loadConfig(): AppConfig {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const clientBaseRedirect = parseHttpsUrl(
    "CLIENT_BASE_REDIRECT_URI",
    process.env.CLIENT_BASE_REDIRECT_URI!,
  );
  const sameSite = parseCookieSameSite(process.env.COOKIE_SAMESITE);
  const secure = parseBoolean(
    "COOKIE_SECURE",
    process.env.COOKIE_SECURE,
    clientBaseRedirect.protocol === "https:",
  );

  // Browsers silently drop SameSite=None without Secure, which would log every
  // user out with no error anywhere. Fail at boot instead.
  if (sameSite === "none" && !secure) {
    throw new Error(
      "COOKIE_SAMESITE=none requires secure cookies: serve CLIENT_BASE_REDIRECT_URI over https or set COOKIE_SECURE=true",
    );
  }

  return {
    oidc: {
      clientId: process.env.OIDC_CLIENT_ID!,
      clientSecret: process.env.OIDC_CLIENT_SECRET!,
      baseUri: process.env.OIDC_BASE_URI!,
      redirectUri: process.env.OIDC_REDIRECT_URI!,
      scope: process.env.OIDC_CLIENT_SCOPE!,
    },
    cookie: {
      name: process.env.COOKIE_NAME!,
      secret: process.env.COOKIE_SECRET!,
      domain: parseCookieDomain(process.env.COOKIE_DOMAIN),
      sameSite,
      secure,
    },
    clientBaseRedirectUri: process.env.CLIENT_BASE_REDIRECT_URI!,
    cors: {
      allowedOrigins: parseCorsUrl(process.env.CORS_ALLOWED_ORIGINS),
    },
    coreApi: {
      baseUrl: process.env.CORE_API_BASE_URL!.replace(/\/+$/, ""),
    },
    proxy: {
      allowedPrefixes: parsePrefixes(process.env.PROXY_ALLOWED_PREFIXES!),
      upstreamTimeoutMs: parseTimeout(process.env.PROXY_UPSTREAM_TIMEOUT_MS),
    },
    region: process.env.REGION_CODE!,
  };
}

export { loadConfig };
export type { AppConfig, CookieSameSite };
