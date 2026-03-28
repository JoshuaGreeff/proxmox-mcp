import fs from "node:fs/promises";
import { ApiCatalog } from "./schema.js";
import { isUpid, ProxmoxApiClient } from "./api.js";
import type {
  ClusterAuthConfig,
  ClusterConfig,
  LinuxGuestConfig,
  RuntimeConfig,
  WindowsGuestConfig,
} from "./config.js";
import type { ManagedAuthLifecycle } from "./managed-auth.js";
import { AuditLogger, PolicyService } from "./policy.js";
import { buildLinuxShellCommand, buildWindowsShellCommand, PowerShellRemotingExecutor, SshExecutor, type SshTarget } from "./ssh.js";
import type {
  CapabilityName,
  ClusterSummary,
  CommandResult,
  LxcSummary,
  NodeSummary,
  ProgressSnapshot,
  ResolvedLinuxGuestTarget,
  ResolvedNodeTarget,
  ResolvedWindowsGuestTarget,
  TargetKind,
  TargetRef,
  VmSummary,
} from "./types.js";
import { decodeMaybeBase64, decodeMaybeBase64Buffer, normalizeBoolean, shellJoin, shellQuote, sleep } from "./utils.js";

function omitUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/** Minimal cluster resource shape returned by `/cluster/resources`. */
type CloudInitSection = "meta" | "network" | "user" | "vendor";

/** Minimal cluster resource shape returned by `/cluster/resources`. */
type ClusterResource = {
  id: string;
  type: string;
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  template?: number;
  storage?: string;
};

/** Cached inventory snapshot used to reduce repeated cluster-resource scans. */
type CachedResourceState = {
  fetchedAt: number;
  resources: ClusterResource[];
};

type ConsoleScope = "shell" | "vnc";

export interface BootstrapNodeAccessOptions {
  apiUser: string;
  apiRealm: string;
  tokenId: string;
  comment?: string;
  expire?: number;
  privsep: boolean;
  replaceExistingToken: boolean;
  installSshPublicKey: boolean;
  activateApiToken: boolean;
}

export interface BootstrapNodeAccessResult {
  cluster: string;
  node: string;
  sshPublicKeyInstalled: boolean;
  tokenGenerated: boolean;
  tokenAuthActivated: boolean;
  tokenInfo?: {
    user: string;
    realm: string;
    tokenId: string;
    fullTokenId: string;
    value: string;
    privsep: boolean;
    expire?: number;
    comment?: string;
  };
}

export interface TemplateSummary {
  cluster: string;
  vmid: number;
  node: string;
  name: string;
  status?: string;
}

export interface VmTemplateDetails extends TemplateSummary {
  config: Record<string, unknown>;
}

export interface CloudInitSnippetRef {
  cluster: string;
  node: string;
  storage: string;
  path: string;
  volumeId: string;
}

export interface StorageDownloadUrlOptions {
  content: "iso" | "vztmpl" | "import";
  filename: string;
  url: string;
  verifyCertificates?: boolean;
  checksum?: string;
  checksumAlgorithm?: "md5" | "sha1" | "sha224" | "sha256" | "sha384" | "sha512";
}

export interface VmCloneOptions {
  newid: number;
  name?: string;
  full?: boolean;
  storage?: string;
  target?: string;
  pool?: string;
  description?: string;
  snapname?: string;
  bwlimit?: number;
  format?: "raw" | "qcow2" | "vmdk";
}

/**
 * Orchestrates Proxmox REST, SSH, guest-agent, and WinRM access behind one service API.
 *
 * Proxmox API docs:
 * https://pve.proxmox.com/wiki/Proxmox_VE_API
 * https://pve.proxmox.com/pve-docs/api-viewer/index.html
 */
