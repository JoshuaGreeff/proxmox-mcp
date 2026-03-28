import fs from "node:fs/promises";
import path from "node:path";
import { fetch as undiciFetch } from "undici";
import { normalizeSecretDocument, type SecretDocument, type SecretRecord } from "./admin-secrets.js";
import type { RuntimeConfig, SshProfileConfig } from "./config.js";

export interface ApiTokenSecretRecord {
  user: string;
  realm: string;
  tokenId: string;
  secret: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface ShellSshSecretRecord {
  username: string;
  port?: number;
  privateKey?: string;
  privateKeyPath?: string;
  publicKey?: string;
  publicKeyPath?: string;
  passphrase?: string;
  expectedHostKey: string;
  hostKeyPolicy?: SshProfileConfig["hostKeyPolicy"];
  shell?: string;
  prefixCommand?: string[];
  createdAt?: string;
  expiresAt?: string;
}

export interface RuntimeSecretBundle {
  cluster: string;
  apiToken?: ApiTokenSecretRecord;
  shellSsh?: ShellSshSecretRecord;
  metadata?: Record<string, string>;
}

export interface SecretStoreClusterStatus {
  cluster: string;
  hasApiToken: boolean;
  hasShellSsh: boolean;
  metadata?: Record<string, string>;
}

export interface SecretStore {
  readonly type: string;
  supportsMutation(): boolean;
  getClusterSecrets(cluster: string): Promise<RuntimeSecretBundle | undefined>;
  putClusterSecrets(cluster: string, bundle: RuntimeSecretBundle): Promise<void>;
  deleteClusterSecrets(cluster: string): Promise<void>;
  getClusterStatus(cluster: string): Promise<SecretStoreClusterStatus>;
}

function envBool(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolveEnvCluster(config: RuntimeConfig, cluster: string): string {
  if (config.clusterMap.has(cluster)) {
    return cluster;
  }

  if (config.clusters.length === 1) {
    return config.clusters[0]!.name;
  }

  return cluster;
}

class EnvSecretStore implements SecretStore {
  readonly type = "env";

  constructor(private readonly config: RuntimeConfig) {}

  supportsMutation(): boolean {
    return false;
  }

  async getClusterSecrets(cluster: string): Promise<RuntimeSecretBundle | undefined> {
    const resolvedCluster = resolveEnvCluster(this.config, cluster);
    const documentJson = process.env.PROXMOX_MCP_SECRETS_JSON;
    if (documentJson?.trim()) {
      return bundleFromUnknownDocument(resolvedCluster, JSON.parse(documentJson));
    }

    const apiUser = process.env.PROXMOX_API_TOKEN_USER?.trim();
    const apiSecret = process.env.PROXMOX_API_TOKEN_SECRET;
    const shellUsername = process.env.PROXMOX_SHELL_SSH_USERNAME?.trim();
    const shellExpectedHostKey = process.env.PROXMOX_SHELL_SSH_EXPECTED_HOST_KEY?.trim();

    const bundle: RuntimeSecretBundle = { cluster: resolvedCluster };

    if (apiUser && apiSecret) {
      bundle.apiToken = {
        user: apiUser,
        realm: process.env.PROXMOX_API_TOKEN_REALM?.trim() || "pam",
        tokenId: process.env.PROXMOX_API_TOKEN_ID?.trim() || "proxmox-mcp",
        secret: apiSecret,
        expiresAt: process.env.PROXMOX_API_TOKEN_EXPIRES_AT?.trim() || undefined,
      };
    }

    if (shellUsername && shellExpectedHostKey) {
      bundle.shellSsh = {
        username: shellUsername,
        port: process.env.PROXMOX_SHELL_SSH_PORT ? Number.parseInt(process.env.PROXMOX_SHELL_SSH_PORT, 10) : undefined,
        privateKey: process.env.PROXMOX_SHELL_SSH_PRIVATE_KEY,
        privateKeyPath: process.env.PROXMOX_SHELL_SSH_PRIVATE_KEY_PATH?.trim() || undefined,
        publicKey: process.env.PROXMOX_SHELL_SSH_PUBLIC_KEY,
        publicKeyPath: process.env.PROXMOX_SHELL_SSH_PUBLIC_KEY_PATH?.trim() || undefined,
        passphrase: process.env.PROXMOX_SHELL_SSH_PASSPHRASE,
        expectedHostKey: shellExpectedHostKey,
        hostKeyPolicy: (process.env.PROXMOX_SHELL_SSH_HOST_KEY_POLICY?.trim() as SshProfileConfig["hostKeyPolicy"] | undefined) ?? "strict",
        shell: process.env.PROXMOX_SHELL_SSH_SHELL?.trim() || undefined,
        prefixCommand: process.env.PROXMOX_SHELL_SSH_PREFIX_COMMAND
          ?.split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        expiresAt: process.env.PROXMOX_SHELL_SSH_EXPIRES_AT?.trim() || undefined,
      };
    }

    if (!bundle.apiToken && !bundle.shellSsh) {
      return undefined;
    }

    return bundle;
  }

  async putClusterSecrets(): Promise<void> {
    throw new Error("env secret backend is read-only");
  }

  async deleteClusterSecrets(): Promise<void> {
    throw new Error("env secret backend is read-only");
  }

  async getClusterStatus(cluster: string): Promise<SecretStoreClusterStatus> {
    const bundle = await this.getClusterSecrets(cluster);
    return {
      cluster: resolveEnvCluster(this.config, cluster),
      hasApiToken: bundle?.apiToken !== undefined,
      hasShellSsh: bundle?.shellSsh !== undefined,
      metadata: bundle?.metadata,
    };
  }
}

interface FileSecretDocument {
  version: 1;
  clusters: Record<string, RuntimeSecretBundle>;
}

function latestActiveRecord(records: SecretRecord[], kind: SecretRecord["kind"], cluster: string): SecretRecord | undefined {
  return records
    .filter((record) => record.kind === kind && record.metadata?.cluster === cluster && record.metadata?.lifecycle !== "retired")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function bundleFromAdminSecretDocument(document: SecretDocument, cluster: string): RuntimeSecretBundle | undefined {
  const bundle: RuntimeSecretBundle = { cluster };
  const apiToken = latestActiveRecord(document.records, "proxmox_api_token", cluster);
  const shellKey = latestActiveRecord(document.records, "shell_ssh_key", cluster);

  if (apiToken?.kind === "proxmox_api_token") {
    bundle.apiToken = {
      user: apiToken.user,
      realm: apiToken.realm,
      tokenId: apiToken.tokenId,
      secret: apiToken.secret,
      createdAt: apiToken.createdAt,
      expiresAt: apiToken.expireAt,
    };
  }

  if (shellKey?.kind === "shell_ssh_key" && typeof shellKey.metadata?.expectedHostKey === "string") {
    bundle.shellSsh = {
      username: shellKey.username,
      privateKey: shellKey.privateKey,
      publicKey: shellKey.publicKey,
      passphrase: shellKey.passphrase,
      expectedHostKey: shellKey.metadata.expectedHostKey,
      hostKeyPolicy: (typeof shellKey.metadata.hostKeyPolicy === "string" ? shellKey.metadata.hostKeyPolicy : "strict") as SshProfileConfig["hostKeyPolicy"],
      createdAt: shellKey.createdAt,
    };
  }

  return bundle.apiToken || bundle.shellSsh ? bundle : undefined;
}

function bundleFromUnknownDocument(cluster: string, value: unknown): RuntimeSecretBundle | undefined {
  if (value && typeof value === "object" && "records" in (value as Record<string, unknown>)) {
    return bundleFromAdminSecretDocument(normalizeSecretDocument(value), cluster);
  }

  const parsed = value as Partial<FileSecretDocument>;
  return parsed.clusters?.[cluster];
}

async function readJsonFile(filePath: string): Promise<FileSecretDocument> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<FileSecretDocument>;
    return {
      version: 1,
      clusters: parsed.clusters ?? {},
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/i.test(message)) {
      return {
        version: 1,
        clusters: {},
      };
    }
    throw error;
  }
}

class FileSecretStore implements SecretStore {
  readonly type = "file";

