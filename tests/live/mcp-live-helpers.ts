import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { getAppRoot } from "../../src/paths.js";

export const liveEnabled = process.env.ENABLE_LIVE_PROXMOX_TESTS === "1";
export const liveMutationEnabled = process.env.ENABLE_LIVE_PROXMOX_MUTATION_TESTS === "1";
export const liveGuestDockerEnabled = process.env.ENABLE_LIVE_GUEST_DOCKER_TESTS === "1";
export const liveCancelEnabled = process.env.ENABLE_LIVE_CANCEL_TESTS === "1";

export const liveCluster = process.env.LIVE_PROXMOX_CLUSTER ?? "default";
export const liveNode = process.env.LIVE_PROXMOX_NODE ?? "pve-example";
export const liveVmid = Number(process.env.LIVE_PROXMOX_VMID ?? "1001");
export const liveTemplateVmid = Number(process.env.LIVE_PROXMOX_TEMPLATE_VMID ?? "1000");
const appRoot = path.resolve(getAppRoot(import.meta.url), "..");

export function assertLiveEnvConfigured() {
  const steadyStateReady = Boolean(process.env.PROXMOX_HOST && process.env.PROXMOX_API_TOKEN_USER && process.env.PROXMOX_API_TOKEN_SECRET);
  const bootstrapReady = Boolean(process.env.PROXMOX_HOST && process.env.PROXMOX_MCP_LOCAL_BOOTSTRAP === "1" && process.env.PROXMOX_SSH_USERNAME && process.env.PROXMOX_SSH_PASSWORD);

  if (!steadyStateReady && !bootstrapReady) {
    throw new Error(
      "Live tests require PROXMOX_HOST plus steady-state API token envs, or explicit local bootstrap envs with PROXMOX_MCP_LOCAL_BOOTSTRAP=1",
    );
  }
}

export async function createLiveClient() {
  assertLiveEnvConfigured();

  const builtEntrypoint = path.join(appRoot, "dist", "index.js");
  const sourceEntrypoint = path.join(appRoot, "src", "index.ts");
  const commandArgs = fs.existsSync(builtEntrypoint) ? [builtEntrypoint] : ["--import", "tsx", sourceEntrypoint];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: commandArgs,
    cwd: appRoot,
    env: {
      ...process.env,
      ...(process.env.PROXMOX_HOST ? { PROXMOX_HOST: process.env.PROXMOX_HOST } : {}),
      ...(process.env.PROXMOX_API_TOKEN_USER ? { PROXMOX_API_TOKEN_USER: process.env.PROXMOX_API_TOKEN_USER } : {}),
      ...(process.env.PROXMOX_API_TOKEN_REALM ? { PROXMOX_API_TOKEN_REALM: process.env.PROXMOX_API_TOKEN_REALM } : {}),
      ...(process.env.PROXMOX_API_TOKEN_ID ? { PROXMOX_API_TOKEN_ID: process.env.PROXMOX_API_TOKEN_ID } : {}),
      ...(process.env.PROXMOX_API_TOKEN_SECRET ? { PROXMOX_API_TOKEN_SECRET: process.env.PROXMOX_API_TOKEN_SECRET } : {}),
      ...(process.env.PROXMOX_SHELL_SSH_USERNAME ? { PROXMOX_SHELL_SSH_USERNAME: process.env.PROXMOX_SHELL_SSH_USERNAME } : {}),
      ...(process.env.PROXMOX_SHELL_SSH_PRIVATE_KEY ? { PROXMOX_SHELL_SSH_PRIVATE_KEY: process.env.PROXMOX_SHELL_SSH_PRIVATE_KEY } : {}),
      ...(process.env.PROXMOX_SHELL_SSH_PRIVATE_KEY_PATH ? { PROXMOX_SHELL_SSH_PRIVATE_KEY_PATH: process.env.PROXMOX_SHELL_SSH_PRIVATE_KEY_PATH } : {}),
      ...(process.env.PROXMOX_SHELL_SSH_EXPECTED_HOST_KEY ? { PROXMOX_SHELL_SSH_EXPECTED_HOST_KEY: process.env.PROXMOX_SHELL_SSH_EXPECTED_HOST_KEY } : {}),
      ...(process.env.PROXMOX_MCP_LOCAL_BOOTSTRAP ? { PROXMOX_MCP_LOCAL_BOOTSTRAP: process.env.PROXMOX_MCP_LOCAL_BOOTSTRAP } : {}),
      ...(process.env.PROXMOX_SSH_USERNAME ? { PROXMOX_SSH_USERNAME: process.env.PROXMOX_SSH_USERNAME } : {}),
      ...(process.env.PROXMOX_SSH_PASSWORD ? { PROXMOX_SSH_PASSWORD: process.env.PROXMOX_SSH_PASSWORD } : {}),
      ...(process.env.PROXMOX_SSH_PORT ? { PROXMOX_SSH_PORT: process.env.PROXMOX_SSH_PORT } : {}),
      ...(process.env.PROXMOX_API_PORT ? { PROXMOX_API_PORT: process.env.PROXMOX_API_PORT } : {}),
      ...(process.env.PROXMOX_DEFAULT_NODE ? { PROXMOX_DEFAULT_NODE: process.env.PROXMOX_DEFAULT_NODE } : {}),
      ...(process.env.PROXMOX_DEFAULT_BRIDGE ? { PROXMOX_DEFAULT_BRIDGE: process.env.PROXMOX_DEFAULT_BRIDGE } : {}),
      ...(process.env.PROXMOX_DEFAULT_VM_STORAGE ? { PROXMOX_DEFAULT_VM_STORAGE: process.env.PROXMOX_DEFAULT_VM_STORAGE } : {}),
      ...(process.env.PROXMOX_DEFAULT_SNIPPET_STORAGE ? { PROXMOX_DEFAULT_SNIPPET_STORAGE: process.env.PROXMOX_DEFAULT_SNIPPET_STORAGE } : {}),
      ...(process.env.PROXMOX_TLS_REJECT_UNAUTHORIZED ? { PROXMOX_TLS_REJECT_UNAUTHORIZED: process.env.PROXMOX_TLS_REJECT_UNAUTHORIZED } : {}),
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "live-mcp-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export function expectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected record-like structuredContent, received ${JSON.stringify(value)}`);
  }

  return value as Record<string, unknown>;
}

export async function callToolRecord(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`Tool ${name} returned an error result: ${JSON.stringify(result.content)}`);
  }

  return expectRecord(result.structuredContent);
}