export class ProxmoxService {
  private readonly catalog = new ApiCatalog();
  private readonly apiClients = new Map<string, ProxmoxApiClient>();
  private readonly apiClientFingerprints = new Map<string, string>();
  private readonly resourceCache = new Map<string, CachedResourceState>();
  private readonly sshExecutor = new SshExecutor();
  private readonly powerShellExecutor: PowerShellRemotingExecutor;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly policies: PolicyService,
    private readonly audit: AuditLogger,
    private readonly authLifecycle?: ManagedAuthLifecycle,
  ) {
    this.powerShellExecutor = new PowerShellRemotingExecutor(config);
  }

  /** Returns a configured cluster entry or throws when the alias is unknown. */
  private getCluster(clusterName: string): ClusterConfig {
    const cluster = this.config.clusterMap.get(clusterName);
    if (cluster) {
      return cluster;
    }

    if (this.config.clusters.length === 1) {
      return this.config.clusters[0]!;
    }

    throw new Error(`Unknown cluster '${clusterName}'`);
  }

  /** Resolves a default node for workflows that operate on one node-scoped host context. */
  private resolveDefaultNode(clusterName: string, requestedNode?: string): string {
    if (requestedNode) {
      return requestedNode;
    }

    const cluster = this.getCluster(clusterName);
    if (cluster.defaultNode) {
      return cluster.defaultNode;
    }

    if (cluster.nodes.length === 1) {
      return cluster.nodes[0]!.name;
    }

    throw new Error(`Cluster ${clusterName} requires an explicit node because no defaultNode is configured and multiple nodes are present`);
  }

  /** Returns a cluster-configured default bridge when a workflow does not override it. */
  private resolveDefaultBridge(clusterName: string, requestedBridge?: string): string {
    return requestedBridge ?? this.getCluster(clusterName).defaultBridge;
  }

  /** Returns the validated snippet storage to use for snippet-aware workflows. */
  private resolveDefaultSnippetStorage(clusterName: string, requestedStorage?: string): string {
    return requestedStorage ?? this.getCluster(clusterName).defaultSnippetStorage;
  }

  /** Returns the VM storage to use for template and clone workflows. */
  private resolveDefaultVmStorage(clusterName: string, requestedStorage?: string): string {
    const resolved = requestedStorage ?? this.getCluster(clusterName).defaultVmStorage;
    if (!resolved) {
      throw new Error(`Cluster ${clusterName} requires a storage argument because no defaultVmStorage is configured`);
    }
    return resolved;
  }

  private getApiClientFingerprint(cluster: ClusterConfig): string {
    switch (cluster.auth.type) {
      case "api_token":
        return `${cluster.auth.type}:${cluster.auth.user}:${cluster.auth.realm}:${cluster.auth.tokenId}:${cluster.auth.secret}`;
      case "ticket":
        return `${cluster.auth.type}:${cluster.auth.username}:${cluster.auth.realm}:${cluster.auth.password}:${cluster.auth.otp ?? ""}`;
      case "secret_ref":
        return `${cluster.auth.type}:${cluster.auth.secretCluster ?? cluster.name}`;
      case "ssh_bootstrap":
        return `${cluster.auth.type}:${cluster.auth.sshUsername}:${cluster.auth.apiUser}:${cluster.auth.apiRealm}:${cluster.auth.tokenId}`;
    }
  }

  /** Returns a cached API client per cluster to reuse auth and TLS settings. */
  getApiClient(clusterName: string): ProxmoxApiClient {
    const cluster = this.getCluster(clusterName);
    const fingerprint = this.getApiClientFingerprint(cluster);
    const cached = this.apiClients.get(clusterName);
    if (cached && this.apiClientFingerprints.get(clusterName) === fingerprint) {
      return cached;
    }

    const client = new ProxmoxApiClient(cluster);
    this.apiClients.set(clusterName, client);
    this.apiClientFingerprints.set(clusterName, fingerprint);
    return client;
  }

  /** Detects API auth failures that should trigger managed credential repair and one retry. */
  private isApiAuthError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\b401\b|ticket authentication failed|authentication/i.test(message);
  }

  /** Detects SSH auth failures that should trigger managed credential repair and one retry. */
  private isSshAuthError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /permission denied|authentication failed|all configured authentication methods failed/i.test(message);
  }

  /** Wraps a Proxmox API request with proactive refresh and repair-on-auth-failure semantics. */
  private async apiRequest<T = unknown>(
    clusterName: string,
    method: string,
    path: string,
    args: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
    allowRepair = true,
  ): Promise<T> {
    await this.authLifecycle?.ensureCluster(clusterName);

    try {
      return await this.getApiClient(clusterName).request<T>(method, path, args, options);
    } catch (error) {
      if (allowRepair && this.authLifecycle?.hasManagedCluster(clusterName) && this.isApiAuthError(error)) {
        await this.authLifecycle.repairCluster(clusterName, "api_auth_failure");
        return this.apiRequest<T>(clusterName, method, path, args, options, false);
      }

      throw error;
    }
  }

  /** Validates and executes a Proxmox REST call, surfacing any returned UPID. */
  async proxmoxApiCall(
    target: TargetRef,
    method: string,
    path: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; upid?: string }> {
    this.policies.assertApiAccess(target, method);
    const validated = this.catalog.validate(method, path, args);
    await this.audit.record({
      action: "proxmox_api_call",
      target,
      method,
      path,
      args: validated.args,
    });

    const data = await this.apiRequest(target.cluster, method, path, validated.args, {
      signal,
      timeoutMs,
    });

    return {
      data,
      upid: isUpid(data) ? data : undefined,
    };
  }

  /** Waits for a Proxmox task and then fetches its terminal log output. */
  async waitForUpid(
    cluster: string,
    upid: string,
    pollIntervalMs: number,
    signal?: AbortSignal,
    onProgress?: (progress: ProgressSnapshot) => Promise<void> | void,
  ): Promise<unknown> {
    const node = upid.split(":")[1];
    if (!node) {
      throw new Error(`Invalid UPID '${upid}'`);
    }

    let attempts = 0;
    let status: unknown;
    while (true) {
      if (signal?.aborted) {
        throw new Error("Task wait aborted");
      }

      status = await this.apiRequest(cluster, "GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`, {}, { signal }) as {
        status: "running" | "stopped";
      };
      attempts += 1;

      if ((status as { status?: string }).status === "stopped") {
        break;
      }

      await onProgress?.({
        progress: attempts,
        message: `Waiting for task ${upid}`,
      });
      await sleep(pollIntervalMs, signal);
    }

    const log = await this.apiRequest(cluster, "GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log`, {}, { signal });
    return {
      status,
      log,
    };
  }

  /** Cancels a Proxmox task using its node-local DELETE task endpoint. */
  async cancelUpid(cluster: string, upid: string): Promise<void> {
    const node = upid.split(":")[1];
    if (!node) {
      throw new Error(`Invalid UPID '${upid}'`);
    }

    await this.apiRequest(cluster, "DELETE", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`, {});
  }

  /** Convenience wrapper for raw task status reads. */
  async getTaskStatus(cluster: string, node: string, upid: string): Promise<unknown> {
    return this.apiRequest(cluster, "GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`, {});
  }

  /** Convenience wrapper for raw task log reads. */
  async getTaskLog(cluster: string, node: string, upid: string): Promise<unknown> {
    return this.apiRequest(cluster, "GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log`, {});
  }

  /** Returns cached `/cluster/resources` data unless a refresh is explicitly requested. */
  private async getClusterResources(cluster: string, forceRefresh = false): Promise<ClusterResource[]> {
    const ttl = this.config.inventoryCacheTtlMs;
    const cached = this.resourceCache.get(cluster);

    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < ttl) {
      return cached.resources;
    }

    const resources = (await this.apiRequest(cluster, "GET", "/cluster/resources")) as ClusterResource[];
    this.resourceCache.set(cluster, {
      fetchedAt: Date.now(),
      resources,
    });
    return resources;
  }

  /** Locates the current node for a VM or container by scanning cluster resources. */
  private async getVmLocation(cluster: string, kind: "qemu" | "lxc", vmid: number): Promise<ClusterResource> {
    const resources = await this.getClusterResources(cluster, true);
    const resource = resources.find((entry) => entry.type === kind && entry.vmid === vmid);
    if (!resource || !resource.node) {
      throw new Error(`Unable to locate ${kind} ${vmid} in cluster ${cluster}`);
    }
    return resource;
  }

  /** Resolves a node alias into its configured SSH target metadata. */
  private getNodeTarget(cluster: string, node: string): ResolvedNodeTarget {
    const clusterConfig = this.getCluster(cluster);
    const nodeConfig = clusterConfig.nodes.find((entry) => entry.name === node);
    if (!nodeConfig) {
      throw new Error(
        `No shell-capable node mapping is configured for ${cluster}/${node}. Enroll a shell identity or configure steady-state shell SSH secrets for this cluster.`,
      );
    }

    return {
      cluster,
      node,
      host: nodeConfig.host,
      port: nodeConfig.port,
      sshProfile: nodeConfig.sshProfile,
    };
  }

  /** Resolves a node target into the concrete SSH executor input. */
  private getNodeSshTarget(target: ResolvedNodeTarget): SshTarget {
    const profile = this.config.sshProfileMap.get(target.sshProfile);
    if (!profile) {
      throw new Error(
        `Shell access is not configured for ${target.cluster}/${target.node}. Missing SSH profile '${target.sshProfile}'. Configure or enroll the steady-state shell identity first.`,
      );
    }

    return {
      host: target.host,
      port: target.port,
      profile,
    };
  }

  /** Resolves the configured SSH public key used for first-time node enrollment. */
  private async getSshPublicKey(profileName: string): Promise<string> {
    const profile = this.config.sshProfileMap.get(profileName);
    if (!profile) {
      throw new Error(`Unknown SSH profile '${profileName}'`);
    }

    const publicKey = profile.publicKey ?? (profile.publicKeyPath ? await fs.readFile(profile.publicKeyPath, "utf8") : undefined);
    const normalized = publicKey?.trim();
    if (!normalized) {
      throw new Error(`SSH profile '${profileName}' is missing publicKey or publicKeyPath for enrollment`);
    }

    return normalized;
  }

  /** Installs the configured SSH public key into the node's authorized_keys file. */
  private async installNodePublicKey(cluster: string, node: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.getNodeTarget(cluster, node);
    const publicKey = await this.getSshPublicKey(resolved.sshProfile);
    const installCommand = [
      "umask 077",
      "mkdir -p ~/.ssh",
      "touch ~/.ssh/authorized_keys",
      `grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys`,
    ].join(" && ");

    const result = await this.runSshCommand(resolved, `/bin/sh -lc ${shellQuote(installCommand)}`, signal);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to install SSH public key on ${cluster}/${node}`);
    }
  }

  /** Swaps the active cluster auth in memory and clears cached clients that used the old credentials. */
  private setClusterAuth(clusterName: string, auth: ClusterAuthConfig): void {
    const cluster = this.getCluster(clusterName);
    cluster.auth = auth;
    this.apiClients.delete(clusterName);
  }

  /** Returns optional direct-Linux-guest config used when guest agent is unavailable. */
  private getLinuxGuestConfig(cluster: string, kind: "qemu_vm" | "lxc_container", vmid: number): LinuxGuestConfig | undefined {
    return this.config.linuxGuests.find((entry) => entry.cluster === cluster && entry.kind === kind && entry.vmid === vmid);
  }

  /** Returns optional direct-Windows-guest config used when guest agent is unavailable. */
  private getWindowsGuestConfig(cluster: string, vmid: number): WindowsGuestConfig | undefined {
    return this.config.windowsGuests.find((entry) => entry.cluster === cluster && entry.vmid === vmid);
  }

  /**
   * Detects guest OS kind and whether QEMU guest agent is enabled in Proxmox config.
   *
   * The `agent` field is not consistently boolean, so it is normalized separately.
   */
  private async detectVmGuest(cluster: string, node: string, vmid: number): Promise<{ guestKind: "linux_guest" | "windows_guest" | "unknown"; guestAgentAvailable: boolean }> {
    const config = (await this.apiRequest(cluster, "GET", `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`)) as Record<string, unknown>;
    const ostype = String(config.ostype ?? "");
    return {
      guestKind: ostype.startsWith("win") ? "windows_guest" : ostype.length > 0 ? "linux_guest" : "unknown",
      guestAgentAvailable: normalizeBoolean(config.agent),
    };
  }

  /** Probes for a guest-local Docker binary without treating absence as an error. */
  private async probeDocker(cluster: string, target: TargetRef): Promise<boolean> {
    try {
      const command = target.kind === "windows_guest" ? "Get-Command docker -ErrorAction SilentlyContinue" : "command -v docker";
      const result = await this.proxmoxShellRun(
        target,
        {
          command,
          interpreter: target.kind === "windows_guest" ? "powershell" : "sh",
          useSudo: false,
        },
        undefined,
        new AbortController().signal,
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Builds the capability-aware inventory snapshot exposed by the MCP inventory tools. */
  async inventoryOverview(
    cluster: string,
    options: {
      probeRemote?: boolean;
      forceRefresh?: boolean;
    } = {},
  ): Promise<ClusterSummary> {
    const resources = await this.getClusterResources(cluster, options.forceRefresh ?? false);
    const version = await this.apiRequest(cluster, "GET", "/version");
    const status = await this.apiRequest(cluster, "GET", "/cluster/status");

    const nodes = resources.filter((entry) => entry.type === "node");
    const qemuVms = resources.filter((entry) => entry.type === "qemu" && entry.vmid !== undefined && entry.node);
    const lxcContainers = resources.filter((entry) => entry.type === "lxc" && entry.vmid !== undefined && entry.node);
    const storages = resources.filter((entry) => entry.type === "storage");

    const nodeSummaries: NodeSummary[] = nodes.map((entry) => {
      const target: TargetRef = { cluster, kind: "node", node: entry.node ?? entry.id };
      const nodeConfigured = this.getCluster(cluster).nodes.some((node) => node.name === entry.node);
      const capabilities: CapabilityName[] = ["inventory", "config", "task_wait", "console"];
      if (nodeConfigured) {
        capabilities.push("host_shell");
      }

      return {
        target,
        displayName: entry.node ?? entry.id,
        node: entry.node ?? entry.id,
        status: entry.status,
        capabilities,
        preferredTransport: nodeConfigured ? "ssh" : "api_only",
        reachable: options.probeRemote ? nodeConfigured : null,
      };
    });

    const vmSummaries = await Promise.all(
      qemuVms.map(async (entry) => {
        const details = await this.detectVmGuest(cluster, entry.node!, entry.vmid!);
        const target: TargetRef = {
          cluster,
          kind: "qemu_vm",
          node: entry.node!,
          vmid: entry.vmid!,
        };
        const capabilities: CapabilityName[] = ["inventory", "lifecycle", "config", "task_wait", "console"];
        if (details.guestAgentAvailable) {
          capabilities.push("guest_exec", "guest_file_io", "guest_shell");
        } else if (details.guestKind === "linux_guest" && this.getLinuxGuestConfig(cluster, "qemu_vm", entry.vmid!)) {
          capabilities.push("guest_shell");
        } else if (details.guestKind === "windows_guest" && this.getWindowsGuestConfig(cluster, entry.vmid!)) {
          capabilities.push("guest_shell");
        }

        if (options.probeRemote && capabilities.includes("guest_shell") && (await this.probeDocker(cluster, {
          cluster,
          kind: details.guestKind === "windows_guest" ? "windows_guest" : "linux_guest",
          node: entry.node!,
          vmid: entry.vmid!,
        }))) {
          capabilities.push("docker_shell");
        }

        return {
          target,
          displayName: entry.name ?? `vm-${entry.vmid}`,
          vmid: entry.vmid!,
          node: entry.node!,
          status: entry.status,
          capabilities,
          // Guest agent is preferred because it avoids extra guest credentials and was the
          // most reliable first-boot transport in the validated T2 lab.
          preferredTransport: details.guestAgentAvailable
            ? "proxmox_guest_agent"
            : details.guestKind === "windows_guest"
              ? "winrm"
              : "ssh",
          reachable: null,
          guestKind: details.guestKind,
          guestAgentAvailable: details.guestAgentAvailable,
        } satisfies VmSummary;
      }),
    );

    const lxcSummaries: LxcSummary[] = lxcContainers.map((entry) => {
      const target: TargetRef = {
        cluster,
        kind: "lxc_container",
        node: entry.node!,
        vmid: entry.vmid!,
      };
      const nodeConfigured = this.getCluster(cluster).nodes.some((node) => node.name === entry.node);
      const capabilities: CapabilityName[] = ["inventory", "lifecycle", "config", "task_wait", "console"];
      if (nodeConfigured) {
        capabilities.push("guest_shell", "guest_file_io");
      }

      return {
        target,
        displayName: entry.name ?? `ct-${entry.vmid}`,
        vmid: entry.vmid!,
        node: entry.node!,
        status: entry.status,
        capabilities,
        preferredTransport: nodeConfigured ? "pct_over_ssh" : "api_only",
        reachable: null,
      };
    });

    return {
      cluster,
      version,
      status,
      nodes: nodeSummaries,
      qemuVms: vmSummaries,
      lxcContainers: lxcSummaries,
      storages,
    };
  }

  /** Executes a shell command on a Proxmox node over SSH. */
  private async runSshCommand(
    resolved: ResolvedNodeTarget,
    command: string,
    signal?: AbortSignal,
    onOutput?: (line: string) => void,
    allowRepair = true,
  ): Promise<CommandResult> {
    await this.authLifecycle?.ensureCluster(resolved.cluster);

    try {
      return await this.sshExecutor.exec(this.getNodeSshTarget(resolved), command, {
        signal,
        onStdout: (chunk) => onOutput?.(chunk),
        onStderr: (chunk) => onOutput?.(chunk),
      });
    } catch (error) {
      if (allowRepair && this.authLifecycle?.hasManagedCluster(resolved.cluster) && this.isSshAuthError(error)) {
        await this.authLifecycle.repairCluster(resolved.cluster, "ssh_auth_failure");
        return this.runSshCommand(resolved, command, signal, onOutput, false);
      }

      throw error;
    }
  }

  /** Runs a generated bash script on a node and returns its stdout/stderr like a normal command. */
  private async runNodeScript(cluster: string, node: string, script: string, signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<CommandResult> {
    const resolved = this.getNodeTarget(cluster, node);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    return this.runSshCommand(resolved, `/bin/sh -lc ${shellQuote(`printf %s ${shellQuote(encoded)} | base64 -d | bash`)}`, signal, onOutput);
  }

  /** Rejects snippet paths that would escape the Proxmox snippet storage root. */
  private normalizeSnippetPath(snippetPath: string): string {
    const normalized = snippetPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!normalized || normalized.includes("..")) {
      throw new Error(`Invalid snippet path '${snippetPath}'`);
    }
    return normalized;
  }

  /** Computes a Proxmox volume ID for a snippet stored on snippet-capable storage. */
  private snippetVolumeId(storage: string, snippetPath: string): string {
    return `${storage}:snippets/${this.normalizeSnippetPath(snippetPath)}`;
  }

  /** Resolves the filesystem root for snippet-capable storage, enabling snippets on write paths when needed. */
  private async getSnippetStorageRoot(cluster: string, node: string, storage: string, ensureSnippets: boolean, signal?: AbortSignal): Promise<string> {
    const script = [
      "set -euo pipefail",
      `STORAGE=${shellQuote(storage)}`,
      `
current=$(
  awk -v storage="$STORAGE" '
    $1 ~ /^[^[:space:]]+:$/ && $2 == storage { in_block=1; next }
    $1 ~ /^[^[:space:]]+:$/ { if (in_block) exit; in_block=0 }
    in_block && $1 == "content" {
      $1 = ""
      sub(/^[[:space:]]+/, "", $0)
      print
      exit
    }
  ' /etc/pve/storage.cfg
)
if [ -z "$current" ]; then
  echo "Unable to determine content types for storage '$STORAGE'." >&2
  exit 1
fi
case ",$current," in
  *,snippets,*) ;;
  *) ${
    ensureSnippets
      ? 'pvesm set "$STORAGE" --content "$current,snippets" >/dev/null'
      : 'echo "Storage \'"$STORAGE"\' does not support snippets." >&2; exit 1'
  } ;;
