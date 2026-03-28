import os from "node:os";
import { z } from "zod";
import type { TargetKind } from "./types.js";

const tlsSchema = z
  .object({
    rejectUnauthorized: z.boolean().default(true),
    caFile: z.string().optional(),
  })
  .default({ rejectUnauthorized: true });

const apiTokenAuthSchema = z.object({
  type: z.literal("api_token"),
  user: z.string().min(1),
  realm: z.string().min(1),
  tokenId: z.string().min(1),
  secret: z.string().min(1),
});

const ticketAuthSchema = z.object({
  type: z.literal("ticket"),
  username: z.string().min(1),
  password: z.string().min(1),
  realm: z.string().default("pam"),
  otp: z.string().optional(),
});

const secretRefAuthSchema = z.object({
  type: z.literal("secret_ref"),
  secretCluster: z.string().optional(),
});

const sshBootstrapAuthSchema = z.object({
  type: z.literal("ssh_bootstrap"),
  sshUsername: z.string().min(1),
  sshPassword: z.string().min(1),
  sshPort: z.number().int().positive().default(22),
  hostKeyPolicy: z.enum(["strict", "accept-new", "insecure"]).default("strict"),
  expectedHostKey: z.string().optional(),
  apiUser: z.string().default("root"),
  apiRealm: z.string().default("pam"),
  tokenId: z.string().default("proxmox-mcp"),
  comment: z.string().default("proxmox-mcp local bootstrap"),
  privsep: z.boolean().default(false),
});

const clusterNodeSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  sshProfile: z.string().min(1),
});

const authSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (!("type" in record) && typeof record.username === "string" && typeof record.password === "string") {
      return {
        type: "ssh_bootstrap",
        sshUsername: record.username,
        sshPassword: record.password,
        sshPort: record.sshPort,
        hostKeyPolicy: record.hostKeyPolicy,
        expectedHostKey: record.expectedHostKey,
        apiUser: record.apiUser,
        apiRealm: record.apiRealm,
        tokenId: record.tokenId,
        comment: record.comment,
        privsep: record.privsep,
      };
    }
  }

  return value;
}, z.discriminatedUnion("type", [apiTokenAuthSchema, ticketAuthSchema, secretRefAuthSchema, sshBootstrapAuthSchema]));

const rawClusterSchema = z
  .object({
    name: z.string().min(1).default("default"),
    host: z.string().min(1).optional(),
    apiPort: z.number().int().positive().default(8006),
    sshPort: z.number().int().positive().default(22),
    defaultNode: z.string().min(1).optional(),
    defaultBridge: z.string().min(1).default("vmbr0"),
    defaultVmStorage: z.string().min(1).optional(),
    defaultSnippetStorage: z.string().min(1).default("local"),
    apiUrl: z.string().url().optional(),
    auth: authSchema,
    tls: tlsSchema,
    nodes: z.array(clusterNodeSchema).default([]),
  })
  .superRefine((cluster, ctx) => {
    if (!cluster.apiUrl && !cluster.host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cluster config must include either apiUrl or host",
        path: ["apiUrl"],
      });
    }

    for (const [index, node] of cluster.nodes.entries()) {
      if (!node.host && !cluster.host) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Node host is required when cluster host is not set",
          path: ["nodes", index, "host"],
        });
      }
    }
  })
  .transform((cluster) => {
    const derivedHost = cluster.host ?? (cluster.apiUrl ? new URL(cluster.apiUrl).hostname : undefined);
    const apiUrl = cluster.apiUrl ?? `https://${derivedHost}:${cluster.apiPort}`;

    return {
      ...cluster,
      host: derivedHost ?? "",
      apiUrl,
      nodes: cluster.nodes.map((node) => ({
        ...node,
        host: node.host ?? derivedHost ?? "",
        port: node.port ?? cluster.sshPort,
      })),
    };
  });

const clusterSchema = rawClusterSchema;

const sshProfileSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  port: z.number().int().positive().default(22),
  privateKeyPath: z.string().optional(),
  privateKey: z.string().optional(),
  publicKeyPath: z.string().optional(),
  publicKey: z.string().optional(),
  passphrase: z.string().optional(),
  password: z.string().optional(),
  hostKeyPolicy: z.enum(["strict", "accept-new", "insecure"]).default("strict"),
  expectedHostKey: z.string().optional(),
  shell: z.string().default("/bin/sh"),
  prefixCommand: z.array(z.string()).default([]),
});

const winrmProfileSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  password: z.string().optional(),
  transport: z.enum(["default", "http", "https"]).default("default"),
  useSsl: z.boolean().default(false),
  skipCertificateChecks: z.boolean().default(false),
  powershellPath: z.string().default(process.platform === "win32" ? "powershell" : "pwsh"),
});

const linuxGuestSchema = z.object({
  name: z.string().min(1),
  cluster: z.string().min(1),
  kind: z.enum(["qemu_vm", "lxc_container"]),
  vmid: z.number().int().positive(),
  host: z.string().optional(),
  sshProfile: z.string().optional(),
});

const windowsGuestSchema = z.object({
  name: z.string().min(1),
  cluster: z.string().min(1),
  vmid: z.number().int().positive(),
  host: z.string().optional(),
  winrmProfile: z.string().optional(),
});

const policySchema = z.object({
  name: z.string().min(1),
  match: z
    .object({
      clusters: z.array(z.string()).optional(),
      targetKinds: z.array(z.string()).optional(),
      targetIds: z.array(z.string()).optional(),
      nodeNames: z.array(z.string()).optional(),
    })
    .default({}),
  allowApiRead: z.boolean().default(true),
  allowApiWrite: z.boolean().default(false),
  allowCliFamilies: z.array(z.string()).default([]),
  allowRawCli: z.boolean().default(false),
  allowShell: z.boolean().default(false),
  allowFileRead: z.boolean().default(false),
  allowFileWrite: z.boolean().default(false),
  allowSudo: z.boolean().default(false),
  maxTimeoutMs: z.number().int().positive().default(300_000),
});

const serverModeSchema = z.enum(["stdio", "http", "both"]).default("stdio");

const mcpAuthSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("oidc"),
    issuer: z.string().url(),
    audience: z.string().min(1),
    jwksUrl: z.string().url().optional(),
    resource: z.string().url().optional(),
  }),
]);

const httpServerSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().positive().default(8080),
  path: z.string().min(1).default("/mcp"),
  publicBaseUrl: z.string().url().optional(),
  stateless: z.boolean().default(false),
});

const secretStoreSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("env"),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("vault"),
    address: z.string().url(),
    path: z.string().min(1),
    token: z.string().optional(),
    tokenEnvVar: z.string().default("VAULT_TOKEN"),
    namespace: z.string().optional(),
    kvVersion: z.enum(["v1", "v2"]).default("v2"),
  }),
]);

const localBootstrapSchema = z.object({
  enabled: z.boolean().default(false),
  sshUsername: z.string().optional(),
  sshPassword: z.string().optional(),
  sshPort: z.number().int().positive().default(22),
  hostKeyPolicy: z.enum(["strict", "accept-new", "insecure"]).default("strict"),
  expectedHostKey: z.string().optional(),
  apiUser: z.string().default("root"),
  apiRealm: z.string().default("pam"),
  tokenId: z.string().default("proxmox-mcp"),
  comment: z.string().default("proxmox-mcp local bootstrap"),
  privsep: z.boolean().default(false),
});

const defaultAdminPolicy: PolicyConfig = {
  name: "default-maintainer",
  match: {
    clusters: ["*"],
    targetKinds: ["cluster", "node", "qemu_vm", "lxc_container", "linux_guest", "windows_guest"],
  },
  allowApiRead: true,
  allowApiWrite: true,
  allowCliFamilies: ["pvesh", "qm", "pct", "pvesm", "pveum", "pvenode", "pvecm", "pveceph", "pvesr", "vzdump", "apt"],
  allowRawCli: false,
  allowShell: true,
  allowFileRead: true,
  allowFileWrite: true,
  allowSudo: true,
  maxTimeoutMs: 300_000,
};

const defaultProductionPolicy: PolicyConfig = {
  name: "default-production",
  match: {
    clusters: ["*"],
    targetKinds: ["cluster", "node", "qemu_vm", "lxc_container", "linux_guest", "windows_guest"],
  },
  allowApiRead: true,
  allowApiWrite: true,
  allowCliFamilies: [],
  allowRawCli: false,
  allowShell: false,
  allowFileRead: false,
  allowFileWrite: false,
  allowSudo: false,
  maxTimeoutMs: 300_000,
};

