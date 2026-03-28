import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  buildBearerChallenge,
  createProtectedResourceMetadata,
  OidcJwtVerifier,
  type OidcJwtVerifierOptions,
  type ProxmoxMcpScope,
} from "./http-auth.js";

export interface ProxmoxMcpHttpServerOptions {
  server: McpServer;
  host?: string;
  port: number;
  path?: string;
  publicUrl?: string | URL;
  issuerUrl?: string | URL;
  resourceName?: string;
  resourceDocumentation?: string | URL;
  auth?: OidcHttpAuthOptions;
}

export interface OidcHttpAuthOptions extends OidcJwtVerifierOptions {
  requiredScopes?: readonly ProxmoxMcpScope[];
}

export interface ProxmoxMcpHttpServerHandle {
  server: Server;
  transport: StreamableHTTPServerTransport;
  url: URL;
  metadataUrl: URL;
  close(): Promise<void>;
}

function normalizePath(path: string): string {
  if (path.length === 0) {
    return "/";
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function getMetadataPath(mcpPath: string): string {
  const normalized = normalizePath(mcpPath);
  return `/.well-known/oauth-protected-resource${normalized === "/" ? "" : normalized}`;
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function resolveRequestResourceUrl(req: IncomingMessage, fallback: URL, path: string): URL {
  const forwardedProto = Array.isArray(req.headers["x-forwarded-proto"])
    ? req.headers["x-forwarded-proto"][0]
    : req.headers["x-forwarded-proto"];
  const forwardedHost = Array.isArray(req.headers["x-forwarded-host"])
    ? req.headers["x-forwarded-host"][0]
    : req.headers["x-forwarded-host"];
  const host = forwardedHost ?? req.headers.host ?? fallback.host;
  const protocol = (forwardedProto ?? fallback.protocol.replace(/:$/, "")) || "http";
  return new URL(`${protocol}://${host}${path}`);
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }

  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("application/json") || raw.startsWith("{") || raw.startsWith("[")) {
    return JSON.parse(raw) as unknown;
  }

  return raw;
}

function logHttpServerError(error: unknown): void {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function writeText(res: ServerResponse, statusCode: number, text: string, headers: Record<string, string> = {}): void {
  res.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

async function authenticateRequest(
  req: IncomingMessage,
  verifier: OidcJwtVerifier,
  requiredScopes: readonly ProxmoxMcpScope[] | undefined,
): Promise<AuthInfo> {
  const header = req.headers.authorization;
  if (!header || !/^Bearer\s+/i.test(header)) {
    throw {
      statusCode: 401 as const,
      code: "invalid_token" as const,
      description: "Missing bearer token",
    };
  }

  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token.length === 0) {
    throw {
      statusCode: 401 as const,
      code: "invalid_token" as const,
      description: "Missing bearer token",
    };
  }

  try {
    return await verifier.verifyToken(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/missing required scope/i.test(message)) {
      throw {
        statusCode: 403 as const,
        code: "insufficient_scope" as const,
        description: message,
        scope: requiredScopes?.join(" "),
      };
    }

    throw {
      statusCode: 401 as const,
      code: "invalid_token" as const,
      description: message,
    };
  }
}

/**
 * Creates an HTTP server with Streamable HTTP transport and optional OIDC bearer validation.
 *
 * The returned handle is ready to `listen()` or can be started through `startProxmoxMcpHttpServer`.
 */
export async function createProxmoxMcpHttpServer(options: ProxmoxMcpHttpServerOptions): Promise<ProxmoxMcpHttpServerHandle> {
  const path = normalizePath(options.path ?? "/mcp");
  const publicUrl = options.publicUrl instanceof URL ? options.publicUrl : options.publicUrl ? new URL(options.publicUrl) : new URL(`http://${options.host ?? "127.0.0.1"}:${options.port}${path}`);
  const metadataPath = getMetadataPath(path);
  const metadataUrl = new URL(metadataPath, publicUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const verifier = options.auth
    ? new OidcJwtVerifier({
        issuer: options.auth.issuer,
        audience: options.auth.audience,
        jwksUri: options.auth.jwksUri,
        resourceServerUrl: options.auth.resourceServerUrl ?? publicUrl,
        requiredScopes: options.auth.requiredScopes,
        clockSkewSeconds: options.auth.clockSkewSeconds,
        cacheTtlMs: options.auth.cacheTtlMs,
        fetchJson: options.auth.fetchJson,
      })
    : undefined;

  await options.server.connect(transport);

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = getRequestUrl(req);

      if (req.method === "GET" && requestUrl.pathname === metadataPath) {
        const resourceServerUrl = resolveRequestResourceUrl(req, publicUrl, path);
        writeJson(
          res,
          200,
          createProtectedResourceMetadata({
            resourceServerUrl,
            issuerUrl: options.auth?.issuer ?? publicUrl,
            scopesSupported: options.auth?.requiredScopes,
            resourceName: options.resourceName,
            resourceDocumentation: options.resourceDocumentation,
          }),
        );
        return;
      }

      if (requestUrl.pathname !== path) {
        writeText(res, 404, "Not Found");
        return;
      }

      if (options.auth) {
        const authInfo = await authenticateRequest(req, verifier!, options.auth.requiredScopes);
        (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
      }

      if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
        writeText(res, 405, "Method Not Allowed", { allow: "GET, POST, DELETE" });
        return;
      }

      const parsedBody = req.method === "GET" ? undefined : await readRequestBody(req);
      await transport.handleRequest(req as IncomingMessage & { auth?: AuthInfo }, res, parsedBody);
    } catch (error) {
      if (typeof error === "object" && error && "statusCode" in error && "code" in error) {
        const failure = error as { statusCode: 401 | 403; code: string; description: string; scope?: string };
        writeText(res, failure.statusCode, failure.description, {
          "www-authenticate": buildBearerChallenge({
            resourceMetadataUrl: metadataUrl,
            error: failure.code === "insufficient_scope" ? "insufficient_scope" : "invalid_token",
            description: failure.description,
            scope: failure.scope,
          }),
        });
        return;
      }

      logHttpServerError(error);
      writeText(res, 500, "Internal Server Error");
    }
  });

  return {
    server,
    transport,
    url: publicUrl,
    metadataUrl,
    async close() {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function startProxmoxMcpHttpServer(
  options: ProxmoxMcpHttpServerOptions,
): Promise<ProxmoxMcpHttpServerHandle> {
  const handle = await createProxmoxMcpHttpServer(options);
  await new Promise<void>((resolve, reject) => {
    handle.server.listen(options.port, options.host, () => resolve());
    handle.server.once("error", reject);
  });
  return handle;
}

export { getMetadataPath as getProxmoxMcpMetadataPath };