esac
root_path=$(
  awk -v storage="$STORAGE" '
    $1 ~ /^[^[:space:]]+:$/ && $2 == storage { in_block=1; next }
    $1 ~ /^[^[:space:]]+:$/ { if (in_block) exit; in_block=0 }
    in_block && $1 == "path" {
      $1 = ""
      sub(/^[[:space:]]+/, "", $0)
      print
      exit
    }
  ' /etc/pve/storage.cfg
)
if [ -z "$root_path" ]; then
  echo "Storage '$STORAGE' does not expose a filesystem path." >&2
  exit 1
fi
mkdir -p "$root_path/snippets"
printf '%s' "$root_path"
`.trim(),
    ].join("\n");

    const result = await this.runNodeScript(cluster, node, script, signal);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to resolve snippet storage root for ${storage}`);
    }

    return result.stdout.trim();
  }

  /** Runs a policy-approved Proxmox CLI family on a node over SSH. */
  async proxmoxCliRun(
    target: TargetRef,
    family: string,
    args: string[],
    rawCommand: string | undefined,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (target.kind !== "node" || !target.node) {
      throw new Error("CLI execution requires a node target");
    }

    this.policies.assertCliAccess(target, family, rawCommand !== undefined);
    const resolved = this.getNodeTarget(target.cluster, target.node);
    const command = rawCommand ?? shellJoin([family, ...args]);

    await this.audit.record({
      action: "proxmox_cli_run",
      target,
      family,
      rawCommand,
      args,
    });

    return this.runSshCommand(resolved, command, signal);
  }

  /**
   * Runs a command inside a QEMU guest using the Proxmox guest-agent endpoints.
   *
   * API endpoints:
   * `/nodes/{node}/qemu/{vmid}/agent/exec`
   * `/nodes/{node}/qemu/{vmid}/agent/exec-status`
   */
  private async runQemuGuestAgentCommand(
    cluster: string,
    node: string,
    vmid: number,
    command: string[],
    signal?: AbortSignal,
    onProgress?: (progress: ProgressSnapshot) => Promise<void> | void,
  ): Promise<CommandResult> {
    const start = (await this.apiRequest(cluster, "POST", `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/exec`, {
      command,
    })) as { pid: number };

    let attempts = 0;
    while (true) {
      if (signal?.aborted) {
        throw new Error("Guest agent command aborted");
      }

      const status = (await this.apiRequest(cluster, "GET", `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/exec-status`, {
        pid: start.pid,
      })) as Record<string, unknown>;

      if (normalizeBoolean(status.exited)) {
        return {
          stdout: decodeMaybeBase64(typeof status["out-data"] === "string" ? status["out-data"] : undefined),
          stderr: decodeMaybeBase64(typeof status["err-data"] === "string" ? status["err-data"] : undefined),
          exitCode: typeof status.exitcode === "number" ? status.exitcode : 0,
          signal: typeof status.signal === "number" ? String(status.signal) : undefined,
        };
      }

      attempts += 1;
      await onProgress?.({
        progress: attempts,
        message: `Waiting for guest-agent command PID ${start.pid}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /**
   * Runs a shell command against the best transport available for the target.
   *
   * Selection order is intentionally capability-driven:
   * node SSH / LXC `pct exec` / QEMU guest-agent / direct guest SSH / WinRM.
   */
  async proxmoxShellRun(
    target: TargetRef,
    input: {
      command: string;
      interpreter: "sh" | "bash" | "powershell" | "cmd";
      useSudo: boolean;
    },
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    onOutput?: (chunk: string) => void,
    onProgress?: (progress: ProgressSnapshot) => Promise<void> | void,
  ): Promise<CommandResult> {
    this.policies.assertShellAccess(target);
    if (input.useSudo) {
      this.policies.assertSudoAccess(target);
    }

    await this.audit.record({
      action: "proxmox_shell_run",
      target,
      input: {
        ...input,
      },
    });

    if (target.kind === "node" && target.node) {
      const resolved = this.getNodeTarget(target.cluster, target.node);
      const command = buildLinuxShellCommand(input.interpreter === "bash" ? "bash" : "sh", input.command);
      const prefixed = input.useSudo ? `sudo -n ${command}` : command;
      return this.runSshCommand(resolved, prefixed, signal, onOutput);
    }

    if (target.kind === "lxc_container" && target.vmid !== undefined) {
      const location = await this.getVmLocation(target.cluster, "lxc", target.vmid);
      const resolved = this.getNodeTarget(target.cluster, location.node!);
      const shellCommand = buildLinuxShellCommand(input.interpreter === "bash" ? "bash" : "sh", input.command);
      const pctCommand = `pct exec ${target.vmid} -- ${input.useSudo ? `sudo -n ${shellCommand}` : shellCommand}`;
      return this.runSshCommand(resolved, pctCommand, signal, onOutput);
    }

    if ((target.kind === "qemu_vm" || target.kind === "linux_guest" || target.kind === "windows_guest") && target.vmid !== undefined) {
      const location = await this.getVmLocation(target.cluster, "qemu", target.vmid);
      const vmDetails = await this.detectVmGuest(target.cluster, location.node!, target.vmid);

      if (vmDetails.guestAgentAvailable) {
        const commandArray =
          vmDetails.guestKind === "windows_guest" || input.interpreter === "powershell" || input.interpreter === "cmd"
            ? [
                input.interpreter === "cmd" ? "cmd.exe" : "powershell.exe",
                ...(input.interpreter === "cmd"
                  ? ["/c", input.command]
                  : ["-NoProfile", "-NonInteractive", "-Command", input.command]),
              ]
            : [input.interpreter === "bash" ? "/bin/bash" : "/bin/sh", "-lc", input.command];
        return this.runQemuGuestAgentCommand(target.cluster, location.node!, target.vmid, commandArray, signal, onProgress);
      }

      if (vmDetails.guestKind !== "windows_guest") {
        const guest = this.getLinuxGuestConfig(target.cluster, "qemu_vm", target.vmid);
        if (guest?.host && guest.sshProfile) {
          const profile = this.config.sshProfileMap.get(guest.sshProfile);
          if (!profile) {
            throw new Error(`Unknown SSH profile '${guest.sshProfile}'`);
          }
          return this.sshExecutor.exec(
            {
              host: guest.host,
              profile,
            },
            buildLinuxShellCommand(input.interpreter === "bash" ? "bash" : "sh", input.command),
            {
              signal,
              onStdout: onOutput,
              onStderr: onOutput,
            },
          );
        }
      } else {
        const guest = this.getWindowsGuestConfig(target.cluster, target.vmid);
        if (guest?.host && guest.winrmProfile) {
          return this.powerShellExecutor.exec(guest.winrmProfile, guest.host, input.command, signal);
        }
      }
    }

    throw new Error(`No supported shell transport found for ${target.kind} on cluster ${target.cluster}`);
  }

  /**
   * Reads a file as bytes using node SSH, `pct exec`, or guest-agent file APIs.
   *
   * Uses:
   * - node and LXC SSH paths with base64 transport
   * - `/nodes/{node}/qemu/{vmid}/agent/file-read` for QEMU guest-agent reads
   */
  async proxmoxFileReadBytes(target: TargetRef, filePath: string, signal?: AbortSignal): Promise<{ content: Buffer; source: string }> {
    this.policies.assertFileAccess(target, "read");
    await this.audit.record({
      action: "proxmox_file_read",
      target,
      filePath,
    });

    if (target.kind === "node" && target.node) {
      const resolved = this.getNodeTarget(target.cluster, target.node);
      // File reads over shell transports are base64-encoded to preserve binary-safe transport.
      const result = await this.runSshCommand(resolved, `base64 -w0 -- ${shellQuote(filePath)}`, signal);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Failed to read ${filePath}`);
      }
      return { content: Buffer.from(result.stdout.trim(), "base64"), source: "ssh" };
    }

    if (target.kind === "lxc_container" && target.vmid !== undefined) {
      const location = await this.getVmLocation(target.cluster, "lxc", target.vmid);
      const resolved = this.getNodeTarget(target.cluster, location.node!);
      const result = await this.runSshCommand(
        resolved,
        `pct exec ${target.vmid} -- /bin/sh -lc ${shellQuote(`base64 -w0 -- ${shellQuote(filePath)}`)}`,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Failed to read ${filePath}`);
      }
      return { content: Buffer.from(result.stdout.trim(), "base64"), source: "pct" };
    }

    if (target.vmid !== undefined) {
      const location = await this.getVmLocation(target.cluster, "qemu", target.vmid);
      const vmDetails = await this.detectVmGuest(target.cluster, location.node!, target.vmid);
      if (vmDetails.guestAgentAvailable) {
        const data = (await this.apiRequest(target.cluster, "GET", `/nodes/${encodeURIComponent(location.node!)}/qemu/${target.vmid}/agent/file-read`, {
          file: filePath,
        })) as { content: string; truncated?: boolean };
        return {
          content: decodeMaybeBase64Buffer(data.content),
          source: "guest_agent",
        };
      }
    }

    throw new Error(`No supported file read transport found for ${target.kind}`);
  }

  /**
   * Reads a file as UTF-8 text through the best supported transport for the target.
   *
   * Uses:
   * - `proxmoxFileReadBytes` for transport selection and binary-safe reads
   */
  async proxmoxFileRead(target: TargetRef, filePath: string, signal?: AbortSignal): Promise<{ content: string; source: string }> {
    const result = await this.proxmoxFileReadBytes(target, filePath, signal);
    return {
      content: result.content.toString("utf8"),
      source: result.source,
    };
  }

  /**
   * Writes file bytes using node SSH, `pct exec`, or guest-agent file APIs.
   *
   * Uses:
   * - node and LXC SSH paths with base64 transport
   * - `/nodes/{node}/qemu/{vmid}/agent/file-write` for QEMU guest-agent writes
   */
  async proxmoxFileWriteBytes(
    target: TargetRef,
    filePath: string,
    content: Buffer,
    signal?: AbortSignal,
  ): Promise<{ ok: true; source: string }> {
    this.policies.assertFileAccess(target, "write");
    await this.audit.record({
      action: "proxmox_file_write",
      target,
      filePath,
      contentLength: content.byteLength,
    });

    if (target.kind === "node" && target.node) {
      const resolved = this.getNodeTarget(target.cluster, target.node);
      // Shell transports write base64 so arbitrary content survives quoting and redirection.
      const encoded = content.toString("base64");
      const result = await this.runSshCommand(
        resolved,
        `/bin/sh -lc ${shellQuote(`printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`)}`,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Failed to write ${filePath}`);
      }
      return { ok: true, source: "ssh" };
    }

    if (target.kind === "lxc_container" && target.vmid !== undefined) {
      const location = await this.getVmLocation(target.cluster, "lxc", target.vmid);
      const resolved = this.getNodeTarget(target.cluster, location.node!);
      const encoded = content.toString("base64");
      const inner = `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`;
      const result = await this.runSshCommand(
        resolved,
        `pct exec ${target.vmid} -- /bin/sh -lc ${shellQuote(inner)}`,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Failed to write ${filePath}`);
      }
      return { ok: true, source: "pct" };
    }

    if (target.vmid !== undefined) {
      const location = await this.getVmLocation(target.cluster, "qemu", target.vmid);
      const vmDetails = await this.detectVmGuest(target.cluster, location.node!, target.vmid);
      if (vmDetails.guestAgentAvailable) {
        await this.apiRequest(target.cluster, "POST", `/nodes/${encodeURIComponent(location.node!)}/qemu/${target.vmid}/agent/file-write`, {
          file: filePath,
          content: content.toString("base64"),
          encode: true,
        });
        return { ok: true, source: "guest_agent" };
      }
    }

    throw new Error(`No supported file write transport found for ${target.kind}`);
  }

  /** Writes a file using node SSH, `pct exec`, or guest-agent file APIs. */
  async proxmoxFileWrite(
    target: TargetRef,
    filePath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; source: string }> {
    return this.proxmoxFileWriteBytes(target, filePath, Buffer.from(content, "utf8"), signal);
  }

  /** Lists managed and user-created snippet files on snippet-capable Proxmox storage. */
  async listCloudInitSnippets(cluster: string, nodeInput: string | undefined, storageInput: string | undefined, signal?: AbortSignal): Promise<CloudInitSnippetRef[]> {
    const node = this.resolveDefaultNode(cluster, nodeInput);
    const storage = this.resolveDefaultSnippetStorage(cluster, storageInput);
    const target: TargetRef = { cluster, kind: "node", node };

    this.policies.assertShellAccess(target);
    this.policies.assertFileAccess(target, "read");
    await this.audit.record({
      action: "proxmox_cloud_init_snippet_list",
      target,
      storage,
    });

    const script = [
      "set -euo pipefail",
      `STORAGE=${shellQuote(storage)}`,
      `
current=$(
  awk -v storage="$STORAGE" '
    $1 ~ /^[^[:space:]]+:$/ && $2 == storage { in_block=1; next }
    $1 ~ /^[^[:space:]]+:$/ { if (in_block) exit; in_block=0 }
    in_block && $1 == "content" {
      $1 = ""
      sub(/^[[:space:]]+/, "", $0)
      print
      exit
    }
  ' /etc/pve/storage.cfg
)
case ",$current," in
  *,snippets,*) ;;
  *) echo "Storage '$STORAGE' does not support snippets." >&2; exit 1 ;;