/** Root runtime configuration schema for the MCP server. */
export const configSchema = z.object({
  mode: serverModeSchema,
  mcpAuth: mcpAuthSchema.default({ mode: "none" }),
  http: httpServerSchema.default(() => ({ host: "127.0.0.1", port: 8080, path: "/mcp", stateless: false })),
  secretStore: secretStoreSchema.default({ type: "env" }),
  localBootstrap: localBootstrapSchema.default(() => ({
    enabled: false,
    sshPort: 22,
    hostKeyPolicy: "strict" as const,
    apiUser: "root",
    apiRealm: "pam",
    tokenId: "proxmox-mcp",
    comment: "proxmox-mcp local bootstrap",
    privsep: false,
  })),
  escapeEnabled: z.boolean().default(false),
  clusters: z.array(clusterSchema).default([]),
  sshProfiles: z.array(sshProfileSchema).default([]),
  winrmProfiles: z.array(winrmProfileSchema).default([]),
  linuxGuests: z.array(linuxGuestSchema).default([]),
  windowsGuests: z.array(windowsGuestSchema).default([]),
  policies: z.array(policySchema).default([]),
  auditLogPath: z.string().default(".proxmox-mcp-audit.log"),
  inventoryCacheTtlMs: z.number().int().positive().default(10_000),
  defaultTimeoutMs: z.number().int().positive().default(120_000),
});

export type ProxmoxMcpConfig = z.infer<typeof configSchema>;
export type RemoteConnectConfig = ProxmoxMcpConfig;
export type ClusterConfig = RemoteConnectConfig["clusters"][number];
export type ClusterAuthConfig = ClusterConfig["auth"];
export type SshProfileConfig = RemoteConnectConfig["sshProfiles"][number];
export type WinRmProfileConfig = RemoteConnectConfig["winrmProfiles"][number];
export type LinuxGuestConfig = RemoteConnectConfig["linuxGuests"][number];
export type WindowsGuestConfig = RemoteConnectConfig["windowsGuests"][number];
export type PolicyConfig = RemoteConnectConfig["policies"][number];

/** Runtime config plus name-indexed lookups used heavily during request handling. */
export interface RuntimeConfig extends RemoteConnectConfig {
  configPath: string;
  clusterMap: Map<string, ClusterConfig>;
  sshProfileMap: Map<string, SshProfileConfig>;
  winrmProfileMap: Map<string, WinRmProfileConfig>;
}