  constructor(private readonly filePath: string) {}

  supportsMutation(): boolean {
    return true;
  }

  private async writeDocument(document: FileSecretDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  async getClusterSecrets(cluster: string): Promise<RuntimeSecretBundle | undefined> {
    const raw = await fs.readFile(this.filePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    });

    if (!raw) {
      return undefined;
    }

    return bundleFromUnknownDocument(cluster, JSON.parse(raw));
  }

  async putClusterSecrets(cluster: string, bundle: RuntimeSecretBundle): Promise<void> {
    const document = await readJsonFile(this.filePath);
    document.clusters[cluster] = bundle;
    await this.writeDocument(document);
  }

  async deleteClusterSecrets(cluster: string): Promise<void> {
    const document = await readJsonFile(this.filePath);
    delete document.clusters[cluster];
    await this.writeDocument(document);
  }

  async getClusterStatus(cluster: string): Promise<SecretStoreClusterStatus> {
    const bundle = await this.getClusterSecrets(cluster);
    return {
      cluster,
      hasApiToken: bundle?.apiToken !== undefined,
      hasShellSsh: bundle?.shellSsh !== undefined,
      metadata: bundle?.metadata,
    };
  }
}

class VaultSecretStore implements SecretStore {
  readonly type = "vault";

  constructor(
    private readonly address: string,
    private readonly secretPath: string,
    private readonly token: string,
    private readonly namespace?: string,
    private readonly kvVersion: "v1" | "v2" = "v2",
  ) {}

