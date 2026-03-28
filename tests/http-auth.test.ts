import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PROXMOX_MCP_SCOPES,
  OidcJwtVerifier,
  parseProxmoxMcpScopes,
  scopeRequirementForAccessLevel,
} from "../src/http-auth.js";

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(privateKey: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

describe("http auth", () => {
  it("parses oauth scopes into proxmox capability scopes", () => {
    expect(parseProxmoxMcpScopes("proxmox.read proxmox.escape unknown proxmox.read")).toEqual(["proxmox.read", "proxmox.escape"]);
    expect(parseProxmoxMcpScopes(["proxmox.mutate", "proxmox.admin", "bad", "proxmox.mutate"])).toEqual(["proxmox.mutate", "proxmox.admin"]);
    expect(scopeRequirementForAccessLevel("escape")).toBe("proxmox.escape");
    expect(PROXMOX_MCP_SCOPES).toContain("proxmox.admin");
  });

  it("validates a jwt against oidc discovery and jwks", async () => {
    const issuer = new URL("https://issuer.example");
    const jwksUri = new URL("https://issuer.example/jwks");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey & { kid?: string; alg?: string; use?: string };
    publicJwk.kid = "k1";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    const fetchJson = vi.fn(async (url: URL) => {
      if (url.href === "https://issuer.example/.well-known/openid-configuration") {
        return new Response(JSON.stringify({ jwks_uri: jwksUri.href }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.href === jwksUri.href) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url.href}`);
    });

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      privateKey,
      { alg: "RS256", typ: "JWT", kid: "k1" },
      {
        iss: issuer.href,
        aud: "proxmox-mcp",
        sub: "client-123",
        exp: now + 300,
        nbf: now - 30,
        scope: "proxmox.read proxmox.escape",
      },
    );

    const verifier = new OidcJwtVerifier({
      issuer,
      audience: "proxmox-mcp",
      requiredScopes: ["proxmox.read"],
      fetchJson,
    });

    const auth = await verifier.verifyToken(token);

    expect(auth.clientId).toBe("client-123");
    expect(auth.scopes).toEqual(["proxmox.read", "proxmox.escape"]);
    expect(auth.expiresAt).toBe(now + 300);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("rejects a token without the required scope", async () => {
    const issuer = new URL("https://issuer.example");
    const jwksUri = new URL("https://issuer.example/jwks");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey & { kid?: string; alg?: string; use?: string };
    publicJwk.kid = "k1";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    const fetchJson = vi.fn(async (url: URL) => {
      if (url.href === "https://issuer.example/.well-known/openid-configuration") {
        return new Response(JSON.stringify({ jwks_uri: jwksUri.href }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.href === jwksUri.href) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url.href}`);
    });

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      privateKey,
      { alg: "RS256", typ: "JWT", kid: "k1" },
      {
        iss: issuer.href,
        aud: "proxmox-mcp",
        sub: "client-123",
        exp: now + 300,
        nbf: now - 30,
        scope: "proxmox.read",
      },
    );

    const verifier = new OidcJwtVerifier({
      issuer,
      audience: "proxmox-mcp",
      requiredScopes: ["proxmox.escape"],
      fetchJson,
    });

    await expect(verifier.verifyToken(token)).rejects.toThrow(/missing required scope/i);
  });
});
