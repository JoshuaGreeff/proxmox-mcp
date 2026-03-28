import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSecretDocument,
  createSecretStore,
  FileSecretStore,
  MemorySecretStore,
  normalizeSecretDocument,
  upsertSecret,
  type ProxmoxApiTokenSecretRecord,
} from "../src/admin-secrets.js";

const tempFiles: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempFiles.splice(0).map(async (filePath) => {
      await fs.rm(filePath, { force: true });
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }),
  );
});

describe("secret stores", () => {
  it("loads env secrets as a read-only document", async () => {
    const record: ProxmoxApiTokenSecretRecord = {
      id: "lab:api-token:mcp@pam!mcp",
      kind: "proxmox_api_token",
      createdAt: "2026-03-27T12:00:00.000Z",
      updatedAt: "2026-03-27T12:00:00.000Z",
      metadata: { cluster: "lab", node: "pve-example" },
      user: "mcp",
      realm: "pam",
      tokenId: "mcp",
      secret: "secret",
    };

    const store = createSecretStore({
      type: "env",
      envVarName: "PROXMOX_MCP_SECRETS_JSON",
    }, {
      PROXMOX_MCP_SECRETS_JSON: JSON.stringify({ version: 1, updatedAt: "2026-03-27T12:00:00.000Z", records: [record] }),
    });

    const document = await store.read();
    expect(document.records).toHaveLength(1);
    expect(document.records[0]).toMatchObject(record);
    await expect(store.write(document)).rejects.toThrow(/read-only/);
    await expect(store.delete()).rejects.toThrow(/read-only/);
  });

  it("round-trips file secrets with restrictive writes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxmox-mcp-secrets-"));
    const filePath = path.join(directory, "secrets.json");
    tempFiles.push(filePath);

    const store = new FileSecretStore(filePath);
    const document = createSecretDocument([
      {
        id: "lab:api-token:mcp@pam!mcp",
        kind: "proxmox_api_token",
        createdAt: "2026-03-27T12:00:00.000Z",
        updatedAt: "2026-03-27T12:00:00.000Z",
        metadata: { cluster: "lab" },
        user: "mcp",
        realm: "pam",
        tokenId: "mcp",
        secret: "secret",
      },
    ]);

    await store.write(document);
    const loaded = await store.read();
    expect(loaded).toMatchObject(document);
  });

  it("supports in-memory document mutation helpers", async () => {
    const store = new MemorySecretStore();
    const document = await store.read();
    const next = upsertSecret(document, {
      id: "lab:shell-key:pve-example:mcp",
      kind: "shell_ssh_key",
      createdAt: "2026-03-27T12:00:00.000Z",
      updatedAt: "2026-03-27T12:00:00.000Z",
      metadata: { cluster: "lab", node: "pve-example" },
      username: "mcp",
      privateKey: "PRIVATE",
      publicKey: "ssh-ed25519 AAAA",
    });

    await store.write(next);
    expect(normalizeSecretDocument(await store.read())).toMatchObject(next);
  });
});