  supportsMutation(): boolean {
    return true;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-vault-token": this.token,
      ...(this.namespace ? { "x-vault-namespace": this.namespace } : {}),
    };
  }

  private endpoint(cluster: string): string {
    const base = this.address.replace(/\/+$/, "");
    const cleanedPath = this.secretPath.replace(/^\/+|\/+$/g, "");
    if (this.kvVersion === "v2") {
      return `${base}/v1/${cleanedPath}/data/${encodeURIComponent(cluster)}`;
    }
    return `${base}/v1/${cleanedPath}/${encodeURIComponent(cluster)}`;
  }

  async getClusterSecrets(cluster: string): Promise<RuntimeSecretBundle | undefined> {
    const response = await undiciFetch(this.endpoint(cluster), {
      method: "GET",
      headers: this.headers(),
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Vault secret read failed for ${cluster}: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as { data?: unknown | { data?: unknown } };

    if (this.kvVersion === "v2") {
      return bundleFromUnknownDocument(cluster, payload.data && typeof payload.data === "object" && "data" in payload.data ? payload.data.data : undefined);
    }

    return bundleFromUnknownDocument(cluster, payload.data);
  }

  async putClusterSecrets(cluster: string, bundle: RuntimeSecretBundle): Promise<void> {
    const body = this.kvVersion === "v2" ? { data: bundle } : bundle;
    const response = await undiciFetch(this.endpoint(cluster), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Vault secret write failed for ${cluster}: ${response.status} ${await response.text()}`);
    }
  }

  async deleteClusterSecrets(cluster: string): Promise<void> {
    const response = await undiciFetch(this.endpoint(cluster), {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Vault secret delete failed for ${cluster}: ${response.status} ${await response.text()}`);
    }
  }

  async getClusterStatus(cluster: string): Promise<SecretStoreClusterStatus> {
    const bundle = await this.getClusterSecrets(cluster);
    return {
      cluster,
      hasApiToken: bundle?.apiToken !== undefined,
      hasShellSsh: bundle?.shellSsh !== undefined,
      metadata: bundle?.metadata,
    };
  }
}

export function createSecretStore(config: RuntimeConfig): SecretStore {
  switch (config.secretStore.type) {
    case "env":
      return new EnvSecretStore(config);
    case "file":
      return new FileSecretStore(config.secretStore.path);
    case "vault": {
      const token =
        config.secretStore.token ??
        process.env[config.secretStore.tokenEnvVar] ??
        process.env.VAULT_TOKEN;
      if (!token) {
        throw new Error(`Vault secret backend requires a token in ${config.secretStore.tokenEnvVar} or VAULT_TOKEN`);
      }
      return new VaultSecretStore(
        config.secretStore.address,
        config.secretStore.path,
        token,
        config.secretStore.namespace,
        config.secretStore.kvVersion,
      );
    }
    default:
      return exhaustiveSecretStore(config.secretStore);
  }
}

function exhaustiveSecretStore(_value: never): never {
  throw new Error("Unsupported secret backend");
}

export function secretStoreIsProductionReady(type: SecretStore["type"]): boolean {
  return type === "vault" || type === "file";
}

export function shellSecretConfigured(secret: RuntimeSecretBundle | undefined): boolean {
  if (!secret?.shellSsh) {
    return false;
  }

  return Boolean(secret.shellSsh.privateKey || secret.shellSsh.privateKeyPath) && Boolean(secret.shellSsh.expectedHostKey);
}

export function apiTokenConfigured(secret: RuntimeSecretBundle | undefined): boolean {
  return Boolean(secret?.apiToken?.user && secret.apiToken.realm && secret.apiToken.tokenId && secret.apiToken.secret);
}

export function inferSecretMetadata(bundle: RuntimeSecretBundle): Record<string, string> {
  return {
    cluster: bundle.cluster,
    hasApiToken: String(apiTokenConfigured(bundle)),
    hasShellSsh: String(shellSecretConfigured(bundle)),
    ...(bundle.metadata ?? {}),
  };
}
