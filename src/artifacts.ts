import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactBacking, ArtifactEncoding, ArtifactRef, TargetRef } from "./types.js";
import { makeId, nowIso } from "./utils.js";
import type { ProxmoxService } from "./services.js";

type ArtifactKind = "log" | "config" | "cloud_init" | "report" | "export" | "file" | "binary";

type BaseArtifactRecord = ArtifactRef & {
  cleanupPath?: boolean;
};

type MemoryArtifactRecord = BaseArtifactRecord & {
  backing: "memory";
  data: Buffer;
};

type FileArtifactRecord = BaseArtifactRecord & {
  backing: "temp_file" | "local_file";
  filePath: string;
};

type ProxmoxFileArtifactRecord = BaseArtifactRecord & {
  backing: "proxmox_file";
  target: TargetRef;
  filePath: string;
};

type ArtifactRecord = MemoryArtifactRecord | FileArtifactRecord | ProxmoxFileArtifactRecord;

/**
 * Tracks server-managed artifact references for MCP resources and tool composition.
 *
 * Uses:
 * - MCP resources for artifact reads via `proxmox://artifacts/{artifactId}`
 * - local filesystem for temp or linked files
 * - Proxmox file transports for node/guest-backed artifact reads
 */
export class ArtifactManager {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly inlineTextThresholdBytes = 16 * 1024;
  private readonly inlineBinaryThresholdBytes = 64 * 1024;
  private readonly defaultTtlMs = 60 * 60 * 1000;

  /** Creates a UTF-8 text artifact and spills to a temp file when it grows beyond the inline threshold. */
  async createTextArtifact(
    kind: ArtifactKind,
    mimeType: string,
    text: string,
    options: {
      expiresInMs?: number;
      preferTempFile?: boolean;
    } = {},
  ): Promise<ArtifactRef> {
    return this.createBinaryArtifact(kind, mimeType, Buffer.from(text, "utf8"), {
      expiresInMs: options.expiresInMs,
      preferTempFile: options.preferTempFile,
      encoding: "utf8",
    });
  }

  /** Creates a binary artifact, storing small payloads in memory and large payloads in a temp file by default. */
  async createBinaryArtifact(
    kind: ArtifactKind,
    mimeType: string,
    data: Buffer,
    options: {
      expiresInMs?: number;
      preferTempFile?: boolean;
      encoding?: ArtifactEncoding;
    } = {},
  ): Promise<ArtifactRef> {
    const encoding = options.encoding ?? "base64";
    const shouldUseTempFile =
      options.preferTempFile
      || (encoding === "utf8" ? data.byteLength > this.inlineTextThresholdBytes : data.byteLength > this.inlineBinaryThresholdBytes);
    const base = this.createBaseRecord(kind, mimeType, data.byteLength, encoding, shouldUseTempFile ? "temp_file" : "memory", options.expiresInMs);

    const record: ArtifactRecord = shouldUseTempFile
      ? {
          ...base,
          backing: "temp_file",
          filePath: await this.writeTempFile(data),
          cleanupPath: true,
        }
      : {
          ...base,
          backing: "memory",
          data,
        };

    this.artifacts.set(record.artifactId, record);
    return this.publicRef(record);
  }

  /** Links a local file into the artifact namespace without copying it. */
  linkLocalFile(
    kind: ArtifactKind,
    mimeType: string,
    filePath: string,
    size: number,
    options: {
      expiresInMs?: number;
      encoding?: ArtifactEncoding;
    } = {},
  ): ArtifactRef {
    const record: ArtifactRecord = {
      ...this.createBaseRecord(kind, mimeType, size, options.encoding ?? "base64", "local_file", options.expiresInMs),
      backing: "local_file",
      filePath,
    };
    this.artifacts.set(record.artifactId, record);
    return this.publicRef(record);
  }

  /** Registers a Proxmox-backed file as a readable artifact for later resource reads. */
  linkProxmoxFile(
    kind: ArtifactKind,
    mimeType: string,
    target: TargetRef,
    filePath: string,
    options: {
      expiresInMs?: number;
      encoding?: ArtifactEncoding;
      size?: number;
    } = {},
  ): ArtifactRef {
    const record: ArtifactRecord = {
      ...this.createBaseRecord(kind, mimeType, options.size ?? 0, options.encoding ?? "base64", "proxmox_file", options.expiresInMs),
      backing: "proxmox_file",
      target,
      filePath,
    };
    this.artifacts.set(record.artifactId, record);
    return this.publicRef(record);
  }

