import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditLogger, PolicyService } from "../src/policy.js";
import { ProxmoxService } from "../src/services.js";
import type { RuntimeConfig } from "../src/config.js";
import type { ManagedAuthLifecycle } from "../src/managed-auth.js";

function makeConfig(): RuntimeConfig {
  const config = {
    defaultTimeoutMs: 60_000,
    inventoryCacheTtlMs: 10_000,
    auditLogPath: "NUL",
    clusters: [
      {
        name: "lab",
        host: "proxmox.example.internal",
        apiUrl: "https://proxmox.example.internal:8006",
        apiPort: 8006,
        sshPort: 22,
        defaultNode: "pve-example",
        defaultBridge: "vmbr0",
        defaultVmStorage: "local-lvm",
        defaultSnippetStorage: "local",
        auth: {
          type: "api_token",
          user: "mcp",
          realm: "pam",
          tokenId: "mcp",
          secret: "old-token",
        },
        tls: { rejectUnauthorized: false },
        nodes: [
          {
            name: "pve-example",
            host: "proxmox.example.internal",
            port: 22,
            sshProfile: "__managed_lab",
          },
        ],
      },
    ],
    sshProfiles: [
      {
        name: "__managed_lab",
        username: "mcp",
        password: "old-password",
        port: 22,
        hostKeyPolicy: "accept-new",
        shell: "/bin/sh",
        prefixCommand: [],
      },
    ],
    winrmProfiles: [],
    linuxGuests: [],
    windowsGuests: [],
    policies: [],
    configPath: "config.yaml",
    clusterMap: new Map(),
    sshProfileMap: new Map(),
    winrmProfileMap: new Map(),
  } as unknown as RuntimeConfig;

  config.clusterMap = new Map(config.clusters.map((cluster) => [cluster.name, cluster]));
  config.sshProfileMap = new Map(config.sshProfiles.map((profile) => [profile.name, profile]));
  config.winrmProfileMap = new Map();
  return config;
}

function makePolicies(): PolicyService {
  return {
    assertCliAccess: vi.fn(),
    assertShellAccess: vi.fn(),
    assertFileAccess: vi.fn(),
    assertSudoAccess: vi.fn(),
    assertApiAccess: vi.fn(),
    clampTimeout: vi.fn(),
    getPolicy: vi.fn(),
  } as unknown as PolicyService;
}

function makeAudit(): AuditLogger {
  return {
    record: vi.fn(async () => {}),
  } as unknown as AuditLogger;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managed auth integration", () => {
  it("repairs managed API auth and retries the request once", async () => {
    const config = makeConfig();
    const authLifecycle = {
      ensureCluster: vi.fn(async () => {}),
      hasManagedCluster: vi.fn(() => true),
      repairCluster: vi.fn(async () => {
        config.clusterMap.get("lab")!.auth = {
          type: "api_token",
          user: "mcp",
          realm: "pam",
          tokenId: "mcp",
          secret: "new-token",
        };
      }),
    } as unknown as ManagedAuthLifecycle;

    const service = new ProxmoxService(config, makePolicies(), makeAudit(), authLifecycle);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Proxmox API GET /version failed: 401 {}"))
      .mockResolvedValueOnce({ version: "9.1.6" });
    vi.spyOn(service, "getApiClient").mockReturnValue({ request } as any);

    const response = await service.proxmoxApiCall({ cluster: "lab", kind: "cluster" }, "GET", "/version", {});

    expect(authLifecycle.ensureCluster).toHaveBeenCalledWith("lab");
    expect(authLifecycle.repairCluster).toHaveBeenCalledWith("lab", "api_auth_failure");
    expect(request).toHaveBeenCalledTimes(2);
    expect(response.data).toEqual({ version: "9.1.6" });
  });

  it("repairs managed SSH auth and retries the node command once", async () => {
    const config = makeConfig();
    const authLifecycle = {
      ensureCluster: vi.fn(async () => {}),
      hasManagedCluster: vi.fn(() => true),
      repairCluster: vi.fn(async () => {
        config.sshProfiles[0]!.password = "new-password";
        config.sshProfileMap.set("__managed_lab", config.sshProfiles[0]!);
      }),
    } as unknown as ManagedAuthLifecycle;

    const service = new ProxmoxService(config, makePolicies(), makeAudit(), authLifecycle);
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
      .mockResolvedValueOnce({ stdout: "ok\n", stderr: "", exitCode: 0 });
    (service as any).sshExecutor = { exec };

    const result = await service.nodeTerminalRun(
      "lab",
      "pve-example",
      {
        command: "hostname",
        interpreter: "bash",
        useSudo: true,
      },
      undefined,
    );

    expect(authLifecycle.ensureCluster).toHaveBeenCalledWith("lab");
    expect(authLifecycle.repairCluster).toHaveBeenCalledWith("lab", "ssh_auth_failure");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.stdout).toContain("ok");
  });
});