/** Rebuilds the runtime lookup maps after in-memory config mutation. */
export function refreshRuntimeIndexes(config: RuntimeConfig): RuntimeConfig {
  config.clusterMap = new Map(config.clusters.map((cluster) => [cluster.name, cluster]));
  config.sshProfileMap = new Map(config.sshProfiles.map((profile) => [profile.name, profile]));
  config.winrmProfileMap = new Map(config.winrmProfiles.map((profile) => [profile.name, profile]));
  return config;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received '${value}'`);
  }

  return parsed;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function requiredHost(): string | undefined {
  return process.env.PROXMOX_HOST?.trim();
}

function buildPolicyDefaults(config: RemoteConnectConfig): PolicyConfig[] {
  if (config.policies.length > 0) {
    return config.policies;
  }

  if (config.mode === "stdio" && config.mcpAuth.mode === "none" && config.localBootstrap.enabled) {
    return [defaultAdminPolicy];
  }

  if (config.escapeEnabled) {
    return [
      {
        ...defaultProductionPolicy,
        name: "default-production-with-escape",
        allowCliFamilies: [...defaultAdminPolicy.allowCliFamilies],
        allowShell: true,
        allowFileRead: true,
        allowFileWrite: true,
        allowSudo: true,
      },
    ];
  }

  return [defaultProductionPolicy];
}

function applyRuntimeDefaults(config: RemoteConnectConfig): RemoteConnectConfig {
  return {
    ...config,
    policies: buildPolicyDefaults(config),
  };
}

function runtimeShellProfileName(clusterName: string): string {
  return `__runtime_shell_${clusterName}`;
}

function buildEnvOnlyConfig(): RemoteConnectConfig | undefined {
  const host = requiredHost();
  if (!host) {
    return undefined;
  }

  const mode = (process.env.PROXMOX_MCP_MODE?.trim() as RuntimeConfig["mode"] | undefined) ?? "stdio";
  const authMode = process.env.PROXMOX_MCP_AUTH_MODE?.trim() ?? "none";
  const apiPort = parseOptionalPositiveInt(process.env.PROXMOX_API_PORT) ?? 8006;
  const sshPort = parseOptionalPositiveInt(process.env.PROXMOX_SSH_PORT) ?? 22;
  const defaultNode = process.env.PROXMOX_DEFAULT_NODE?.trim() || undefined;
  const defaultBridge = process.env.PROXMOX_DEFAULT_BRIDGE?.trim() || "vmbr0";
  const defaultVmStorage = process.env.PROXMOX_DEFAULT_VM_STORAGE?.trim() || undefined;
  const defaultSnippetStorage = process.env.PROXMOX_DEFAULT_SNIPPET_STORAGE?.trim() || "local";
  const rejectUnauthorized = parseOptionalBoolean(process.env.PROXMOX_TLS_REJECT_UNAUTHORIZED) ?? false;
  const localBootstrapEnabled = parseOptionalBoolean(process.env.PROXMOX_MCP_LOCAL_BOOTSTRAP) ?? false;
  const escapeEnabled =
    parseOptionalBoolean(process.env.PROXMOX_MCP_ENABLE_ESCAPE) ??
    (mode === "stdio" && authMode === "none" && localBootstrapEnabled);
  const isLocalDevMode = mode === "stdio" && authMode === "none";
  const auditLogPath = process.env.PROXMOX_MCP_AUDIT_LOG_PATH?.trim() || (isLocalDevMode ? os.devNull : ".proxmox-mcp-audit.log");

  const secretStoreType = (process.env.PROXMOX_MCP_SECRET_BACKEND?.trim() as RemoteConnectConfig["secretStore"]["type"] | undefined) ?? "env";
  const secretStore =
    secretStoreType === "file"
      ? {
          type: "file" as const,
          path: process.env.PROXMOX_MCP_SECRET_FILE_PATH?.trim() || ".proxmox-mcp-secrets.json",
        }
      : secretStoreType === "vault"
        ? {
            type: "vault" as const,
            address: process.env.PROXMOX_MCP_SECRET_VAULT_ADDR?.trim() || "",
            path: process.env.PROXMOX_MCP_SECRET_VAULT_PATH?.trim() || "secret/proxmox-mcp",
            token: process.env.PROXMOX_MCP_SECRET_VAULT_TOKEN,
            tokenEnvVar: process.env.PROXMOX_MCP_SECRET_VAULT_TOKEN_ENV?.trim() || "VAULT_TOKEN",
            namespace: process.env.PROXMOX_MCP_SECRET_VAULT_NAMESPACE?.trim() || undefined,
            kvVersion: (process.env.PROXMOX_MCP_SECRET_VAULT_KV_VERSION?.trim() as "v1" | "v2" | undefined) ?? "v2",
          }
        : { type: "env" as const };

  const localBootstrap = {
    enabled: localBootstrapEnabled,
    sshUsername: process.env.PROXMOX_BOOTSTRAP_SSH_USERNAME?.trim() || process.env.PROXMOX_SSH_USERNAME?.trim() || undefined,
    sshPassword: process.env.PROXMOX_BOOTSTRAP_SSH_PASSWORD ?? process.env.PROXMOX_SSH_PASSWORD ?? undefined,
    sshPort,
    hostKeyPolicy: (process.env.PROXMOX_BOOTSTRAP_HOST_KEY_POLICY?.trim() as "strict" | "accept-new" | "insecure" | undefined) ?? "strict",
    expectedHostKey: process.env.PROXMOX_BOOTSTRAP_EXPECTED_HOST_KEY?.trim() || undefined,
    apiUser: process.env.PROXMOX_BOOTSTRAP_API_USER?.trim() || "root",
    apiRealm: process.env.PROXMOX_BOOTSTRAP_API_REALM?.trim() || "pam",
    tokenId: process.env.PROXMOX_BOOTSTRAP_TOKEN_ID?.trim() || "proxmox-mcp",
    comment: process.env.PROXMOX_BOOTSTRAP_COMMENT?.trim() || "proxmox-mcp local bootstrap",
    privsep: parseOptionalBoolean(process.env.PROXMOX_BOOTSTRAP_PRIVSEP) ?? false,
  };

  const mcpAuth =
    authMode === "oidc"
      ? {
          mode: "oidc" as const,
          issuer: process.env.PROXMOX_MCP_OIDC_ISSUER?.trim() || "",
          audience: process.env.PROXMOX_MCP_OIDC_AUDIENCE?.trim() || "",
          jwksUrl: process.env.PROXMOX_MCP_OIDC_JWKS_URL?.trim() || undefined,
          resource: process.env.PROXMOX_MCP_OIDC_RESOURCE?.trim() || undefined,
        }
      : { mode: "none" as const };

  const clusterName = "default";
  const sshProfile = runtimeShellProfileName(clusterName);

  return {
    mode,
    mcpAuth,
    http: {
      host: process.env.PROXMOX_MCP_HTTP_HOST?.trim() || "127.0.0.1",
      port: parseOptionalPositiveInt(process.env.PROXMOX_MCP_HTTP_PORT) ?? 8080,
      path: process.env.PROXMOX_MCP_HTTP_PATH?.trim() || "/mcp",
      publicBaseUrl: process.env.PROXMOX_MCP_HTTP_PUBLIC_BASE_URL?.trim() || undefined,
      stateless: parseOptionalBoolean(process.env.PROXMOX_MCP_HTTP_STATELESS) ?? false,
    },
    secretStore,
    localBootstrap,
    escapeEnabled,
    clusters: [
      {
        name: clusterName,
        host,
        apiUrl: `https://${host}:${apiPort}`,
        apiPort,
        sshPort,
        defaultNode,
        defaultBridge,
        defaultVmStorage,
        defaultSnippetStorage,
        auth: localBootstrap.enabled
          ? {
              type: "ssh_bootstrap" as const,
              sshUsername: localBootstrap.sshUsername ?? "",
              sshPassword: localBootstrap.sshPassword ?? "",
              sshPort: localBootstrap.sshPort,
              hostKeyPolicy: localBootstrap.hostKeyPolicy,
              expectedHostKey: localBootstrap.expectedHostKey,
              apiUser: localBootstrap.apiUser,
              apiRealm: localBootstrap.apiRealm,
              tokenId: localBootstrap.tokenId,
              comment: localBootstrap.comment,
              privsep: localBootstrap.privsep,
            }
          : {
              type: "secret_ref" as const,
              secretCluster: clusterName,
            },
        tls: {
          rejectUnauthorized,
          caFile: process.env.PROXMOX_TLS_CA_FILE?.trim() || undefined,
        },
        nodes: defaultNode
          ? [
              {
                name: defaultNode,
                host,
                port: sshPort,
                sshProfile,
              },
            ]
          : [],
      },
    ],
    sshProfiles: [],
    winrmProfiles: [],
    linuxGuests: [],
    windowsGuests: [],
    policies: [],
    auditLogPath,
    inventoryCacheTtlMs: 15_000,
    defaultTimeoutMs: 60_000,
  };
}

