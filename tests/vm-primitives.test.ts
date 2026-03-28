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

describe("low-level VM primitives", () => {
  it("downloads into storage through the documented download-url endpoint", async () => {
    const service = makeService();
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: "UPID:download", upid: "UPID:download" });

    const result = await service.storageDownloadUrl(
      "lab",
      "pve-example",
      "local",
      {
        content: "import",
        filename: "debian.qcow2",
        url: "https://example.invalid/debian.qcow2",
        verifyCertificates: false,
        checksum: "abc123",
        checksumAlgorithm: "sha256",
      },
      30_000,
    );

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "node", node: "pve-example" },
      "POST",
      "/nodes/pve-example/storage/local/download-url",
      {
        storage: "local",
        node: "pve-example",
        content: "import",
        filename: "debian.qcow2",
        url: "https://example.invalid/debian.qcow2",
        "verify-certificates": false,
        checksum: "abc123",
        "checksum-algorithm": "sha256",
      },
      30_000,
      undefined,
    );
    expect(result).toEqual({ data: "UPID:download", upid: "UPID:download" });
  });

  it("creates a VM through the low-level create primitive", async () => {
    const service = makeService();
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: "UPID:create", upid: "UPID:create" });

    await service.vmCreate(
      "lab",
      "pve-example",
      9020,
      {
        name: "debian-docker-template",
        memory: 1024,
        cores: 1,
      },
      30_000,
    );

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "node", node: "pve-example" },
      "POST",
      "/nodes/pve-example/qemu",
      {
        name: "debian-docker-template",
        memory: 1024,
        cores: 1,
        vmid: 9020,
      },
      30_000,
      undefined,
    );
  });

  it("updates VM config after resolving the current node when needed", async () => {
    const service = makeService();
    vi.spyOn(service as any, "getVmLocation").mockResolvedValue({ id: "qemu/9020", type: "qemu", node: "pve-example", vmid: 9020 });
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: "UPID:qmset", upid: "UPID:qmset" });

    await service.vmUpdateConfig(
      "lab",
      9020,
      {
        memory: 2048,
        balloon: 1024,
      },
      undefined,
      60_000,
    );

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9020 },
      "PUT",
      "/nodes/pve-example/qemu/9020/config",
      {
        memory: 2048,
        balloon: 1024,
      },
      60_000,
      undefined,
    );
  });

  it("converts a VM to a template through the low-level template primitive", async () => {
    const service = makeService();
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: "UPID:template", upid: "UPID:template" });

    await service.vmConvertToTemplate(
      "lab",
      9020,
      {
        disk: "scsi0",
      },
      "pve-example",
      45_000,
    );

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9020 },
      "POST",
      "/nodes/pve-example/qemu/9020/template",
      {
        disk: "scsi0",
      },
      45_000,
      undefined,
    );
  });

  it("clones a VM or template through the low-level clone primitive", async () => {
    const service = makeService();
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: "UPID:clone", upid: "UPID:clone" });

    await service.vmClone(
      "lab",
      9020,
      {
        newid: 9420,
        name: "framework-clone-9420",
        full: false,
      },
      "pve-example",
      90_000,
    );

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9020 },
      "POST",
      "/nodes/pve-example/qemu/9020/clone",
      {
        newid: 9420,
        name: "framework-clone-9420",
        full: false,
      },
      90_000,
      undefined,
    );
  });

  it("omits undefined optional clone arguments before calling the Proxmox API", async () => {
    const service = makeService();
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: "UPID:clone", upid: "UPID:clone" });

    await service.vmClone(
      "lab",
      9020,
      {
        newid: 9421,
        name: "framework-clone-9421",
        full: false,
        bwlimit: undefined,
        format: undefined,
        storage: undefined,
      },
      "pve-example",
      90_000,
    );

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9020 },
      "POST",
      "/nodes/pve-example/qemu/9020/clone",
      {
        newid: 9421,
        name: "framework-clone-9421",
        full: false,
      },
      90_000,
      undefined,
    );
  });

  it("destroys a VM and clears the cached cluster resources", async () => {
    const service = makeService();
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: "UPID:destroy", upid: "UPID:destroy" });
    (service as unknown as { resourceCache: Map<string, unknown> }).resourceCache.set("lab", {
      fetchedAt: Date.now(),
      resources: [],
    });

    await service.vmDestroy(
      "lab",
      9420,
      {
        purge: true,
      },
      "pve-example",
      90_000,
    );

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9420 },
      "DELETE",
      "/nodes/pve-example/qemu/9420",
      {
        purge: true,
      },
      90_000,
      undefined,
    );
    expect((service as unknown as { resourceCache: Map<string, unknown> }).resourceCache.has("lab")).toBe(false);
  });

  it("calls the guest-agent ping endpoint for a VM", async () => {
    const service = makeService();
    const domains = createDomainServices(service);
    vi.spyOn(service, "inventoryOverview").mockResolvedValue({
      qemuVms: [{ cluster: "lab", vmid: 9430, node: "pve-example", name: "guest-agent-test", status: "running", capabilities: [] }],
    } as any);
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: { result: {} } });

    await domains.qemu.agentPing("lab", 9430, undefined, 15_000);

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9430 },
      "POST",
      "/nodes/pve-example/qemu/9430/agent/ping",
      {},
      15_000,
      undefined,
    );
  });

  it("calls the guest-agent info endpoint for a VM", async () => {
    const service = makeService();
    const domains = createDomainServices(service);
    vi.spyOn(service, "inventoryOverview").mockResolvedValue({
      qemuVms: [{ cluster: "lab", vmid: 9430, node: "pve-example", name: "guest-agent-test", status: "running", capabilities: [] }],
    } as any);
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockResolvedValue({ data: { result: { version: "7.2.22" } } });

    await domains.qemu.agentInfo("lab", 9430, undefined, 15_000);

    expect(proxmoxApiCall).toHaveBeenCalledWith(
      { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9430 },
      "GET",
      "/nodes/pve-example/qemu/9430/agent/info",
      {},
      15_000,
      undefined,
    );
  });

  it("diagnoses guest-agent readiness by aggregating vm state, cloud-init, and guest-agent probes", async () => {
    const service = makeService();
    const domains = createDomainServices(service);
    vi.spyOn(service, "inventoryOverview").mockResolvedValue({
      qemuVms: [{ target: { cluster: "lab", kind: "qemu_vm", node: "pve-example", vmid: 9430 }, displayName: "ubuntu-test", vmid: 9430, node: "pve-example", guestKind: "linux_guest", guestAgentAvailable: false, reachable: true, status: "running", capabilities: [] }],
    } as any);
    const proxmoxApiCall = vi.spyOn(service, "proxmoxApiCall").mockImplementation(async (_target, method, path) => {
      if (method === "GET" && path === "/nodes/pve-example/qemu/9430/status/current") {
        return { data: { status: "running", mem: 104857600, maxmem: 1073741824, balloon: 536870912 } };
      }
      if (method === "GET" && path === "/nodes/pve-example/qemu/9430/config") {
        return { data: { agent: "enabled=1", cicustom: "vendor=local:snippets/bootstrap.yml", serial0: "socket", vga: "serial0" } };
      }
      if (method === "POST" && path === "/nodes/pve-example/qemu/9430/agent/ping") {
        throw new Error("QEMU guest agent is not running");
      }
      if (method === "GET" && path === "/nodes/pve-example/qemu/9430/agent/info") {
        throw new Error("QEMU guest agent is not running");
      }
      throw new Error(`Unexpected API call ${method} ${path}`);
    });
    const dumpVmCloudInit = vi.spyOn(service, "dumpVmCloudInit").mockImplementation(async (_cluster, _vmid, section) => ({
      cluster: "lab",
      node: "pve-example",
      vmid: 9430,
      section,
      content: `# dump for ${section}`,
    }));

    const result = await domains.qemu.diagnoseGuestAgent("lab", 9430, undefined, 15_000);

    expect(proxmoxApiCall).toHaveBeenCalled();
    expect(dumpVmCloudInit).toHaveBeenCalledTimes(3);
    expect(result.vm).toEqual({
      cluster: "lab",
      vmid: 9430,
      node: "pve-example",
      name: "ubuntu-test",
      status: "running",
      proxmoxMemory: {
        usedBytes: 104857600,
        maxBytes: 1073741824,
        balloonBytes: 536870912,
      },
    });
    expect(result.guestAgent.configured).toBe(true);
    expect(result.guestAgent.ping).toEqual({ ok: false, error: "QEMU guest agent is not running" });
    expect(result.guestAgent.info).toEqual({ ok: false, error: "QEMU guest agent is not running" });
    expect(result.cloudInit.cicustom).toEqual({
      raw: "vendor=local:snippets/bootstrap.yml",
      sections: { vendor: "local:snippets/bootstrap.yml" },
    });
    expect(result.cloudInit.dumps).toEqual({
      user: { ok: true, content: "# dump for user" },
      network: { ok: true, content: "# dump for network" },
      meta: { ok: true, content: "# dump for meta" },
    });
    expect(result.console).toEqual({
      serialConfigured: true,
      vga: "serial0",
      suggestedConsoleScope: "shell",
    });
    expect(result.findings).toContain("Proxmox VM config enables the guest agent, but the guest agent ping endpoint is failing.");
    expect(result.findings).toContain("A vendor cloud-init snippet is attached: local:snippets/bootstrap.yml");
    expect(result.findings).toContain("The VM is running, so the issue is likely inside guest boot/bootstrap rather than Proxmox power state.");
  });
});
