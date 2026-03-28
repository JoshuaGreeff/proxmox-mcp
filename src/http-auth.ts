import { webcrypto } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export const PROXMOX_MCP_SCOPES = ["proxmox.read", "proxmox.mutate", "proxmox.escape", "proxmox.admin"] as const;

export type ProxmoxMcpScope = (typeof PROXMOX_MCP_SCOPES)[number];

export interface OidcJwtVerifierOptions {
  issuer: string | URL;
  audience: string;
  jwksUri?: string | URL;
  resourceServerUrl?: string | URL;
  requiredScopes?: readonly ProxmoxMcpScope[];
  clockSkewSeconds?: number;
  cacheTtlMs?: number;
  fetchJson?: (url: URL, init?: RequestInit) => Promise<Response>;
}

export interface BearerAuthFailure {
  statusCode: 401 | 403;
  code: "invalid_token" | "insufficient_scope";
  description: string;
  scope?: string;
}

export interface VerifiedBearerToken extends AuthInfo {
  claims: Record<string, unknown>;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwkSet {
  keys: JsonWebKey[];
}

interface CachedJwks {
  fetchedAt: number;
  jwks: JwkSet;
}

const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

function toUrl(value: string | URL): URL {
  return value instanceof URL ? value : new URL(value);
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function parseJsonSegment<T>(segment: string): T {
  return JSON.parse(decodeBase64Url(segment).toString("utf8")) as T;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function normalizeScopeTokens(values: string[]): ProxmoxMcpScope[] {
  const known = new Set<string>(PROXMOX_MCP_SCOPES);
  return uniqueStrings(values).filter((scope): scope is ProxmoxMcpScope => known.has(scope));
}

/**
 * Parses OAuth scope claims from the common string and array encodings.
 *
 * Unknown scopes are ignored so the caller can feed the result directly into
 * the Proxmox MCP capability checks.
 */
export function parseProxmoxMcpScopes(value: unknown): ProxmoxMcpScope[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return normalizeScopeTokens(value.flatMap((entry) => (typeof entry === "string" ? entry.split(/[,\s]+/) : [])));
  }

  if (typeof value === "string") {
    return normalizeScopeTokens(value.split(/[,\s]+/));
  }

  return [];
}

export function hasRequiredScopes(scopes: readonly string[], required: readonly ProxmoxMcpScope[]): boolean {
  const scopeSet = new Set(scopes);
  return required.every((scope) => scopeSet.has(scope));
}

export function scopeRequirementForAccessLevel(accessLevel: "read" | "mutate" | "escape"): ProxmoxMcpScope {
  switch (accessLevel) {
    case "read":
      return "proxmox.read";
    case "mutate":
      return "proxmox.mutate";
    case "escape":
      return "proxmox.escape";
  }
}

function resolveWellKnownUrl(base: URL, leaf: string): URL {
  const pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return new URL(`${pathname}${leaf}`, base.origin);
}

function getJwtSigningAlgorithm(jwk: JsonWebKey, alg: string): RsaHashedImportParams | EcKeyImportParams {
  const jwkKid = (jwk as JsonWebKey & { kid?: string }).kid;
  if (alg === "RS256") {
    return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  }

  if (alg === "PS256") {
    return { name: "RSA-PSS", hash: "SHA-256" };
  }

  if (alg === "ES256") {
    return { name: "ECDSA", namedCurve: "P-256" };
  }

  if (alg === "ES384") {
    return { name: "ECDSA", namedCurve: "P-384" };
  }

  if (alg === "ES512") {
    return { name: "ECDSA", namedCurve: "P-521" };
  }

  throw new Error(`Unsupported JWT algorithm '${alg}' for JWK ${jwkKid ?? "<no kid>"}`);
}

function getJwtVerifyAlgorithm(alg: string): AlgorithmIdentifier | EcKeyAlgorithm | RsaPssParams | RsaHashedImportParams {
  if (alg === "RS256") {
    return { name: "RSASSA-PKCS1-v1_5" };
  }

  if (alg === "PS256") {
    return { name: "RSA-PSS", saltLength: 32 };
  }

  if (alg === "ES256") {
    return { name: "ECDSA", hash: "SHA-256" };
  }

  if (alg === "ES384") {
    return { name: "ECDSA", hash: "SHA-384" };
  }

  if (alg === "ES512") {
    return { name: "ECDSA", hash: "SHA-512" };
  }

  throw new Error(`Unsupported JWT algorithm '${alg}'`);
}

class JwksCache {
  private cached?: CachedJwks;

  constructor(
    private readonly options: Pick<OidcJwtVerifierOptions, "issuer" | "jwksUri" | "fetchJson" | "cacheTtlMs">,
  ) {}

  private async fetchJson(url: URL): Promise<unknown> {
    const fetcher = this.options.fetchJson ?? ((input: URL, init?: RequestInit) => fetch(input, init));
    const response = await fetcher(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url.href}: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<unknown>;
  }

  private async resolveJwksUri(): Promise<URL> {
    if (this.options.jwksUri) {
      return toUrl(this.options.jwksUri);
    }

    const issuer = toUrl(this.options.issuer);
    const discoveryUrl = resolveWellKnownUrl(issuer, ".well-known/openid-configuration");
    const discovery = (await this.fetchJson(discoveryUrl)) as { jwks_uri?: string };
    if (!discovery.jwks_uri) {
      throw new Error(`OIDC discovery document at ${discoveryUrl.href} did not include jwks_uri`);
    }

    return new URL(discovery.jwks_uri);
  }

  async getJwks(): Promise<JwkSet> {
    const ttlMs = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (this.cached && Date.now() - this.cached.fetchedAt < ttlMs) {
      return this.cached.jwks;
    }

    const jwksUri = await this.resolveJwksUri();
    const jwks = (await this.fetchJson(jwksUri)) as JwkSet;
    if (!jwks || !Array.isArray(jwks.keys)) {
      throw new Error(`Invalid JWKS document at ${jwksUri.href}`);
    }

    this.cached = {
      fetchedAt: Date.now(),
      jwks,
    };
    return jwks;
  }
}

function selectCandidateKeys(jwks: JwkSet, header: JwtHeader): JsonWebKey[] {
  const candidates = jwks.keys.filter((key) => {
    const keyKid = (key as JsonWebKey & { kid?: string }).kid;
    if (key.use && key.use !== "sig") {
      return false;
    }

    if (header.kid && keyKid && keyKid !== header.kid) {
      return false;
    }

    return true;
  });

  if (candidates.length === 0 && header.kid) {
    return jwks.keys.filter((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  }

  return candidates;
}

async function importVerificationKey(jwk: JsonWebKey, alg: string) {
  const algorithm = getJwtSigningAlgorithm(jwk, alg);
  return webcrypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
}

function normalizeAudience(audience: unknown): string[] {
  if (typeof audience === "string") {
    return [audience];
  }

  if (Array.isArray(audience)) {
    return audience.filter((entry): entry is string => typeof entry === "string");
  }

  return [];
}

function validateClaims(
  claims: Record<string, unknown>,
  options: OidcJwtVerifierOptions,
): void {
  const issuer = toUrl(options.issuer).href;
  if (claims.iss !== issuer) {
    throw new Error(`JWT issuer '${String(claims.iss)}' does not match expected issuer '${issuer}'`);
  }

  const audiences = normalizeAudience(claims.aud);
  if (!audiences.includes(options.audience)) {
    throw new Error(`JWT audience '${audiences.join(", ")}' does not include expected audience '${options.audience}'`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const skewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;

  if (typeof claims.exp === "number" && nowSeconds - skewSeconds >= claims.exp) {
    throw new Error("JWT has expired");
  }

  if (typeof claims.nbf === "number" && nowSeconds + skewSeconds < claims.nbf) {
    throw new Error("JWT is not yet valid");
  }
}

export class OidcJwtVerifier {
  private readonly jwksCache: JwksCache;

  constructor(private readonly options: OidcJwtVerifierOptions) {
    this.jwksCache = new JwksCache(options);
  }

  async verifyToken(token: string): Promise<VerifiedBearerToken> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Bearer token is not a JWT");
    }

    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = parseJsonSegment<JwtHeader>(headerPart);
    if (!header.alg) {
      throw new Error("JWT header is missing alg");
    }

    const claims = parseJsonSegment<Record<string, unknown>>(payloadPart);
    validateClaims(claims, this.options);

    const jwks = await this.jwksCache.getJwks();
    const candidates = selectCandidateKeys(jwks, header);
    if (candidates.length === 0) {
      throw new Error("No matching JWK found for bearer token");
    }

    const encoded = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = new Uint8Array(decodeBase64Url(signaturePart));
    let verified = false;

    for (const jwk of candidates) {
      try {
        const key = await importVerificationKey(jwk, header.alg);
        verified = await webcrypto.subtle.verify(
          getJwtVerifyAlgorithm(header.alg),
          key,
          signature,
          encoded,
        );
      } catch {
        verified = false;
      }

      if (verified) {
        break;
      }
    }

    if (!verified) {
      throw new Error("Bearer token signature verification failed");
    }

    const scopes = parseProxmoxMcpScopes(claims.scope ?? claims.scp);
    if (this.options.requiredScopes && !hasRequiredScopes(scopes, this.options.requiredScopes)) {
      const missing = this.options.requiredScopes.filter((scope) => !scopes.includes(scope)).join(" ");
      throw new Error(`Bearer token is missing required scope(s): ${missing}`);
    }

    const resource = this.options.resourceServerUrl ? toUrl(this.options.resourceServerUrl) : undefined;
    const clientId = typeof claims.azp === "string" ? claims.azp : typeof claims.client_id === "string" ? claims.client_id : typeof claims.sub === "string" ? claims.sub : "unknown";

    return {
      token,
      clientId,
      scopes,
      expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
      resource,
      extra: claims,
      claims,
    };
  }
}

export function buildBearerChallenge(params: {
  resourceMetadataUrl?: URL;
  error: BearerAuthFailure["code"];
  description: string;
  scope?: string;
}): string {
  const parts = [`Bearer error="${params.error}"`, `error_description="${params.description.replace(/"/g, "'")}"`];
  if (params.scope) {
    parts.push(`scope="${params.scope}"`);
  }
  if (params.resourceMetadataUrl) {
    parts.push(`resource_metadata="${params.resourceMetadataUrl.href}"`);
  }
  return parts.join(", ");
}

export function createProtectedResourceMetadata(options: {
  resourceServerUrl: URL | string;
  issuerUrl: URL | string;
  scopesSupported?: readonly ProxmoxMcpScope[];
  resourceName?: string;
  resourceDocumentation?: URL | string;
}): Record<string, unknown> {
  const resourceServerUrl = toUrl(options.resourceServerUrl);
  const issuerUrl = toUrl(options.issuerUrl);

  return {
    resource: resourceServerUrl.href,
    authorization_servers: [issuerUrl],
    scopes_supported: options.scopesSupported ? [...options.scopesSupported] : [...PROXMOX_MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: options.resourceName,
    resource_documentation: options.resourceDocumentation ? toUrl(options.resourceDocumentation).href : undefined,
  };
}
