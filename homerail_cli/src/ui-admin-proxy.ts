const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface UiMutationRequestTrust {
  protocol: "http" | "https";
  host: string | string[] | undefined;
  origin: string | string[] | undefined;
  secFetchSite?: string | string[];
}

export function isProtectedApiMutation(methodValue: string | undefined, urlValue: string | undefined): boolean {
  const method = (methodValue || "GET").toUpperCase();
  if (!MUTATION_METHODS.has(method)) return false;
  try {
    const pathname = new URL(urlValue || "/", "http://localhost").pathname;
    return pathname === "/api" || pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * Canonical exact HTTP(S) Origin normalization shared by the Manager admin
 * Origin allowlist and the static UI mutation proxy. Accepts only `http:` or
 * `https:` URLs without wildcard hosts, username, password, path other than
 * `/`, query, or fragment, and returns the canonical serialized Origin
 * (lowercased scheme/host, default ports omitted). Returns `undefined` for
 * anything else so every caller fails closed on the same rule.
 */
export function normalizeExactHttpOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.hostname.includes("*")) return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
  return parsed.origin;
}

/**
 * Keep the UI proxy zero-config by deriving its self Origin from the request
 * that reached the server. When the operator explicitly configures the public
 * UI URL (`--ui-public-url` / `HOMERAIL_UI_PUBLIC_URL`), its exact canonical
 * Origin is additionally accepted so reverse proxies that rewrite the Host
 * header keep working; the request-derived self Origin remains accepted for
 * direct local/LAN access. Manager performs the canonical authorization after
 * this hop; this check only rejects obvious browser cross-origin mutations.
 * `Forwarded`/`X-Forwarded-*` headers are never consulted here.
 */
export function authorizeUiAdminProxyMutation(
  request: UiMutationRequestTrust,
  configuredPublicOrigin?: string,
): { allowed: true } | { allowed: false; reason: string } {
  const host = singleHeader(request.host);
  const origin = singleHeader(request.origin);
  if (!host || !origin) {
    return { allowed: false, reason: "UI mutation Origin is required" };
  }

  let selfOrigin: string;
  try {
    selfOrigin = new URL(`${request.protocol}://${host}`).origin;
  } catch {
    return { allowed: false, reason: "UI request Host is invalid" };
  }

  const requestOrigin = normalizeExactHttpOrigin(origin);
  if (!requestOrigin) {
    return { allowed: false, reason: "UI mutation Origin is invalid" };
  }
  const publicOrigin = configuredPublicOrigin
    ? normalizeExactHttpOrigin(configuredPublicOrigin)
    : undefined;
  if (requestOrigin !== selfOrigin && requestOrigin !== publicOrigin) {
    return { allowed: false, reason: "Cross-origin UI mutation requests are forbidden" };
  }

  const secFetchSite = singleHeader(request.secFetchSite)?.toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== "same-origin") {
    return { allowed: false, reason: "Cross-origin UI mutation requests are forbidden" };
  }
  return { allowed: true };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) return undefined;
  return value;
}
