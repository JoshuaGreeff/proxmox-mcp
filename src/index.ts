import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { startProxmoxMcpHttpServer } from "./http-server.js";
import { initializeRuntimeConfig } from "./startup.js";
import { createMcpServer } from "./server.js";

async function main() {
  const runtime = await initializeRuntimeConfig(loadConfig());
  const closeables: Array<{ close(): Promise<void> }> = [];

  const shutdown = async () => {
    await Promise.allSettled(closeables.map((entry) => entry.close()));
    process.exit(0);
  };

  process.on("SIGHUP", () => {
    void runtime.reloadSecrets().catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    });
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (runtime.config.mode === "stdio" || runtime.config.mode === "both") {
    const stdioServer = createMcpServer(runtime.config, runtime.authLifecycle);
    const stdioTransport = new StdioServerTransport();
    await stdioServer.connect(stdioTransport);
  }

  if (runtime.config.mode === "http" || runtime.config.mode === "both") {
    const httpServer = createMcpServer(runtime.config, runtime.authLifecycle);
    const handle = await startProxmoxMcpHttpServer({
      server: httpServer,
      host: runtime.config.http.host,
      port: runtime.config.http.port,
      path: runtime.config.http.path,
      publicUrl: runtime.config.http.publicBaseUrl,
      issuerUrl: runtime.config.mcpAuth.mode === "oidc" ? runtime.config.mcpAuth.issuer : undefined,
      auth:
        runtime.config.mcpAuth.mode === "oidc"
          ? {
              issuer: runtime.config.mcpAuth.issuer,
              audience: runtime.config.mcpAuth.audience,
              jwksUri: runtime.config.mcpAuth.jwksUrl,
              resourceServerUrl: runtime.config.mcpAuth.resource ?? runtime.config.http.publicBaseUrl,
            }
          : undefined,
    });
    closeables.push(handle);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
