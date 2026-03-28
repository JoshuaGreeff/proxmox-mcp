import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startProxmoxMcpHttpServer } from "../src/http-server.js";

describe("proxmox mcp http server", () => {
  const handles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()!.close();
    }
  });

  it("serves protected-resource metadata and rejects unauthenticated mcp requests", async () => {
    const mcpServer = new McpServer({ name: "test-server", version: "0.0.0" });
    const handle = await startProxmoxMcpHttpServer({
      server: mcpServer,
      host: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:0/mcp",
      auth: {
        issuer: "https://issuer.example",
        audience: "proxmox-mcp",
      },
    });
    handles.push(handle);

    const address = handle.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const metadataResponse = await fetch(`${baseUrl}${handle.metadataUrl.pathname}`);
    expect(metadataResponse.ok).toBe(true);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      resource: `${baseUrl}/mcp`,
      bearer_methods_supported: ["header"],
      authorization_servers: ["https://issuer.example/"],
    });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("does not expose internal error details on malformed request bodies", async () => {
    const mcpServer = new McpServer({ name: "test-server", version: "0.0.0" });
    const handle = await startProxmoxMcpHttpServer({
      server: mcpServer,
      host: "127.0.0.1",
      port: 0,
    });
    handles.push(handle);

    const address = handle.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});
