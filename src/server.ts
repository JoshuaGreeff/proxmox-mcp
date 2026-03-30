import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServerContext } from "./mcp-common.js";
import type { RuntimeConfig } from "./config.js";
import type { ManagedAuthLifecycle } from "./managed-auth.js";
import type { ProxmoxMcpScope } from "./http-auth.js";
import { registerAccessTools } from "./tools/access/register.js";
import { registerClusterTools } from "./tools/cluster/register.js";
import { registerBootTools } from "./tools/boot/register.js";
import { registerEscapeTools } from "./tools/escape/register.js";
import { registerInfrastructureTools } from "./tools/infrastructure/register.js";
import { registerLxcTools } from "./tools/lxc/register.js";
import { registerNodeTools } from "./tools/node/register.js";
import { registerQemuTools } from "./tools/qemu/register.js";
import { registerStorageTools } from "./tools/storage/register.js";

type ToolHandler = (args: any, extra: RequestHandlerExtra<any, any>) => Promise<unknown> | unknown;

function scopesForTool(name: string, args: Record<string, unknown>): ProxmoxMcpScope[] {
  if (
    name === "proxmox_cli_run" ||
    name === "proxmox_shell_run" ||
    name === "proxmox_file_read" ||
    name === "proxmox_file_write" ||
    name === "proxmox_node_terminal_run" ||
    name === "proxmox_vm_guest_exec" ||
    name === "proxmox_bootstrap_node_access"
  ) {
    return ["proxmox.escape"];
  }

  if (name === "proxmox_api_call") {
    return String(args.method ?? "GET").toUpperCase() === "GET" ? ["proxmox.read"] : ["proxmox.mutate"];
  }

  if (name === "job_cancel") {
    return ["proxmox.mutate"];
  }

  if (name === "job_get" || name === "job_wait" || name === "job_logs" || name === "proxmox_capabilities") {
    return ["proxmox.read"];
  }

  if (
    /_(create|update|delete|destroy|action|start|stop|reboot|reset|resume|suspend|shutdown|download_url|clone|convert_to_template|put|write|attach|detach)$/.test(name)
  ) {
    return ["proxmox.mutate"];
  }

  return ["proxmox.read"];
}

function wrapRegisterTool(server: McpServer, config: RuntimeConfig): void {
  const rawRegisterTool = (server.registerTool as any).bind(server) as (
    name: string,
    definition: Record<string, unknown>,
    handler: ToolHandler,
  ) => unknown;

  (server as any).registerTool = (name: string, definition: Record<string, unknown>, handler: ToolHandler) =>
    rawRegisterTool(name, definition, async (args: any, extra: RequestHandlerExtra<any, any>) => {
      if (config.mcpAuth.mode === "oidc") {
        const authInfo = extra.authInfo;
        if (!authInfo) {
          throw new Error("Authenticated HTTP mode requires bearer-authenticated tool calls");
        }

        const requiredScopes = scopesForTool(name, args as Record<string, unknown>);
        const scopeSet = new Set(authInfo.scopes);
        for (const scope of requiredScopes) {
          if (!scopeSet.has(scope)) {
            throw new Error(`Tool '${name}' requires scope '${scope}'`);
          }
        }
      }

      return handler(args, extra);
    });
}

/**
 * Creates the MCP server with all Proxmox tools, resources, and prompts.
 *
 * MCP server reference:
 * https://modelcontextprotocol.io/specification/2025-06-18/server
 */
export function createMcpServer(config: RuntimeConfig, authLifecycle?: ManagedAuthLifecycle) {
  const server = new McpServer(
    {
      name: "proxmox-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
        resources: {
          subscribe: false,
          listChanged: false,
        },
        prompts: {
          listChanged: false,
        },
      },
      instructions:
        "Use typed Proxmox tools first. Use proxmox_api_call for uncovered REST endpoints, proxmox_cli_run for Proxmox CLI families, and proxmox_shell_run only for explicit high-risk shell operations.",
    },
  );

  wrapRegisterTool(server, config);

  const context = createServerContext(config, authLifecycle);
  context.server = server;

  registerClusterTools(context);
  registerNodeTools(context);
  registerQemuTools(context);
  registerBootTools(context);
  registerLxcTools(context);
  registerStorageTools(context);
  registerAccessTools(context);
  registerInfrastructureTools(context);
  registerEscapeTools(context);

  return server;
}
