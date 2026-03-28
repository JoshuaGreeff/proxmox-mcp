import type { ProxmoxService, VmCloneOptions } from "./services.js";
import type { TargetRef } from "./types.js";
import { buildOfflineVmBootInspectionScript, parseOfflineVmBootInspection } from "./boot/diagnostics.js";
import type { BootstrapStack, OfflineBootInspection } from "./boot/types.js";

/**
 * Domain-oriented wrappers over the shared Proxmox foundation service.
 *
 * These modules keep tool registration close to Proxmox resource families without
 * duplicating transport, auth, policy, audit, or job logic.
 */

/** Cluster and datacenter read/control primitives. */
export class ClusterDomainService {
  constructor(private readonly service: ProxmoxService) {}

  /** Uses: `/cluster/resources`, `/cluster/status`, `/version` through the shared REST service. */
  inventoryOverview(cluster: string, options?: { probeRemote?: boolean; forceRefresh?: boolean }) {
    return this.service.inventoryOverview(cluster, options);
  }

  /** Uses: `/cluster/status` and `/version`. */
  async getStatus(cluster: string) {
    const target: TargetRef = { cluster, kind: "cluster" };
    const status = await this.service.proxmoxApiCall(target, "GET", "/cluster/status", {});
    const version = await this.service.proxmoxApiCall(target, "GET", "/version", {});
    return { status: status.data, version: version.data };
  }

  /** Uses: `/cluster/mapping/pci` list endpoint. */
  listPciMappings(cluster: string, checkNode?: string) {
    return this.service.proxmoxApiCall(
      { cluster, kind: "cluster" },
      "GET",
      "/cluster/mapping/pci",
      checkNode ? { "check-node": checkNode } : {},
    );
  }

  /** Uses: `/cluster/mapping/pci/{id}` get endpoint. */
  getPciMapping(cluster: string, id: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "GET", `/cluster/mapping/pci/${encodeURIComponent(id)}`, {});
  }

  /** Uses: `/cluster/mapping/pci` create endpoint. */
  createPciMapping(cluster: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "POST", "/cluster/mapping/pci", args, timeoutMs, signal);
  }

  /** Uses: `/cluster/mapping/pci/{id}` update endpoint. */
  updatePciMapping(cluster: string, id: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "PUT", `/cluster/mapping/pci/${encodeURIComponent(id)}`, args, timeoutMs, signal);
  }

  /** Uses: `/cluster/mapping/pci/{id}` delete endpoint. */
  deletePciMapping(cluster: string, id: string, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "DELETE", `/cluster/mapping/pci/${encodeURIComponent(id)}`, { id }, timeoutMs, signal);
  }
}

/** Node-scoped lifecycle and observability primitives. */
export class NodeDomainService {
  constructor(private readonly service: ProxmoxService) {}

  /** Uses: `/nodes`, `/cluster/resources` via inventory discovery. */
  async list(cluster: string) {
    return (await this.service.inventoryOverview(cluster)).nodes;
  }

  /** Uses: `/nodes/{node}/status`. */
  get(cluster: string, node: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "node", node }, "GET", `/nodes/${node}/status`, {});
  }

  /** Uses: node lifecycle paths such as `/nodes/{node}/status`, `/nodes/{node}/wakeonlan`, `/nodes/{node}/startall`. */
  action(cluster: string, node: string, action: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.nodeAction(cluster, node, action, args, timeoutMs, signal);
  }

  /** Uses: `/nodes/{node}/network`. */
  listNetwork(cluster: string, node: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "node", node }, "GET", `/nodes/${node}/network`, {});
  }

  /** Uses: node SSH plus internal shell transport policies. Fallback: explicit high-risk node terminal path. */
  terminal(cluster: string, node: string, input: { command: string; interpreter: "sh" | "bash" | "powershell" | "cmd"; useSudo: boolean }, signal?: AbortSignal, onOutput?: (chunk: string) => void) {
    return this.service.nodeTerminalRun(cluster, node, input, signal, onOutput);
  }
}

/** QEMU VM and template primitives. */
export class QemuDomainService {
  constructor(private readonly service: ProxmoxService) {}

