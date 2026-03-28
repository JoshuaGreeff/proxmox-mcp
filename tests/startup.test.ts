import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SshExecutor } from "../src/ssh.js";
import { initializeRuntimeConfig } from "../src/startup.js";

const originalExec = SshExecutor.prototype.exec;
const envKeys = [
  "PROXMOX_HOST",
  "PROXMOX_SSH_USERNAME",
  "PROXMOX_SSH_PASSWORD",
  "PROXMOX_SSH_PORT",
  "PROXMOX_MCP_LOCAL_BOOTSTRAP",
  "PROXMOX_API_TOKEN_USER",
  "PROXMOX_API_TOKEN_SECRET",
  "PROXMOX_SHELL_SSH_USERNAME",
  "PROXMOX_SHELL_SSH_PRIVATE_KEY",
  "PROXMOX_SHELL_SSH_EXPECTED_HOST_KEY",
  "PROXMOX_MCP_SECRETS_JSON",
  "PROXMOX_DEFAULT_NODE",
] as const;
const originalEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

function setBootstrapEnv(username: string, password: string) {
  process.env.PROXMOX_HOST = "proxmox.example.internal";
  process.env.PROXMOX_MCP_LOCAL_BOOTSTRAP = "1";
  process.env.PROXMOX_SSH_USERNAME = username;
  process.env.PROXMOX_SSH_PASSWORD = password;
  process.env.PROXMOX_SSH_PORT = "22";
}

afterEach(() => {
  SshExecutor.prototype.exec = originalExec;
  vi.restoreAllMocks();
  for (const key of envKeys) {
    delete process.env[key];
  }
  for (const [key, value] of originalEnv.entries()) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
});

describe("initializeRuntimeConfig", () => {
  it("creates a managed lifecycle only for explicit local bootstrap mode", async () => {
    setBootstrapEnv("root", "bootstrap-secret");

    const commands: string[] = [];
    SshExecutor.prototype.exec = vi.fn(async (_target, command) => {
      commands.push(command);
      if (command.includes("id -u")) {
        return { stdout: "0\n", stderr: "", exitCode: 0 };
      }

      return {
        stdout: JSON.stringify({
          node: "pve-example",
          fullTokenId: "mcp@pam!mcp",
          value: "runtime-token-secret",
          expire: Math.floor(Date.now() / 1000) + 1200,
        }),
        stderr: "",
        exitCode: 0,
      };
    });

    const runtime = await initializeRuntimeConfig(loadConfig());
    const cluster = runtime.config.clusterMap.get("default");

    expect(commands).toHaveLength(2);
    expect(runtime.authLifecycle).toBeDefined();
    expect(cluster?.auth).toEqual({
      type: "api_token",
      user: "mcp",
      realm: "pam",
      tokenId: "mcp",
      secret: "runtime-token-secret",
    });
  });

  it("hydrates steady-state API and shell secrets without creating a bootstrap lifecycle", async () => {
    process.env.PROXMOX_HOST = "proxmox.example.internal";
    process.env.PROXMOX_DEFAULT_NODE = "pve-example";
    process.env.PROXMOX_API_TOKEN_USER = "proxmox-mcp";
    process.env.PROXMOX_API_TOKEN_SECRET = "runtime-token";
    process.env.PROXMOX_SHELL_SSH_USERNAME = "proxmox-mcp-shell";
    process.env.PROXMOX_SHELL_SSH_PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";
    process.env.PROXMOX_SHELL_SSH_EXPECTED_HOST_KEY = "SHA256:test-host-key";

    const runtime = await initializeRuntimeConfig(loadConfig());

    expect(runtime.authLifecycle).toBeUndefined();
    expect(runtime.config.clusterMap.get("default")?.auth).toMatchObject({
      type: "api_token",
      user: "proxmox-mcp",
      tokenId: "proxmox-mcp",
    });
    expect(runtime.config.sshProfileMap.get("__runtime_shell_default")).toMatchObject({
      username: "proxmox-mcp-shell",
      expectedHostKey: "SHA256:test-host-key",
      hostKeyPolicy: "strict",
    });
  });

  it("hydrates steady-state credentials from the admin secret document format", async () => {
    process.env.PROXMOX_HOST = "proxmox.example.internal";
    process.env.PROXMOX_DEFAULT_NODE = "pve-example";
    process.env.PROXMOX_MCP_SECRETS_JSON = JSON.stringify({
      version: 1,
      updatedAt: "2026-03-27T12:00:00.000Z",
      records: [
        {
          id: "default:api-token:proxmox-mcp@pam!proxmox-mcp",
          kind: "proxmox_api_token",
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
          metadata: { cluster: "default", node: "pve-example" },
          user: "proxmox-mcp",
          realm: "pam",
          tokenId: "proxmox-mcp",
          secret: "runtime-token",
        },
        {
          id: "default:shell-key:pve-example:proxmox-mcp-shell",
          kind: "shell_ssh_key",
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
          metadata: { cluster: "default", node: "pve-example", expectedHostKey: "SHA256:test-host-key", hostKeyPolicy: "strict" },
          username: "proxmox-mcp-shell",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
          publicKey: "ssh-ed25519 AAAA",
        },
      ],
    });

    const runtime = await initializeRuntimeConfig(loadConfig());

    expect(runtime.authLifecycle).toBeUndefined();
    expect(runtime.config.clusterMap.get("default")?.auth).toMatchObject({
      type: "api_token",
      user: "proxmox-mcp",
      tokenId: "proxmox-mcp",
    });
    expect(runtime.config.sshProfileMap.get("__runtime_shell_default")).toMatchObject({
      username: "proxmox-mcp-shell",
      expectedHostKey: "SHA256:test-host-key",
    });
  });
});