esac
root_path=$(
  awk -v storage="$STORAGE" '
    $1 ~ /^[^[:space:]]+:$/ && $2 == storage { in_block=1; next }
    $1 ~ /^[^[:space:]]+:$/ { if (in_block) exit; in_block=0 }
    in_block && $1 == "path" {
      $1 = ""
      sub(/^[[:space:]]+/, "", $0)
      print
      exit
    }
  ' /etc/pve/storage.cfg
)
if [ -z "$root_path" ]; then
  echo "Storage '$STORAGE' does not expose a filesystem path." >&2
  exit 1
fi
mkdir -p "$root_path/snippets"
find "$root_path/snippets" -type f | sed "s|^$root_path/snippets/||" | sort
`.trim(),
    ].join("\n");

    const result = await this.runNodeScript(cluster, node, script, signal);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to list snippets for ${cluster}/${node}`);
    }

    return result.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => ({
        cluster,
        node,
        storage,
        path: entry,
        volumeId: this.snippetVolumeId(storage, entry),
      }));
  }

  /** Reads a cloud-init snippet directly from Proxmox snippet storage. */
  async getCloudInitSnippet(cluster: string, nodeInput: string | undefined, storageInput: string | undefined, snippetPath: string, signal?: AbortSignal): Promise<CloudInitSnippetRef & { content: string }> {
    const node = this.resolveDefaultNode(cluster, nodeInput);
    const storage = this.resolveDefaultSnippetStorage(cluster, storageInput);
    const normalizedPath = this.normalizeSnippetPath(snippetPath);
    const target: TargetRef = { cluster, kind: "node", node };

    this.policies.assertShellAccess(target);
    this.policies.assertFileAccess(target, "read");
    await this.audit.record({
      action: "proxmox_cloud_init_snippet_get",
      target,
      storage,
      path: normalizedPath,
    });

    const storageRoot = await this.getSnippetStorageRoot(cluster, node, storage, false, signal);
    const filePath = `${storageRoot}/snippets/${normalizedPath}`;
    const readResult = await this.proxmoxFileRead(target, filePath, signal);
    return {
      cluster,
      node,
      storage,
      path: normalizedPath,
      volumeId: this.snippetVolumeId(storage, normalizedPath),
      content: readResult.content,
    };
  }

  /** Writes a cloud-init snippet onto Proxmox snippet storage after validating the target path. */
  async putCloudInitSnippet(cluster: string, nodeInput: string | undefined, storageInput: string | undefined, snippetPath: string, content: string, signal?: AbortSignal): Promise<CloudInitSnippetRef> {
    const node = this.resolveDefaultNode(cluster, nodeInput);
    const storage = this.resolveDefaultSnippetStorage(cluster, storageInput);
    const normalizedPath = this.normalizeSnippetPath(snippetPath);
    const target: TargetRef = { cluster, kind: "node", node };

    this.policies.assertShellAccess(target);
    this.policies.assertFileAccess(target, "write");
    await this.audit.record({
      action: "proxmox_cloud_init_snippet_put",
      target,
      storage,
      path: normalizedPath,
      contentLength: content.length,
    });

    const storageRoot = await this.getSnippetStorageRoot(cluster, node, storage, true, signal);
    const snippetDirectory = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
    if (snippetDirectory) {
      const ensureResult = await this.runNodeScript(cluster, node, `set -euo pipefail\nmkdir -p ${shellQuote(`${storageRoot}/snippets/${snippetDirectory}`)}`, signal);
      if (ensureResult.exitCode !== 0) {
        throw new Error(ensureResult.stderr || `Failed to prepare snippet directory ${snippetDirectory}`);
      }
    }

    await this.proxmoxFileWrite(target, `${storageRoot}/snippets/${normalizedPath}`, content, signal);
    return {
      cluster,
      node,
      storage,
      path: normalizedPath,
      volumeId: this.snippetVolumeId(storage, normalizedPath),
    };
  }

  /** Deletes a snippet file from Proxmox snippet storage. */
  async deleteCloudInitSnippet(cluster: string, nodeInput: string | undefined, storageInput: string | undefined, snippetPath: string, signal?: AbortSignal): Promise<CloudInitSnippetRef & { deleted: true }> {
    const node = this.resolveDefaultNode(cluster, nodeInput);
    const storage = this.resolveDefaultSnippetStorage(cluster, storageInput);
    const normalizedPath = this.normalizeSnippetPath(snippetPath);
    const target: TargetRef = { cluster, kind: "node", node };

    this.policies.assertShellAccess(target);
    this.policies.assertFileAccess(target, "write");
    await this.audit.record({
      action: "proxmox_cloud_init_snippet_delete",
      target,
      storage,
      path: normalizedPath,
    });

    const storageRoot = await this.getSnippetStorageRoot(cluster, node, storage, false, signal);
    const result = await this.runNodeScript(cluster, node, `set -euo pipefail\nrm -f ${shellQuote(`${storageRoot}/snippets/${normalizedPath}`)}`, signal);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to delete snippet ${normalizedPath}`);
    }

    return {
      cluster,
      node,
      storage,
      path: normalizedPath,
      volumeId: this.snippetVolumeId(storage, normalizedPath),
      deleted: true,
    };
  }

  /** Dumps generated cloud-init sections from an existing VM or template for debugging and docs. */
  async dumpVmCloudInit(cluster: string, vmid: number, section: Extract<CloudInitSection, "meta" | "network" | "user">, signal?: AbortSignal): Promise<{ cluster: string; node: string; vmid: number; section: string; content: string }> {
    const location = await this.getVmLocation(cluster, "qemu", vmid);
    const target: TargetRef = { cluster, kind: "node", node: location.node };

    this.policies.assertCliAccess(target, "qm");
    await this.audit.record({
      action: "proxmox_vm_cloud_init_dump",
      target,
      section,
    });

    const result = await this.proxmoxCliRun(target, "qm", ["cloudinit", "dump", String(vmid), section], undefined, undefined, signal);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to dump cloud-init ${section} for VM ${vmid}`);
    }

    return {
      cluster,
      node: location.node!,
      vmid,
      section,
      content: result.stdout,
    };
  }

  /** Returns the validated QEMU templates currently visible in cluster resources. */
  async listVmTemplates(cluster: string): Promise<TemplateSummary[]> {
    const resources = await this.getClusterResources(cluster, true);
    return resources
      .filter((entry) => entry.type === "qemu" && entry.vmid !== undefined && entry.node && entry.template === 1)
      .map((entry) => ({
        cluster,
        vmid: entry.vmid!,
        node: entry.node!,
        name: entry.name ?? `vm-${entry.vmid}`,
        status: entry.status,
      }));
  }

  /** Reads template config for a QEMU template through `/cluster/resources` plus `/nodes/{node}/qemu/{vmid}/config`. */
  async getVmTemplate(cluster: string, vmid: number): Promise<VmTemplateDetails> {
    const templates = await this.listVmTemplates(cluster);
    const template = templates.find((entry) => entry.vmid === vmid);
    if (!template) {
      throw new Error(`Template ${vmid} not found in cluster ${cluster}`);
    }

    const target: TargetRef = { cluster, kind: "qemu_vm", node: template.node, vmid };
    const config = (await this.proxmoxApiCall(target, "GET", `/nodes/${template.node}/qemu/${vmid}/config`, {})).data as Record<string, unknown>;
    return {
      ...template,
      config,
    };
  }

  /** Downloads a file into Proxmox storage through the documented storage download-url endpoint. */
  async storageDownloadUrl(
    cluster: string,
    node: string,
    storage: string,
    options: StorageDownloadUrlOptions,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; upid?: string }> {
    return this.proxmoxApiCall(
      { cluster, kind: "node", node },
      "POST",
      `/nodes/${node}/storage/${storage}/download-url`,
      {
        storage,
        node,
        content: options.content,
        filename: options.filename,
        url: options.url,
        ...(options.verifyCertificates !== undefined ? { "verify-certificates": options.verifyCertificates } : {}),
        ...(options.checksum ? { checksum: options.checksum } : {}),
        ...(options.checksumAlgorithm ? { "checksum-algorithm": options.checksumAlgorithm } : {}),
      },
      timeoutMs,
      signal,
    );
  }

  /** Creates a QEMU VM through the documented REST endpoint using generic config arguments. */
  async vmCreate(
    cluster: string,
    node: string,
    vmid: number,
    args: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; upid?: string }> {
    return this.proxmoxApiCall(
      { cluster, kind: "node", node },
      "POST",
      `/nodes/${node}/qemu`,
      {
        ...args,
        vmid,
      },
      timeoutMs,
      signal,
    );
  }

  /** Updates QEMU VM config through the documented REST endpoint using generic config arguments. */
  async vmUpdateConfig(
    cluster: string,
    vmid: number,
    args: Record<string, unknown>,
    nodeInput?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; upid?: string }> {
    const node = nodeInput ?? (await this.getVmLocation(cluster, "qemu", vmid)).node!;
    return this.proxmoxApiCall(
      { cluster, kind: "qemu_vm", node, vmid },
      "PUT",
      `/nodes/${node}/qemu/${vmid}/config`,
      args,
      timeoutMs,
      signal,
    );
  }

  /** Converts an existing QEMU VM into a Proxmox template through the documented REST endpoint. */
  async vmConvertToTemplate(
    cluster: string,
    vmid: number,
    args: Record<string, unknown> = {},
    nodeInput?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; upid?: string }> {
    const node = nodeInput ?? (await this.getVmLocation(cluster, "qemu", vmid)).node!;
    return this.proxmoxApiCall(
      { cluster, kind: "qemu_vm", node, vmid },
      "POST",
      `/nodes/${node}/qemu/${vmid}/template`,
      args,
      timeoutMs,
      signal,
    );
  }

  /** Clones a QEMU VM or template through the documented REST endpoint using low-level clone arguments. */
  async vmClone(
    cluster: string,
    vmid: number,
    options: VmCloneOptions,
    nodeInput?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; upid?: string }> {
    const node = nodeInput ?? (await this.getVmLocation(cluster, "qemu", vmid)).node!;
    return this.proxmoxApiCall(
      { cluster, kind: "qemu_vm", node, vmid },
      "POST",
      `/nodes/${node}/qemu/${vmid}/clone`,
      omitUndefined(options),
      timeoutMs,
      signal,
    );
  }

  /** Destroys a QEMU VM or template through the documented REST endpoint. */
  async vmDestroy(
    cluster: string,
    vmid: number,
    args: Record<string, unknown> = {},
    nodeInput?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; upid?: string }> {
    const node = nodeInput ?? (await this.getVmLocation(cluster, "qemu", vmid)).node!;
    const response = await this.proxmoxApiCall(
      { cluster, kind: "qemu_vm", node, vmid },
      "DELETE",
      `/nodes/${node}/qemu/${vmid}`,
      args,
      timeoutMs,
      signal,
    );
    this.resourceCache.delete(cluster);
    return response;
  }

  /** Provides a simpler node-only command runner while still preserving explicit high-risk semantics. */
  async nodeTerminalRun(
    cluster: string,
    node: string,
    input: {
      command: string;
      interpreter: "sh" | "bash" | "powershell" | "cmd";
      useSudo: boolean;
    },
    signal?: AbortSignal,
    onOutput?: (chunk: string) => void,
  ): Promise<CommandResult> {
    const target: TargetRef = { cluster, kind: "node", node };
    this.policies.assertShellAccess(target);
    if (input.useSudo) {
      this.policies.assertSudoAccess(target);
    }

    await this.audit.record({
      action: "proxmox_node_terminal_run",
      target,
      input,
    });

    const resolved = this.getNodeTarget(cluster, node);
    const command = buildLinuxShellCommand(input.interpreter === "bash" ? "bash" : "sh", input.command);
    const prefixed = input.useSudo ? `sudo -n ${command}` : command;
    return this.runSshCommand(resolved, prefixed, signal, onOutput);
  }

  /** Bootstraps first-time node access by installing an SSH public key and minting an API token. */
  async bootstrapNodeAccess(
    cluster: string,
    node: string,
    options: BootstrapNodeAccessOptions,
    signal?: AbortSignal,
  ): Promise<BootstrapNodeAccessResult> {
    const target: TargetRef = { cluster, kind: "node", node };

    await this.audit.record({
      action: "proxmox_bootstrap_node_access",
      target,
      options,
    });

    const result: BootstrapNodeAccessResult = {
      cluster,
      node,
      sshPublicKeyInstalled: false,
      tokenGenerated: false,
      tokenAuthActivated: false,
    };

    if (options.installSshPublicKey) {
      this.policies.assertShellAccess(target);
      this.policies.assertFileAccess(target, "write");
      await this.installNodePublicKey(cluster, node, signal);
      result.sshPublicKeyInstalled = true;
    }

    const userid = `${options.apiUser}@${options.apiRealm}`;
    const tokenPath = `/access/users/${encodeURIComponent(userid)}/token/${encodeURIComponent(options.tokenId)}`;
    const clusterTarget: TargetRef = { cluster, kind: "cluster" };

    if (options.replaceExistingToken) {
      try {
        await this.proxmoxApiCall(clusterTarget, "DELETE", tokenPath, {}, undefined, signal);
      } catch {
        // Best-effort cleanup when rotating an existing token.
      }
    }

    const tokenResponse = (await this.proxmoxApiCall(
      clusterTarget,
      "POST",
      tokenPath,
      {
        ...(options.comment ? { comment: options.comment } : {}),
        ...(options.expire !== undefined ? { expire: options.expire } : {}),
        privsep: options.privsep,
      },
      undefined,
      signal,
    )).data as {
      value: string;
      "full-tokenid": string;
      info?: {
        comment?: string;
        expire?: number;
        privsep?: boolean;
      };
    };

    result.tokenGenerated = true;
    result.tokenInfo = {
      user: options.apiUser,
      realm: options.apiRealm,
      tokenId: options.tokenId,
      fullTokenId: tokenResponse["full-tokenid"],
      value: tokenResponse.value,
      privsep: tokenResponse.info?.privsep ?? options.privsep,
      expire: tokenResponse.info?.expire,
      comment: tokenResponse.info?.comment,
    };

    if (options.activateApiToken) {
      this.setClusterAuth(cluster, {
        type: "api_token",
        user: options.apiUser,
        realm: options.apiRealm,
        tokenId: options.tokenId,
        secret: tokenResponse.value,
      });
      result.tokenAuthActivated = true;
    }

    return result;
  }

  /** Maps common node lifecycle verbs onto the documented Proxmox REST endpoints. */
  async nodeAction(cluster: string, node: string, action: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<{ data: unknown; upid?: string }> {
    const target: TargetRef = { cluster, kind: "node", node };
    const mapping: Record<string, { method: string; path: string; defaultArgs?: Record<string, unknown> }> = {
      reboot: { method: "POST", path: `/nodes/${node}/status`, defaultArgs: { command: "reboot" } },
      shutdown: { method: "POST", path: `/nodes/${node}/status`, defaultArgs: { command: "shutdown" } },
      wakeonlan: { method: "POST", path: `/nodes/${node}/wakeonlan` },
      startall: { method: "POST", path: `/nodes/${node}/startall` },
      stopall: { method: "POST", path: `/nodes/${node}/stopall` },
      suspendall: { method: "POST", path: `/nodes/${node}/suspendall` },
      migrateall: { method: "POST", path: `/nodes/${node}/migrateall` },
    };

    const mapped = mapping[action];
    if (!mapped) {
      throw new Error(`Unsupported node action '${action}'`);
    }

    return this.proxmoxApiCall(target, mapped.method, mapped.path, { ...(mapped.defaultArgs ?? {}), ...args }, timeoutMs, signal);
  }

  /** Runs a documented QEMU lifecycle action and returns data plus optional UPID. */
  async vmAction(cluster: string, vmid: number, action: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<{ data: unknown; upid?: string }> {
    const location = await this.getVmLocation(cluster, "qemu", vmid);
    const target: TargetRef = { cluster, kind: "qemu_vm", vmid, node: location.node };
    const path = `/nodes/${location.node}/qemu/${vmid}/status/${action}`;
    return this.proxmoxApiCall(target, "POST", path, args, timeoutMs, signal);
  }

  /** Runs a documented LXC lifecycle action and returns data plus optional UPID. */
  async lxcAction(cluster: string, vmid: number, action: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<{ data: unknown; upid?: string }> {
    const location = await this.getVmLocation(cluster, "lxc", vmid);
    const target: TargetRef = { cluster, kind: "lxc_container", vmid, node: location.node };
    const path = `/nodes/${location.node}/lxc/${vmid}/status/${action}`;
    return this.proxmoxApiCall(target, "POST", path, args, timeoutMs, signal);
  }

  /** Requests a shell or VNC console proxy ticket for a supported target type. */
  async consoleTicket(cluster: string, targetKind: TargetKind, node: string | undefined, vmid: number | undefined, scope: ConsoleScope): Promise<unknown> {
    if (targetKind === "node" && node) {
      return this.proxmoxApiCall({ cluster, kind: "node", node }, "POST", scope === "vnc" ? `/nodes/${node}/vncshell` : `/nodes/${node}/termproxy`, {});
    }

    if (targetKind === "qemu_vm" && node && vmid !== undefined) {
      return this.proxmoxApiCall({ cluster, kind: "qemu_vm", node, vmid }, "POST", `/nodes/${node}/qemu/${vmid}/${scope === "vnc" ? "vncproxy" : "termproxy"}`, {});
    }

    if (targetKind === "lxc_container" && node && vmid !== undefined) {
      return this.proxmoxApiCall({ cluster, kind: "lxc_container", node, vmid }, "POST", `/nodes/${node}/lxc/${vmid}/${scope === "vnc" ? "vncproxy" : "termproxy"}`, {});
    }

    throw new Error("Unsupported console target");
  }
}