  /** Resolves a text input from either a direct artifact id or a `proxmox://artifacts/...` URI. */
  async readArtifactText(reference: { artifactId?: string; resourceUri?: string }, service: ProxmoxService): Promise<string> {
    const buffer = await this.readArtifactBuffer(reference, service);
    return buffer.toString("utf8");
  }

  /** Reads an artifact as bytes regardless of backing store. */
  async readArtifactBuffer(reference: { artifactId?: string; resourceUri?: string }, service: ProxmoxService): Promise<Buffer> {
    const record = this.get(this.resolveArtifactId(reference));
    if (record.backing === "memory") {
      return record.data;
    }

    if (record.backing === "temp_file" || record.backing === "local_file") {
      return fs.readFile(record.filePath);
    }

    if (record.backing === "proxmox_file") {
      const readResult = await service.proxmoxFileReadBytes(record.target, record.filePath);
      return readResult.content;
    }

    throw new Error(`Unsupported artifact backing '${String((record as { backing?: string }).backing ?? "unknown")}'`);
  }

  /** Returns the public metadata for an artifact and rejects expired entries. */
  getPublic(artifactId: string): ArtifactRef {
    return this.publicRef(this.get(artifactId));
  }

  /** Reads an artifact into the MCP resource content shape. */
  async readResource(artifactId: string, service: ProxmoxService): Promise<
    | { uri: string; mimeType: string; text: string }
    | { uri: string; mimeType: string; blob: string }
  > {
    const record = this.get(artifactId);
    const data = await this.readArtifactBuffer({ artifactId }, service);
    if (record.encoding === "utf8") {
      return {
        uri: record.uri,
        mimeType: record.mimeType,
        text: data.toString("utf8"),
      };
    }

    return {
      uri: record.uri,
      mimeType: record.mimeType,
      blob: data.toString("base64"),
    };
  }

  /** Removes an artifact and any managed temp file behind it. */
  async remove(artifactId: string): Promise<void> {
    const record = this.artifacts.get(artifactId);
    if (!record) {
      return;
    }

    this.artifacts.delete(artifactId);
    if ((record.backing === "temp_file" || record.backing === "local_file") && record.cleanupPath) {
      await fs.rm(record.filePath, { force: true });
    }
  }

  /** Returns recent artifact metadata for debugging and tests. */
  list(limit = 200): ArtifactRef[] {
    return Array.from(this.artifacts.values()).slice(-limit).map((entry) => this.publicRef(entry));
  }

  private get(artifactId: string): ArtifactRecord {
    const record = this.artifacts.get(artifactId);
    if (!record) {
      throw new Error(`Unknown artifact '${artifactId}'`);
    }

    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      this.artifacts.delete(artifactId);
      throw new Error(`Artifact '${artifactId}' has expired`);
    }

    return record;
  }

  private resolveArtifactId(reference: { artifactId?: string; resourceUri?: string }): string {
    if (reference.artifactId) {
      return reference.artifactId;
    }

    if (reference.resourceUri) {
      const match = /^proxmox:\/\/artifacts\/([^/?#]+)$/.exec(reference.resourceUri);
      if (!match) {
        throw new Error(`Unsupported artifact resource URI '${reference.resourceUri}'`);
      }
      return match[1]!;
    }

    throw new Error("Artifact reference requires artifactId or resourceUri");
  }

  private createBaseRecord(
    kind: ArtifactKind,
    mimeType: string,
    size: number,
    encoding: ArtifactEncoding,
    backing: ArtifactBacking,
    expiresInMs?: number,
  ): BaseArtifactRecord {
    const artifactId = makeId("artifact");
    const createdAt = nowIso();
    return {
      artifactId,
      uri: `proxmox://artifacts/${artifactId}`,
      kind,
      mimeType,
      backing,
      size,
      encoding,
      createdAt,
      ...(expiresInMs !== 0 ? { expiresAt: new Date(Date.now() + (expiresInMs ?? this.defaultTtlMs)).toISOString() } : {}),
    };
  }

  private async writeTempFile(data: Buffer): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proxmox-mcp-artifacts-"));
    const filePath = path.join(dir, "artifact.bin");
    await fs.writeFile(filePath, data);
    return filePath;
  }

  private publicRef(record: ArtifactRecord): ArtifactRef {
    return {
      artifactId: record.artifactId,
      uri: record.uri,
      kind: record.kind,
      mimeType: record.mimeType,
      backing: record.backing,
      size: record.size,
      encoding: record.encoding,
      createdAt: record.createdAt,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    };
  }
}
