import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ManagedAuthLifecycle } from "../src/managed-auth.js";
import { SshExecutor } from "../src/ssh.js";

const originalExec = SshExecutor.prototype.exec;
const envKeys = ["PROXMOX_HOST", "PROXMOX_SSH_USERNAME", "PROXMOX_SSH_PASSWORD", "PROXMOX_SSH_PORT", "PROXMOX_MCP_LOCAL_BOOTSTRAP"] as const;
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

describe("ManagedAuthLifecycle", () => {
  it("serializes concurrent repairs for the same cluster onto one reconcile pass", async () => {
    setBootstrapEnv("root", "bootstrap-secret");

    const commands: string[] = [];
    let scriptRuns = 0;
    SshExecutor.prototype.exec = vi.fn(async (_target, command) => {
      commands.push(command);
      if (command.includes("id -u")) {
        return { stdout: "0\n", stderr: "", exitCode: 0 };
      }

      scriptRuns += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        stdout: JSON.stringify({
          node: "pve-example",
          fullTokenId: "mcp@pam!mcp",
          value: `runtime-token-${scriptRuns}`,
          expire: Math.floor(Date.now() / 1000) + 1200,
        }),
        stderr: "",
        exitCode: 0,
      };
    });

    const manager = new ManagedAuthLifecycle(loadConfig());
    await Promise.all([manager.repairCluster("default", "manual"), manager.repairCluster("default", "manual")]);

    expect(scriptRuns).toBe(1);
    expect(commands.filter((entry) => entry.includes("id -u"))).toHaveLength(1);
    expect(manager.getStateSnapshot("default")).toMatchObject({
      nodeName: "pve-example",
      bootstrapMode: "root",
    });
  });
});
