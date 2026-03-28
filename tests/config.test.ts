import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const envKeys = [
  "PROXMOX_HOST",
  "PROXMOX_SSH_USERNAME",
  "PROXMOX_SSH_PASSWORD",
  "PROXMOX_API_TOKEN_USER",
  "PROXMOX_API_TOKEN_SECRET",
  "PROXMOX_MCP_LOCAL_BOOTSTRAP",
  "PROXMOX_MCP_ENABLE_ESCAPE",
  "PROXMOX_MCP_MODE",
  "PROXMOX_MCP_AUTH_MODE",
  "PROXMOX_DEFAULT_NODE",
  "PROXMOX_DEFAULT_VM_STORAGE",
  "PROXMOX_DEFAULT_SNIPPET_STORAGE",
  "PROXMOX_DEFAULT_BRIDGE",
] as const;

const originalEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

function clearConfigEnv() {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearConfigEnv();
  for (const [key, value] of originalEnv.entries()) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
});

describe("loadConfig", () => {
  it("requires PROXMOX_HOST", () => {
    clearConfigEnv();
    expect(() => loadConfig()).toThrow(/PROXMOX_HOST/);
  });

  it("builds steady-state runtime config from env secrets without bootstrap ssh", () => {
    clearConfigEnv();
    process.env.PROXMOX_HOST = "proxmox.example.internal";
    process.env.PROXMOX_API_TOKEN_USER = "proxmox-mcp";
    process.env.PROXMOX_API_TOKEN_SECRET = "token-secret";
    process.env.PROXMOX_DEFAULT_NODE = "pve-example";

    const config = loadConfig();

    expect(config.configPath).toBe("[env]");
    expect(config.auditLogPath).toBe(os.devNull);
    expect(config.clusters[0]).toMatchObject({
      name: "default",
      host: "proxmox.example.internal",
      auth: {
        type: "secret_ref",
        secretCluster: "default",
      },
    });
    expect(config.policies[0]).toMatchObject({
      name: "default-production",
      allowApiWrite: true,
      allowShell: false,
      allowFileWrite: false,
      allowSudo: false,
    });
  });

  it("only enables full maintainer bootstrap when explicitly requested", () => {
    clearConfigEnv();
    process.env.PROXMOX_HOST = "proxmox.example.internal";
    process.env.PROXMOX_MCP_LOCAL_BOOTSTRAP = "1";
    process.env.PROXMOX_SSH_USERNAME = "root";
    process.env.PROXMOX_SSH_PASSWORD = "bootstrap-password";

    const config = loadConfig();

    expect(config.clusters[0]?.auth).toMatchObject({
      type: "ssh_bootstrap",
      sshUsername: "root",
      sshPassword: "bootstrap-password",
    });
    expect(config.policies[0]).toMatchObject({
      name: "default-maintainer",
      allowShell: true,
      allowFileWrite: true,
      allowSudo: true,
    });
  });

  it("requires OIDC settings in HTTP mode", () => {
    clearConfigEnv();
    process.env.PROXMOX_HOST = "proxmox.example.internal";
    process.env.PROXMOX_MCP_MODE = "http";

    expect(() => loadConfig()).toThrow(/PROXMOX_MCP_AUTH_MODE=oidc/);
  });
});