  private parseCiCustom(value: unknown) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return {};
    }

    return Object.fromEntries(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.includes("="))
        .map((entry) => {
          const [key, ...rest] = entry.split("=");
          return [key, rest.join("=")];
        }),
    ) as Record<string, string>;
  }

  /** Uses: inventory plus `/nodes/{node}/qemu/{vmid}/status/current` and `/nodes/{node}/qemu/{vmid}/config`. */
  async get(cluster: string, vmid: number) {
    const inventory = await this.service.inventoryOverview(cluster);
    const vm = inventory.qemuVms.find((entry) => entry.vmid === vmid);
    if (!vm) {
      throw new Error(`VM ${vmid} not found in cluster ${cluster}`);
    }

    const target: TargetRef = { cluster, kind: "qemu_vm", vmid, node: vm.node };
    const status = await this.service.proxmoxApiCall(target, "GET", `/nodes/${vm.node}/qemu/${vmid}/status/current`, {});
    const config = await this.service.proxmoxApiCall(target, "GET", `/nodes/${vm.node}/qemu/${vmid}/config`, {});
    return { inventory: vm, status: status.data, config: config.data };
  }

  /** Uses: inventory discovery for QEMU VMs. */
  async list(cluster: string) {
    return (await this.service.inventoryOverview(cluster)).qemuVms;
  }

  /** Uses: `/nodes/{node}/qemu/{vmid}/status/{action}` lifecycle endpoints. */
  action(cluster: string, vmid: number, action: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.vmAction(cluster, vmid, action, args, timeoutMs, signal);
  }

  /** Uses: `/nodes/{node}/qemu` create endpoint. */
  create(cluster: string, node: string, vmid: number, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.vmCreate(cluster, node, vmid, args, timeoutMs, signal);
  }

  /** Uses: `/nodes/{node}/qemu/{vmid}/config`. */
  updateConfig(cluster: string, vmid: number, args: Record<string, unknown>, node?: string, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.vmUpdateConfig(cluster, vmid, args, node, timeoutMs, signal);
  }

  /** Uses: `/nodes/{node}/qemu/{vmid}/clone`. */
  clone(cluster: string, vmid: number, args: VmCloneOptions, node?: string, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.vmClone(cluster, vmid, args, node, timeoutMs, signal);
  }

  /** Uses: `/nodes/{node}/qemu/{vmid}/template`. */
  convertToTemplate(cluster: string, vmid: number, args: Record<string, unknown>, node?: string, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.vmConvertToTemplate(cluster, vmid, args, node, timeoutMs, signal);
  }

  /** Uses: `/nodes/{node}/qemu/{vmid}` DELETE endpoint. */
  destroy(cluster: string, vmid: number, args: Record<string, unknown>, node?: string, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.vmDestroy(cluster, vmid, args, node, timeoutMs, signal);
  }

  /** Uses: template listing and template config reads via the shared QEMU/resource service. */
  listTemplates(cluster: string) {
    return this.service.listVmTemplates(cluster);
  }

  /** Uses: `/cluster/resources` plus `/nodes/{node}/qemu/{vmid}/config` for template inspection. */
  getTemplate(cluster: string, vmid: number) {
    return this.service.getVmTemplate(cluster, vmid);
  }

  /** Uses: guest-agent endpoints first, then validated guest transports through the shared shell service. */
  guestExec(target: TargetRef, input: { command: string; interpreter: "sh" | "bash" | "powershell" | "cmd"; useSudo: boolean }, timeoutMs?: number, signal?: AbortSignal, onOutput?: (chunk: string) => void, onProgress?: (progress: { progress: number; total?: number; message?: string }) => Promise<void> | void) {
    return this.service.proxmoxShellRun(target, input, timeoutMs, signal, onOutput, onProgress);
  }

  /** Uses: `/nodes/{node}/qemu/{vmid}/agent/ping`. */
  async agentPing(cluster: string, vmid: number, nodeInput?: string, timeoutMs?: number, signal?: AbortSignal) {
    const node = nodeInput ?? (await this.list(cluster)).find((entry) => entry.vmid === vmid)?.node;
    if (!node) {
      throw new Error(`VM ${vmid} not found in cluster ${cluster}`);
    }
    return this.service.proxmoxApiCall(
      { cluster, kind: "qemu_vm", node, vmid },
      "POST",
      `/nodes/${node}/qemu/${vmid}/agent/ping`,
      {},
      timeoutMs,
      signal,
    );
  }

  /** Uses: `/nodes/{node}/qemu/{vmid}/agent/info`. */
  async agentInfo(cluster: string, vmid: number, nodeInput?: string, timeoutMs?: number, signal?: AbortSignal) {
    const node = nodeInput ?? (await this.list(cluster)).find((entry) => entry.vmid === vmid)?.node;
    if (!node) {
      throw new Error(`VM ${vmid} not found in cluster ${cluster}`);
    }
    return this.service.proxmoxApiCall(
      { cluster, kind: "qemu_vm", node, vmid },
      "GET",
      `/nodes/${node}/qemu/${vmid}/agent/info`,
      {},
      timeoutMs,
      signal,
    );
  }

  /**
   * Uses:
   * - `/nodes/{node}/qemu/{vmid}/status/current`
   * - `/nodes/{node}/qemu/{vmid}/config`
   * - `/nodes/{node}/qemu/{vmid}/agent/ping`
   * - `/nodes/{node}/qemu/{vmid}/agent/info`
   * - `qm cloudinit dump` via the validated CLI fallback
   *
   * Fallback:
   * - guest-agent checks are reported as diagnostics when they fail rather than throwing immediately
   * - cloud-init dump errors are surfaced per section so debugging remains bounded and transparent
   */
  async diagnoseGuestAgent(cluster: string, vmid: number, nodeInput?: string, timeoutMs?: number, signal?: AbortSignal) {
    const vm = await this.get(cluster, vmid);
    const node = nodeInput ?? vm.inventory.node;
    const config = vm.config as Record<string, unknown>;
    const status = vm.status as Record<string, unknown>;
    const ciCustom = this.parseCiCustom(config.cicustom);

    const pingResult = await this.agentPing(cluster, vmid, node, timeoutMs, signal)
      .then((result) => ({ ok: true, data: result.data }))
      .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));

    const infoResult = await this.agentInfo(cluster, vmid, node, timeoutMs, signal)
      .then((result) => ({ ok: true, data: result.data }))
      .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));

    const cloudInitSections = await Promise.all(
      (["user", "network", "meta"] as const).map(async (section) => {
        try {
          const dumped = await this.service.dumpVmCloudInit(cluster, vmid, section, signal);
          return [section, { ok: true, content: dumped.content }] as const;
        } catch (error: unknown) {
          return [section, { ok: false, error: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
    );

    const findings: string[] = [];
    const agentConfigured = typeof config.agent === "string" ? config.agent.includes("enabled=1") : config.agent === 1;
    if (!agentConfigured) {
      findings.push("Proxmox VM config does not show the guest agent as enabled.");
    }
    if (agentConfigured && !pingResult.ok) {
      findings.push("Proxmox VM config enables the guest agent, but the guest agent ping endpoint is failing.");
    }
    if (ciCustom.vendor) {
      findings.push(`A vendor cloud-init snippet is attached: ${ciCustom.vendor}`);
    }
    if (!ciCustom.vendor && !pingResult.ok) {
      findings.push("No vendor cloud-init snippet is attached, so template-carried first-boot bootstrap may be missing.");
    }
    if (status.status === "running" && !pingResult.ok) {
      findings.push("The VM is running, so the issue is likely inside guest boot/bootstrap rather than Proxmox power state.");
    }

    return {
      vm: {
        cluster,
        vmid,
        node,
        name: vm.inventory.displayName,
        status: status.status ?? vm.inventory.status ?? null,
        proxmoxMemory: {
          usedBytes: status.mem ?? null,
          maxBytes: status.maxmem ?? null,
          balloonBytes: status.balloon ?? null,
        },
      },
      guestAgent: {
        configured: agentConfigured,
        ping: pingResult,
        info: infoResult,
      },
      cloudInit: {
        cicustom: {
          raw: typeof config.cicustom === "string" ? config.cicustom : null,
          sections: ciCustom,
        },
        dumps: Object.fromEntries(cloudInitSections),
      },
      console: {
        serialConfigured: Boolean(config.serial0),
        vga: config.vga ?? null,
        suggestedConsoleScope: config.serial0 ? "shell" : "vnc",
      },
      findings,
    };
  }
}

/** VM boot/bootstrap diagnostics primitives. */
export class BootDomainService {
  constructor(private readonly service: ProxmoxService) {}

  private parseOsRelease(content: string | null | undefined) {
    const data = Object.fromEntries(
      (content ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.includes("="))
        .map((line) => {
          const [key, ...rest] = line.split("=");
          return [key, rest.join("=").replace(/^"/, "").replace(/"$/, "")];
        }),
    ) as Record<string, string>;

    return {
      distroFamily: (data.ID ?? "unknown").toLowerCase(),
      distroVersion: data.VERSION_ID ?? undefined,
    };
  }

  private inferCloudInitDriveBus(config: Record<string, unknown>): string | undefined {
    for (const [key, value] of Object.entries(config)) {
      if (/^(ide|scsi|sata|virtio)\d+$/.test(key) && typeof value === "string" && value.includes("cloudinit")) {
        return key.replace(/\d+$/, "");
      }
    }
    return undefined;
  }

  private inferRootDiskVolumeId(vmid: number, config: Record<string, unknown>): string | undefined {
    const bootOrder = typeof config.boot === "string" ? config.boot.match(/order=([^,\s]+)/)?.[1] : undefined;
    const candidates = [
      bootOrder,
      "scsi0",
      "virtio0",
      "sata0",
      "ide0",
    ].filter((value): value is string => Boolean(value));

    for (const key of candidates) {
      const raw = config[key];
      if (typeof raw !== "string" || !raw.includes(":")) {
        continue;
      }
      const parts = raw.split(":", 2);
      const right = parts[1];
      if (!right) {
        continue;
      }
      const volumeId = right.split(",")[0]?.trim();
      if (!volumeId) {
        continue;
      }
      if (/^(vm|base)-\d+-disk-\d+$/.test(volumeId)) {
        return volumeId;
      }
    }

    return `vm-${vmid}-disk-0`;
  }

  private buildOfflineFindings(offline: OfflineBootInspection): string[] {
    const findings: string[] = [];
    const journal = offline.sections.CLOUD_INIT_JOURNAL ?? "";
    const apkLog = offline.sections.APK_LOG ?? "";
    const tinyCloudMessages = offline.sections.TINY_CLOUD_MESSAGES ?? "";

    if (offline.bootstrapStack === "cloud-init" && journal.trim().length === 0) {
      findings.push("Offline inspection found cloud-init installed but no cloud-init journal activity, which suggests datasource detection or generator activation failed.");
    }

    if (offline.bootstrapStack === "tiny-cloud" && /No space left on device/i.test(apkLog)) {
      findings.push("Offline inspection found an Alpine package upgrade failure caused by running out of disk space during first-boot bootstrap.");
    }

    if (
      offline.bootstrapStack === "tiny-cloud" &&
      /vendor-data/i.test(offline.sections.CLOUD_STATE_FILES ?? "") &&
      /userdata_/i.test(tinyCloudMessages) &&
      !/vendordata_/i.test(tinyCloudMessages)
    ) {
      findings.push("Offline inspection suggests tiny-cloud processed user-data actions but did not expose matching vendor-data action handlers.");
    }

    return findings;
  }

  /**
   * Uses:
   * - `proxmox_vm_guest_agent_diagnose`-equivalent REST and CLI signals
   * - node-side offline disk inspection through the validated node terminal fallback
   *
   * Fallback:
   * - offline inspection only runs when the root disk can be resolved to a node-local block device
   * - diagnostics remain useful even when node-side inspection is unsupported or incomplete
   */
  async diagnoseVmBoot(cluster: string, vmid: number, nodeInput?: string, timeoutMs?: number, signal?: AbortSignal) {
    const qemu = new QemuDomainService(this.service);
    const guestAgentDiagnosis = await qemu.diagnoseGuestAgent(cluster, vmid, nodeInput, timeoutMs, signal);
    const vm = await qemu.get(cluster, vmid);
    const config = vm.config as Record<string, unknown>;
    const node = nodeInput ?? vm.inventory.node;
    const volumeId = this.inferRootDiskVolumeId(vmid, config);
    const blockDevicePath = volumeId ? `/dev/pve/${volumeId}` : null;

    let offlineInspection: OfflineBootInspection = {
      attempted: false,
      supported: false,
      privilegedNodeShellRequired: true,
      blockDevicePath,
      mountSource: null,
      bootstrapStack: "unknown",
      osRelease: null,
      sections: {},
      errors: blockDevicePath ? [] : ["block_device_unresolved"],
    };

    if (blockDevicePath) {
      offlineInspection.attempted = true;
      try {
        const command = buildOfflineVmBootInspectionScript(blockDevicePath, vmid);
        const result = await this.service.nodeTerminalRun(
          cluster,
          node,
          { command, interpreter: "bash", useSudo: false },
          signal,
        );
        offlineInspection = parseOfflineVmBootInspection(result, blockDevicePath);
      } catch (error: unknown) {
        offlineInspection = {
          attempted: true,
          supported: false,
          privilegedNodeShellRequired: true,
          blockDevicePath,
          mountSource: null,
          bootstrapStack: "unknown",
          osRelease: null,
          sections: {},
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    }

    return {
      vm: guestAgentDiagnosis.vm,
      guestAgent: guestAgentDiagnosis.guestAgent,
      cloudInit: guestAgentDiagnosis.cloudInit,
      console: guestAgentDiagnosis.console,
      offlineInspection,
      findings: [
        ...guestAgentDiagnosis.findings,
        ...this.buildOfflineFindings(offlineInspection),
      ],
    };
  }
}

/** LXC container primitives. */
export class LxcDomainService {
  constructor(private readonly service: ProxmoxService) {}

  /** Uses: inventory discovery for LXC containers. */
  async list(cluster: string) {
    return (await this.service.inventoryOverview(cluster)).lxcContainers;
  }

  /** Uses: `/nodes/{node}/lxc/{vmid}/status/current` and `/nodes/{node}/lxc/{vmid}/config`. */
  async get(cluster: string, vmid: number) {
    const inventory = await this.service.inventoryOverview(cluster);
    const container = inventory.lxcContainers.find((entry) => entry.vmid === vmid);
    if (!container) {
      throw new Error(`Container ${vmid} not found in cluster ${cluster}`);
    }

    const target: TargetRef = { cluster, kind: "lxc_container", vmid, node: container.node };
    const status = await this.service.proxmoxApiCall(target, "GET", `/nodes/${container.node}/lxc/${vmid}/status/current`, {});
    const config = await this.service.proxmoxApiCall(target, "GET", `/nodes/${container.node}/lxc/${vmid}/config`, {});
    return { inventory: container, status: status.data, config: config.data };
  }

  /** Uses: `/nodes/{node}/lxc/{vmid}/status/{action}` lifecycle endpoints. */
  action(cluster: string, vmid: number, action: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) {
    return this.service.lxcAction(cluster, vmid, action, args, timeoutMs, signal);
  }
}

/** Storage and snippet primitives. */
export class StorageDomainService {
  constructor(private readonly service: ProxmoxService) {}

  /** Uses: `/storage`. */
  list(cluster: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "GET", "/storage", {});
  }

  /** Uses: `/storage/{storage}`. */
  get(cluster: string, storage: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "GET", `/storage/${storage}`, {});
  }

  /** Uses: `/nodes/{node}/storage/{storage}/download-url`. */
  downloadUrl(cluster: string, node: string, storage: string, options: Parameters<ProxmoxService["storageDownloadUrl"]>[3], timeoutMs?: number, signal?: AbortSignal) {
    return this.service.storageDownloadUrl(cluster, node, storage, options, timeoutMs, signal);
  }

  /** Uses: snippet-capable Proxmox storage over validated SSH/file fallback because REST does not expose generic snippet file CRUD cleanly. */
  listSnippets(cluster: string, node?: string, storage?: string, signal?: AbortSignal) {
    return this.service.listCloudInitSnippets(cluster, node, storage, signal);
  }

  /** Uses: snippet-capable Proxmox storage over validated SSH/file fallback because REST does not expose generic snippet file CRUD cleanly. */
  getSnippet(cluster: string, node: string | undefined, storage: string | undefined, snippetPath: string, signal?: AbortSignal) {
    return this.service.getCloudInitSnippet(cluster, node, storage, snippetPath, signal);
  }

  /** Uses: snippet-capable Proxmox storage over validated SSH/file fallback because REST does not expose generic snippet file CRUD cleanly. */
  putSnippet(cluster: string, node: string | undefined, storage: string | undefined, snippetPath: string, content: string, signal?: AbortSignal) {
    return this.service.putCloudInitSnippet(cluster, node, storage, snippetPath, content, signal);
  }

  /** Uses: snippet-capable Proxmox storage over validated SSH/file fallback because REST does not expose generic snippet file CRUD cleanly. */
  deleteSnippet(cluster: string, node: string | undefined, storage: string | undefined, snippetPath: string, signal?: AbortSignal) {
    return this.service.deleteCloudInitSnippet(cluster, node, storage, snippetPath, signal);
  }
}

/** Access and identity primitives. */
export class AccessDomainService {
  constructor(private readonly service: ProxmoxService) {}

  /** Uses: `/access/users`. */
  listUsers(cluster: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "GET", "/access/users", {});
  }
}

/** Cluster-adjacent infrastructure primitives that do not warrant separate files yet. */
export class InfrastructureDomainService {
  constructor(private readonly service: ProxmoxService) {}

  /** Uses: cluster/node/guest firewall endpoint families. */
  firewallGet(target: TargetRef, path: string) {
    return this.service.proxmoxApiCall(target, "GET", path, {});
  }

  /** Uses: `/cluster/backup`. */
  backupJobs(cluster: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "GET", "/cluster/backup", {});
  }

  /** Uses: `/cluster/ceph/status`. */
  cephStatus(cluster: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "GET", "/cluster/ceph/status", {});
  }

  /** Uses: `/cluster/sdn`. */
  sdnList(cluster: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "cluster" }, "GET", "/cluster/sdn", {});
  }

  /** Uses: `/nodes/{node}/tasks`. */
  taskList(cluster: string, node: string) {
    return this.service.proxmoxApiCall({ cluster, kind: "node", node }, "GET", `/nodes/${node}/tasks`, {});
  }

  /** Uses: node-local task status/log endpoints. */
  async taskGet(cluster: string, node: string, upid: string) {
    return {
      status: await this.service.getTaskStatus(cluster, node, upid),
      log: await this.service.getTaskLog(cluster, node, upid),
    };
  }

  /** Uses: node, VM, and LXC console proxy ticket endpoints. */
  consoleTicket(cluster: string, targetKind: "node" | "qemu_vm" | "lxc_container", node: string | undefined, vmid: number | undefined, scope: "shell" | "vnc") {
    return this.service.consoleTicket(cluster, targetKind, node, vmid, scope);
  }
}

export interface DomainServices {
  cluster: ClusterDomainService;
  node: NodeDomainService;
  qemu: QemuDomainService;
  boot: BootDomainService;
  lxc: LxcDomainService;
  storage: StorageDomainService;
  access: AccessDomainService;
  infrastructure: InfrastructureDomainService;
}

/** Creates the domain service registry used by typed MCP modules. */
export function createDomainServices(service: ProxmoxService): DomainServices {
  return {
    cluster: new ClusterDomainService(service),
    node: new NodeDomainService(service),
    qemu: new QemuDomainService(service),
    boot: new BootDomainService(service),
    lxc: new LxcDomainService(service),
    storage: new StorageDomainService(service),
    access: new AccessDomainService(service),
    infrastructure: new InfrastructureDomainService(service),
  };
}
