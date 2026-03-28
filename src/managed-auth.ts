import crypto from "node:crypto";
import type { ClusterConfig, RuntimeConfig, SshProfileConfig } from "./config.js";
import { refreshRuntimeIndexes } from "./config.js";
import { AuditLogger } from "./policy.js";
import { SshExecutor } from "./ssh.js";
import { shellQuote } from "./utils.js";

const DEFAULT_MANAGED_USERNAME = "mcp";
const DEFAULT_MANAGED_REALM = "pam";
const DEFAULT_MANAGED_TOKEN_ID = "mcp";
const DEFAULT_MANAGED_PASSWORD_LENGTH = 32;
const DEFAULT_ROTATION_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_TOKEN_EXPIRE_SECONDS = 20 * 60;
const ROTATION_SAFETY_WINDOW_MS = 30 * 1000;

interface ManagedBootstrapSpec {
  clusterName: string;
  host: string;
  sshPort: number;
  username: string;
  password: string;
  hostKeyPolicy: SshProfileConfig["hostKeyPolicy"];
  expectedHostKey?: string;
}

interface ManagedAuthRuntimeState {
  bootstrap: ManagedBootstrapSpec;
  nodeName?: string;
  currentPassword?: string;
  currentToken?: string;
  lastReconciledAt?: string;
  passwordExpiresAt?: number;
  tokenExpiresAt?: number;
  bootstrapMode?: "root" | "sudo";
  repairPromise?: Promise<void>;
  rotationTimer?: NodeJS.Timeout;
}

interface BootstrapResult {
  node: string;
  fullTokenId: string;
  value: string;
  expire: number;
  sudoAvailable: boolean;
}

/**
 * Owns the hidden runtime credentials used after the user's bootstrap SSH login succeeds.
 *
 * The MCP config continues to hold only bootstrap credentials. This manager converges the
 * host into a managed `mcp` account, keeps the token and password only in RAM, rotates
 * them on a timer, and repairs drift transparently when possible.
 *
 * The API plane switches to `mcp@pam`, but node-local SSH stays on the bootstrap profile
 * for now because the current typed node workflows still assume root-capable SSH.
 */
