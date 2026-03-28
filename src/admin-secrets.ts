import fs from "node:fs/promises";
import path from "node:path";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { nowIso } from "./utils.js";

export type SecretKind = "proxmox_api_token" | "shell_ssh_key" | "shell_ssh_reference";

export interface SecretMetadata {
  cluster?: string;
  node?: string;
  reference?: string;
  profileVersion?: string;
  note?: string;
  lifecycle?: "active" | "pending" | "retired";
  [key: string]: unknown;
}

export interface SecretRecordBase {
  id: string;
  kind: SecretKind;
  createdAt: string;
  updatedAt: string;
  metadata?: SecretMetadata;
}

export interface ProxmoxApiTokenSecretRecord extends SecretRecordBase {
  kind: "proxmox_api_token";
  user: string;
  realm: string;
  tokenId: string;
  secret: string;
  comment?: string;
  expireAt?: string;
}

export interface ShellSshKeySecretRecord extends SecretRecordBase {
  kind: "shell_ssh_key";
  username: string;
  privateKey: string;
  publicKey: string;
  passphrase?: string;
}

export interface ShellSshReferenceSecretRecord extends SecretRecordBase {
  kind: "shell_ssh_reference";
  username: string;
  reference: string;
}

export type SecretRecord = ProxmoxApiTokenSecretRecord | ShellSshKeySecretRecord | ShellSshReferenceSecretRecord;

export interface SecretDocument {
  version: 1;
  updatedAt: string;
  records: SecretRecord[];
}

export interface SecretStore {
  readonly readOnly: boolean;
  read(): Promise<SecretDocument>;
  write(document: SecretDocument): Promise<void>;
  delete(): Promise<void>;
}

export interface SecretStoreConfig {
  type: "env" | "file" | "vault";
  envVarName?: string;
  filePath?: string;
  vault?: {
    baseUrl: string;
    token: string;
    mountPath: string;
    secretPath: string;
    namespace?: string;
    insecure?: boolean;
  };
}

const secretMetadataSchema: z.ZodType<SecretMetadata> = z
  .record(z.string(), z.unknown())
  .default({})
  .transform((value) => value as SecretMetadata);

const secretRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("proxmox_api_token"),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    metadata: secretMetadataSchema.optional(),
    user: z.string().min(1),
    realm: z.string().min(1),
    tokenId: z.string().min(1),
    secret: z.string().min(1),
    comment: z.string().optional(),
    expireAt: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("shell_ssh_key"),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    metadata: secretMetadataSchema.optional(),
    username: z.string().min(1),
    privateKey: z.string().min(1),
    publicKey: z.string().min(1),
    passphrase: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("shell_ssh_reference"),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    metadata: secretMetadataSchema.optional(),
    username: z.string().min(1),
    reference: z.string().min(1),
  }),
]);

const secretDocumentSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.string().min(1).default(() => nowIso()),
    records: z.array(secretRecordSchema).default([]),
  })
  .superRefine((document, ctx) => {
    const ids = new Set<string>();
    for (const [index, record] of document.records.entries()) {
      if (ids.has(record.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate secret id '${record.id}'`,
          path: ["records", index, "id"],
        });
      }
      ids.add(record.id);
    }
  });

export function createSecretDocument(records: SecretRecord[] = [], updatedAt = nowIso()): SecretDocument {
  return { version: 1, updatedAt, records };
}

export function cloneSecretDocument(document: SecretDocument): SecretDocument {
  return secretDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
}

export function normalizeSecretDocument(value: unknown): SecretDocument {
  if (Array.isArray(value)) {
    return secretDocumentSchema.parse({ version: 1, records: value });
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("records" in record || "version" in record) {
      return secretDocumentSchema.parse({ version: 1, ...record });
    }
  }

  return createSecretDocument();
}

export function getSecret(document: SecretDocument, id: string): SecretRecord | undefined {
  return document.records.find((record) => record.id === id);
}

export function upsertSecret(document: SecretDocument, record: SecretRecord): SecretDocument {
  const next = document.records.filter((entry) => entry.id !== record.id);
  next.push({ ...record, updatedAt: nowIso() });
  return createSecretDocument(next, nowIso());
}

export function removeSecret(document: SecretDocument, id: string): SecretDocument {
  return createSecretDocument(document.records.filter((record) => record.id !== id), nowIso());
}

export function summarizeSecretDocument(document: SecretDocument): Array<Pick<SecretRecordBase, "id" | "kind" | "createdAt" | "updatedAt" | "metadata">> {
  return document.records.map(({ id, kind, createdAt, updatedAt, metadata }) => ({ id, kind, createdAt, updatedAt, metadata }));
}

async function atomicWriteJson(filePath: string, document: SecretDocument): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const payload = `${JSON.stringify(secretDocumentSchema.parse(document), null, 2)}\n`;
  const tempPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tempPath, 0o600).catch(() => {});
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

export class EnvSecretStore implements SecretStore {
  readonly readOnly = true;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly envVarName = "PROXMOX_MCP_SECRETS_JSON",
  ) {}

  async read(): Promise<SecretDocument> {
    const raw = this.env[this.envVarName];
    if (!raw || raw.trim().length === 0) {
      return createSecretDocument();
    }

    return normalizeSecretDocument(JSON.parse(raw));
  }

  async write(): Promise<void> {
    throw new Error("EnvSecretStore is read-only");
  }

  async delete(): Promise<void> {
    throw new Error("EnvSecretStore is read-only");
  }
}

export class FileSecretStore implements SecretStore {
  readonly readOnly = false;

  constructor(private readonly filePath: string) {}

  async read(): Promise<SecretDocument> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return normalizeSecretDocument(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createSecretDocument();
      }
      throw error;
    }
  }

  async write(document: SecretDocument): Promise<void> {
    await atomicWriteJson(this.filePath, document);
  }

  async delete(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}

export class VaultSecretStore implements SecretStore {
  readonly readOnly = false;

  constructor(private readonly config: NonNullable<SecretStoreConfig["vault"]>) {}

  private get documentUrl(): URL {
    return new URL(`/v1/${this.config.mountPath.replace(/^\/+|\/+$/g, "")}/data/${this.config.secretPath.replace(/^\/+/, "")}`, this.config.baseUrl);
  }

  private get metadataUrl(): URL {
    return new URL(`/v1/${this.config.mountPath.replace(/^\/+|\/+$/g, "")}/metadata/${this.config.secretPath.replace(/^\/+/, "")}`, this.config.baseUrl);
  }

  private headers(): Record<string, string> {
    return {
      "X-Vault-Token": this.config.token,
      ...(this.config.namespace ? { "X-Vault-Namespace": this.config.namespace } : {}),
    };
  }

  async read(): Promise<SecretDocument> {
    const response = await undiciFetch(this.documentUrl, {
      method: "GET",
      headers: this.headers(),
    });

    if (response.status === 404) {
      return createSecretDocument();
    }

    const payload = (await response.json()) as { data?: { data?: unknown } };
    if (!response.ok) {
      throw new Error(`Vault secret read failed: ${response.status}`);
    }

    return normalizeSecretDocument(payload.data?.data);
  }

  async write(document: SecretDocument): Promise<void> {
    const response = await undiciFetch(this.documentUrl, {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ data: secretDocumentSchema.parse(document) }),
    });

    if (!response.ok) {
      throw new Error(`Vault secret write failed: ${response.status}`);
    }
  }

  async delete(): Promise<void> {
    const response = await undiciFetch(this.metadataUrl, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Vault secret delete failed: ${response.status}`);
    }
  }
}

export class MemorySecretStore implements SecretStore {
  readonly readOnly = false;

  constructor(private document: SecretDocument = createSecretDocument()) {}

  async read(): Promise<SecretDocument> {
    return cloneSecretDocument(this.document);
  }

  async write(document: SecretDocument): Promise<void> {
    this.document = cloneSecretDocument(document);
  }

  async delete(): Promise<void> {
    this.document = createSecretDocument();
  }
}

export function createSecretStore(config: SecretStoreConfig, env: NodeJS.ProcessEnv = process.env): SecretStore {
  switch (config.type) {
    case "env":
      return new EnvSecretStore(env, config.envVarName);
    case "file":
      if (!config.filePath) {
        throw new Error("File secret store requires filePath");
      }
      return new FileSecretStore(config.filePath);
    case "vault":
      if (!config.vault) {
        throw new Error("Vault secret store requires vault settings");
      }
      return new VaultSecretStore(config.vault);
  }
}
