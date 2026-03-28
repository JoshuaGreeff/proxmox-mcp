import { afterEach, describe, expect, it } from "vitest";
import { configSchema, loadConfig } from "../src/config.js";
import { PolicyService } from "../src/policy.js";
import type { RuntimeConfig } from "../src/config.js";

const envKeys = ["PROXMOX_HOST", "PROXMOX_MCP_LOCAL_BOOTSTRAP", "PROXMOX_SSH_USERNAME", "PROXMOX_SSH_PASSWORD"] as const;
const originalEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

function runtimeConfig(): RuntimeConfig {
  const parsed = configSchema.parse({
    clusters: [{ name: "lab", apiUrl: "https://lab.example:8006", auth: { type: "api_token", user: "root", realm: "pam", tokenId: "mcp", secret: "secret" } }],
    policies: [
      {
        name: "cluster-writes",
        match: { clusters: ["lab"], targetKinds: ["cluster", "node", "qemu_vm"] },
        allowApiRead: true,
        allowApiWrite: true,
        allowCliFamilies: ["pvesh"],
        allowRawCli: false,
        allowShell: false,
        allowFileRead: true,
        allowFileWrite: false,
        allowSudo: false,
        maxTimeoutMs: 1000,
      },
    ],
  });

  return {
    ...parsed,
    configPath: "/tmp/proxmox-mcp-test-config.yaml",
    clusterMap: new Map(parsed.clusters.map((cluster) => [cluster.name, cluster])),
    sshProfileMap: new Map(),
    winrmProfileMap: new Map(),
  };
}

describe("PolicyService", () => {
  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    for (const [key, value] of originalEnv.entries()) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  it("allows configured API writes and denies shell by default", () => {
    const policies = new PolicyService(runtimeConfig());
    const target = { cluster: "lab", kind: "qemu_vm" as const, vmid: 100 };

    expect(() => policies.assertApiAccess(target, "POST")).not.toThrow();
    expect(() => policies.assertShellAccess(target)).toThrow(/Policy denies shell access/);
  });

  it("clamps requested timeout to the matched policy maximum", () => {
    const policies = new PolicyService(runtimeConfig());
    expect(policies.clampTimeout({ cluster: "lab", kind: "cluster" }, 10_000, 5_000)).toBe(1_000);
  });

  it("defaults to full admin access only in explicit local bootstrap mode", () => {
    process.env.PROXMOX_HOST = "proxmox.example.internal";
    process.env.PROXMOX_MCP_LOCAL_BOOTSTRAP = "1";
    process.env.PROXMOX_SSH_USERNAME = "root";
    process.env.PROXMOX_SSH_PASSWORD = "bootstrap-password";

    const policies = new PolicyService(loadConfig());

    const target = { cluster: "default", kind: "node" as const, node: "pve-example" };
    expect(() => policies.assertApiAccess(target, "POST")).not.toThrow();
    expect(() => policies.assertShellAccess(target)).not.toThrow();
    expect(() => policies.assertFileAccess(target, "write")).not.toThrow();
    expect(() => policies.assertSudoAccess(target)).not.toThrow();
  });

  it("defaults to typed-only production access without explicit escape enablement", () => {
    process.env.PROXMOX_HOST = "proxmox.example.internal";

    const policies = new PolicyService(loadConfig());
    const target = { cluster: "default", kind: "node" as const, node: "pve-example" };

    expect(() => policies.assertApiAccess(target, "POST")).not.toThrow();
    expect(() => policies.assertShellAccess(target)).toThrow(/Policy denies shell access/);
    expect(() => policies.assertFileAccess(target, "write")).toThrow(/Policy denies file write access/);
    expect(() => policies.assertSudoAccess(target)).toThrow(/Policy denies sudo access/);
  });
});