export class ManagedAuthLifecycle {
  private readonly sshExecutor = new SshExecutor();
  private readonly managedClusters = new Map<string, ManagedAuthRuntimeState>();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly audit = new AuditLogger(config.auditLogPath),
  ) {
    for (const cluster of config.clusters) {
      if (cluster.auth.type !== "ssh_bootstrap") {
        continue;
      }

      this.managedClusters.set(cluster.name, {
        bootstrap: {
          clusterName: cluster.name,
          host: cluster.host,
          sshPort: cluster.auth.sshPort,
          username: cluster.auth.sshUsername,
          password: cluster.auth.sshPassword,
          hostKeyPolicy: cluster.auth.hostKeyPolicy,
          expectedHostKey: cluster.auth.expectedHostKey,
        },
      });
    }
  }

  private resolveManagedClusterName(clusterName: string): string | undefined {
    if (this.managedClusters.has(clusterName)) {
      return clusterName;
    }

    if (this.managedClusters.size === 1) {
      return [...this.managedClusters.keys()][0];
    }

    return undefined;
  }

  /** True when the cluster uses the managed auth lifecycle instead of static API credentials. */
  hasManagedCluster(clusterName: string): boolean {
    return this.resolveManagedClusterName(clusterName) !== undefined;
  }

  /** Exposes redacted runtime state for tests and diagnostics without leaking secrets. */
  getStateSnapshot(clusterName: string): Omit<ManagedAuthRuntimeState, "currentPassword" | "currentToken" | "repairPromise" | "rotationTimer" | "bootstrap"> & {
    bootstrapUsername: string;
    bootstrapHost: string;
  } | undefined {
    const state = this.managedClusters.get(clusterName);
    if (!state) {
      return undefined;
    }

    return {
      nodeName: state.nodeName,
      lastReconciledAt: state.lastReconciledAt,
      passwordExpiresAt: state.passwordExpiresAt,
      tokenExpiresAt: state.tokenExpiresAt,
      bootstrapMode: state.bootstrapMode,
      bootstrapUsername: state.bootstrap.username,
      bootstrapHost: state.bootstrap.host,
    };
  }

  /** Performs startup reconciliation for every cluster using bootstrap credentials. */
  async initialize(): Promise<RuntimeConfig> {
    for (const clusterName of this.managedClusters.keys()) {
      await this.repairCluster(clusterName, "startup");
    }

    return refreshRuntimeIndexes(this.config);
  }

  /** Refreshes a managed cluster when the timer says credentials are about to expire. */
  async ensureCluster(clusterName: string): Promise<void> {
    const resolvedClusterName = this.resolveManagedClusterName(clusterName);
    const state = resolvedClusterName ? this.managedClusters.get(resolvedClusterName) : undefined;
    if (!state) {
      return;
    }

    if (state.repairPromise) {
      await state.repairPromise;
      return;
    }

    const deadline = Math.min(state.passwordExpiresAt ?? Number.MAX_SAFE_INTEGER, state.tokenExpiresAt ?? Number.MAX_SAFE_INTEGER);
    if (Date.now() + ROTATION_SAFETY_WINDOW_MS < deadline) {
      return;
    }

    await this.repairCluster(resolvedClusterName!, "scheduled_rotation");
  }

  /** Repairs or rotates a managed cluster, serializing concurrent callers onto one reconcile pass. */
  async repairCluster(clusterName: string, reason: string): Promise<void> {
    const resolvedClusterName = this.resolveManagedClusterName(clusterName);
    const state = resolvedClusterName ? this.managedClusters.get(resolvedClusterName) : undefined;
    if (!state) {
      return;
    }

    if (state.repairPromise) {
      await state.repairPromise;
      return;
    }

    state.repairPromise = this.reconcileCluster(resolvedClusterName!, reason).finally(() => {
      const latest = this.managedClusters.get(resolvedClusterName!);
      if (latest) {
        latest.repairPromise = undefined;
      }
    });

    await state.repairPromise;
  }

  private buildBootstrapProfile(state: ManagedAuthRuntimeState): SshProfileConfig {
    return {
      name: `__bootstrap_${state.bootstrap.clusterName}`,
      username: state.bootstrap.username,
      password: state.bootstrap.password,
      port: state.bootstrap.sshPort,
      hostKeyPolicy: state.bootstrap.hostKeyPolicy,
      expectedHostKey: state.bootstrap.expectedHostKey,
      shell: "/bin/sh",
      prefixCommand: [],
    };
  }

  private buildManagedProfile(clusterName: string, password: string, port: number, hostKeyPolicy: SshProfileConfig["hostKeyPolicy"], expectedHostKey?: string): SshProfileConfig {
    return {
      name: `__managed_${clusterName}`,
      username: DEFAULT_MANAGED_USERNAME,
      password,
      port,
      hostKeyPolicy,
      expectedHostKey,
      shell: "/bin/sh",
      prefixCommand: [],
    };
  }

  private upsertProfile(profile: SshProfileConfig): void {
    const profileIndex = this.config.sshProfiles.findIndex((entry) => entry.name === profile.name);
    if (profileIndex >= 0) {
      this.config.sshProfiles[profileIndex] = profile;
    } else {
      this.config.sshProfiles.push(profile);
    }
  }

  private generatePassword(length = DEFAULT_MANAGED_PASSWORD_LENGTH): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+[]{}:,.?";
    let result = "";
    for (let index = 0; index < length; index += 1) {
      result += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return result;
  }

  private async execBootstrapRaw(state: ManagedAuthRuntimeState, command: string): Promise<string> {
    const result = await this.sshExecutor.exec(
      {
        host: state.bootstrap.host,
        port: state.bootstrap.sshPort,
        profile: this.buildBootstrapProfile(state),
      },
      command,
    );

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Bootstrap SSH command failed for cluster ${state.bootstrap.clusterName}`);
    }

    return result.stdout.trim();
  }

  private async detectBootstrapMode(state: ManagedAuthRuntimeState): Promise<"root" | "sudo"> {
    if (state.bootstrapMode) {
      return state.bootstrapMode;
    }

    const direct = await this.execBootstrapRaw(state, "/bin/sh -lc 'id -u'");
    if (direct.trim() === "0") {
      state.bootstrapMode = "root";
      return state.bootstrapMode;
    }

    const sudoCheck = await this.execBootstrapRaw(
      state,
      `/bin/sh -lc ${shellQuote(`printf '%s\\n' ${shellQuote(state.bootstrap.password)} | sudo -S -p '' id -u`)}`,
    );

    if (sudoCheck.trim() !== "0") {
      throw new Error(`Bootstrap account for cluster ${state.bootstrap.clusterName} does not have root or password-based sudo access`);
    }

    state.bootstrapMode = "sudo";
    return state.bootstrapMode;
  }

  private async runBootstrapScript(state: ManagedAuthRuntimeState, script: string): Promise<string> {
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const body = `printf %s ${shellQuote(encoded)} | base64 -d | bash`;
    const mode = await this.detectBootstrapMode(state);

    if (mode === "root") {
      return this.execBootstrapRaw(state, `/bin/sh -lc ${shellQuote(body)}`);
    }

    return this.execBootstrapRaw(
      state,
      `/bin/sh -lc ${shellQuote(`printf '%s\\n' ${shellQuote(state.bootstrap.password)} | sudo -S -p '' /bin/bash -lc ${shellQuote(body)}`)}`,
    );
  }

  private buildReconcileScript(password: string, tokenExpireSeconds: number): string {
    const expire = Math.floor(Date.now() / 1000) + tokenExpireSeconds;
    return [
      "set -euo pipefail",
      `managed_user=${shellQuote(DEFAULT_MANAGED_USERNAME)}`,
      `managed_password=${shellQuote(password)}`,
      `managed_userid=${shellQuote(`${DEFAULT_MANAGED_USERNAME}@${DEFAULT_MANAGED_REALM}`)}`,
      `managed_token_id=${shellQuote(DEFAULT_MANAGED_TOKEN_ID)}`,
      `managed_comment=${shellQuote("proxmox-mcp managed auth lifecycle")}`,
      `managed_expire=${shellQuote(String(expire))}`,
      "node_name=$(hostname -s 2>/dev/null || hostname)",
      "if ! id -u \"$managed_user\" >/dev/null 2>&1; then useradd -m -s /bin/bash \"$managed_user\"; fi",
      "printf '%s:%s\\n' \"$managed_user\" \"$managed_password\" | chpasswd",
      "install -d -m 0755 /etc/sudoers.d",
      "cat > /etc/sudoers.d/proxmox-mcp-mcp <<'EOF'",
      `${DEFAULT_MANAGED_USERNAME} ALL=(ALL) NOPASSWD:ALL`,
      "EOF",
      "chmod 0440 /etc/sudoers.d/proxmox-mcp-mcp",
      "sudo_available=0",
      "if command -v sudo >/dev/null 2>&1; then sudo_available=1; fi",
      "if command -v visudo >/dev/null 2>&1; then visudo -cf /etc/sudoers.d/proxmox-mcp-mcp >/dev/null; fi",
      "pveum user add \"$managed_userid\" --comment \"$managed_comment\" >/dev/null 2>&1 || true",
      "pveum user modify \"$managed_userid\" --enable 1 --comment \"$managed_comment\" >/dev/null 2>&1 || true",
      "pveum acl modify / --users \"$managed_userid\" --roles Administrator >/dev/null",
      "pveum user token delete \"$managed_userid\" \"$managed_token_id\" >/dev/null 2>&1 || true",
      "token_json=$(pveum user token add \"$managed_userid\" \"$managed_token_id\" --comment \"$managed_comment\" --privsep 0 --expire \"$managed_expire\" --output-format json)",
      "export TOKEN_JSON=\"$token_json\"",
      "export NODE_NAME=\"$node_name\"",
      "export SUDO_AVAILABLE=\"$sudo_available\"",
      "python3 - <<'PY'",
      "import json, os",
      "token = json.loads(os.environ['TOKEN_JSON'])",
      "print(json.dumps({",
      "  'node': os.environ['NODE_NAME'],",
      "  'fullTokenId': token['full-tokenid'],",
      "  'value': token['value'],",
      `  'expire': ${expire},`,
      "  'sudoAvailable': os.environ.get('SUDO_AVAILABLE', '0') == '1',",
      "}))",
      "PY",
    ].join("\n");
  }

  private upsertRuntimeProfiles(state: ManagedAuthRuntimeState, password: string, nodeName: string): void {
    const cluster = this.config.clusterMap.get(state.bootstrap.clusterName);
    if (!cluster) {
      throw new Error(`Unknown cluster '${state.bootstrap.clusterName}'`);
    }

    const managedProfile = this.buildManagedProfile(
      state.bootstrap.clusterName,
      password,
      state.bootstrap.sshPort,
      state.bootstrap.hostKeyPolicy,
      state.bootstrap.expectedHostKey,
    );
    const bootstrapProfile = this.buildBootstrapProfile(state);
    this.upsertProfile(managedProfile);
    this.upsertProfile(bootstrapProfile);

    const nodeEntry = {
      name: nodeName,
      host: state.bootstrap.host,
      port: state.bootstrap.sshPort,
      sshProfile: bootstrapProfile.name,
    };
    const nodeIndex = cluster.nodes.findIndex((entry) => entry.name === nodeName);
    if (nodeIndex >= 0) {
      cluster.nodes[nodeIndex] = nodeEntry;
    } else {
      cluster.nodes.push(nodeEntry);
    }

    if (!cluster.defaultNode) {
      cluster.defaultNode = nodeName;
    }
  }

  private scheduleRotation(clusterName: string, intervalMs: number): void {
    const state = this.managedClusters.get(clusterName);
    if (!state) {
      return;
    }

    if (state.rotationTimer) {
      clearTimeout(state.rotationTimer);
    }

    state.rotationTimer = setTimeout(() => {
      void this.repairCluster(clusterName, "timer_rotation").catch(() => {
        // The next request path will surface the failure with a more contextual error.
      });
    }, intervalMs);
    state.rotationTimer.unref?.();
  }

  private async reconcileCluster(clusterName: string, reason: string): Promise<void> {
    const state = this.managedClusters.get(clusterName);
    const cluster = this.config.clusterMap.get(clusterName);
    if (!state || !cluster) {
      throw new Error(`Unknown managed cluster '${clusterName}'`);
    }

    const managedPassword = this.generatePassword();
    await this.audit.record({
      action: "managed_auth_reconcile",
      cluster: clusterName,
      reason,
      bootstrapUsername: state.bootstrap.username,
      managedUser: `${DEFAULT_MANAGED_USERNAME}@${DEFAULT_MANAGED_REALM}`,
      tokenId: DEFAULT_MANAGED_TOKEN_ID,
    });

    const stdout = await this.runBootstrapScript(state, this.buildReconcileScript(managedPassword, DEFAULT_TOKEN_EXPIRE_SECONDS));
    const parsed = JSON.parse(stdout) as BootstrapResult;

    state.nodeName = parsed.node;
    state.currentPassword = managedPassword;
    state.currentToken = parsed.value;
    state.lastReconciledAt = new Date().toISOString();
    state.passwordExpiresAt = Date.now() + DEFAULT_ROTATION_INTERVAL_MS;
    state.tokenExpiresAt = parsed.expire * 1000;

    cluster.auth = {
      type: "api_token",
      user: DEFAULT_MANAGED_USERNAME,
      realm: DEFAULT_MANAGED_REALM,
      tokenId: DEFAULT_MANAGED_TOKEN_ID,
      secret: parsed.value,
    };

    this.upsertRuntimeProfiles(state, managedPassword, parsed.node);
    refreshRuntimeIndexes(this.config);
    this.scheduleRotation(clusterName, DEFAULT_ROTATION_INTERVAL_MS);
  }
}