/**
 * Loads, validates, and indexes the runtime config from process env only.
 *
 * Public startup config is intentionally limited to the MCP client's env block.
 * File-based runtime config is no longer supported.
 */
export function loadConfig(): RuntimeConfig {
  const envOnlyConfig = buildEnvOnlyConfig();
  if (!envOnlyConfig) {
    throw new Error(
      "Missing required MCP env config. Set PROXMOX_HOST and choose either steady-state secrets (for example PROXMOX_API_TOKEN_*) or explicit local bootstrap envs in your client config.",
    );
  }

  const hydrated = applyRuntimeDefaults(configSchema.parse(envOnlyConfig));

  if (
    hydrated.mode !== "stdio" &&
    hydrated.mcpAuth.mode === "none"
  ) {
    throw new Error("HTTP mode requires PROXMOX_MCP_AUTH_MODE=oidc or explicit local stdio-only mode.");
  }

  if (hydrated.mcpAuth.mode === "oidc" && (!hydrated.mcpAuth.issuer || !hydrated.mcpAuth.audience)) {
    throw new Error("OIDC auth requires PROXMOX_MCP_OIDC_ISSUER and PROXMOX_MCP_OIDC_AUDIENCE.");
  }

  if (hydrated.secretStore.type === "vault" && !hydrated.secretStore.address) {
    throw new Error("Vault secret backend requires PROXMOX_MCP_SECRET_VAULT_ADDR.");
  }

  if (hydrated.localBootstrap.enabled && (!hydrated.localBootstrap.sshUsername || !hydrated.localBootstrap.sshPassword)) {
    throw new Error("Local bootstrap mode requires PROXMOX_BOOTSTRAP_SSH_USERNAME/PROXMOX_BOOTSTRAP_SSH_PASSWORD or legacy PROXMOX_SSH_USERNAME/PROXMOX_SSH_PASSWORD.");
  }

  return refreshRuntimeIndexes({
    ...hydrated,
    configPath: "[env]",
    clusterMap: new Map(),
    sshProfileMap: new Map(),
    winrmProfileMap: new Map(),
  });
}

export function runtimeShellProfileForCluster(clusterName: string): string {
  return runtimeShellProfileName(clusterName);
}

/** Normalizes the target identifier format used by policy matching. */
export function targetIdForPolicy(kind: TargetKind, node?: string, vmid?: number): string {
  if (kind === "node") {
    return node ?? "*";
  }

  if (vmid !== undefined) {
    return String(vmid);
  }

  return kind;
}
