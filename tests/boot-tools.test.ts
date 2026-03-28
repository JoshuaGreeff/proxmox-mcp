import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditLogger, PolicyService } from "../src/policy.js";
import { createDomainServices } from "../src/domain-services.js";
import { ProxmoxService } from "../src/services.js";
import type { RuntimeConfig } from "../src/config.js";

function makeService() {
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
          secret: "secret",
        },
        tls: { rejectUnauthorized: false },
        nodes: [
          {
            name: "pve-example",
            host: "proxmox.example.internal",
            port: 22,
            sshProfile: "root-ssh",
          },
        ],
      },
    ],
    sshProfiles: [],
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

  const policies = {
    assertCliAccess: vi.fn(),
    assertShellAccess: vi.fn(),
    assertFileAccess: vi.fn(),
    assertSudoAccess: vi.fn(),
    assertApiAccess: vi.fn(),
    clampTimeout: vi.fn(),
    getPolicy: vi.fn(),
  } as unknown as PolicyService;

  const audit = {
    record: vi.fn(async () => {}),
  } as unknown as AuditLogger;

  return new ProxmoxService(config, policies, audit);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VM boot diagnosis", () => {
  it("aggregates guest-agent, cloud-init, and offline inspection findings", async () => {
    const service = makeService();
    const domains = createDomainServices(service);

    vi.spyOn(service, "inventoryOverview").mockResolvedValue({
      qemuVms: [{ target: { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9430 }, displayName: "ubuntu-debug", vmid: 9430, node: "pve-example", guestKind: "linux_guest", guestAgentAvailable: false, reachable: true, status: "running", capabilities: [] }],
    } as any);

    vi.spyOn(service, "proxmoxApiCall").mockImplementation(async (_target, method, path) => {
      if (method === "GET" && path === "/nodes/pve-example/qemu/9430/status/current") {
        return { data: { status: "running", mem: 1234, maxmem: 5678, balloon: 4321 } };
      }
      if (method === "GET" && path === "/nodes/pve-example/qemu/9430/config") {
        return {
          data: {
            agent: "enabled=1",
            boot: "order=scsi0",
            bios: "ovmf",
            cicustom: "vendor=local:snippets/ubuntu.yml",
            ide2: "local-lvm:vm-9430-cloudinit,media=cdrom",
            machine: "q35",
            scsi0: "local-lvm:vm-9430-disk-0,size=3584M",
            serial0: "socket",
            vga: "serial0",
          },
        };
      }
      if (method === "POST" && path === "/nodes/pve-example/qemu/9430/agent/ping") {
        throw new Error("QEMU guest agent is not running");
      }
      if (method === "GET" && path === "/nodes/pve-example/qemu/9430/agent/info") {
        throw new Error("QEMU guest agent is not running");
      }
      throw new Error(`Unexpected API call ${method} ${path}`);
    });

    vi.spyOn(service, "dumpVmCloudInit").mockImplementation(async (_cluster, _vmid, section) => ({
      cluster: "lab",
      node: "pve-example",
      vmid: 9430,
      section,
      content:
        section === "user"
          ? "#cloud-config\npackage_upgrade: true\n"
          : `# ${section}`,
    }));

    vi.spyOn(service, "nodeTerminalRun").mockResolvedValue({
      stdout: [
        "__RCMCP_MOUNT__:/dev/loop0p1",
        "__RCMCP_BEGIN__:OS_RELEASE",
        'ID="ubuntu"',
        'VERSION_ID="24.04"',
        "__RCMCP_END__:OS_RELEASE",
        "__RCMCP_BEGIN__:BOOTSTRAP_STACK",
        "cloud-init",
        "__RCMCP_END__:BOOTSTRAP_STACK",
        "__RCMCP_BEGIN__:CLOUD_STATE_FILES",
        "/var/lib/cloud/seed/nocloud-net/user-data",
        "__RCMCP_END__:CLOUD_STATE_FILES",
        "__RCMCP_BEGIN__:CLOUD_INIT_JOURNAL",
        "",
        "__RCMCP_END__:CLOUD_INIT_JOURNAL",
        "__RCMCP_BEGIN__:CLOUD_INIT_OUTPUT",
        "",
        "__RCMCP_END__:CLOUD_INIT_OUTPUT",
        "__RCMCP_BEGIN__:TINY_CLOUD_MESSAGES",
        "",
        "__RCMCP_END__:TINY_CLOUD_MESSAGES",
        "__RCMCP_BEGIN__:APK_LOG",
        "",
        "__RCMCP_END__:APK_LOG",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const result = await domains.boot.diagnoseVmBoot("lab", 9430);

    expect(result.offlineInspection.bootstrapStack).toBe("cloud-init");
    expect(result.offlineInspection.mountSource).toBe("/dev/loop0p1");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        "Proxmox VM config enables the guest agent, but the guest agent ping endpoint is failing.",
        expect.stringContaining("cloud-init installed but no cloud-init journal activity"),
      ]),
    );
  });
});
