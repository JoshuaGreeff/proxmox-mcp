import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactManager } from "../src/artifacts.js";
import type { ProxmoxService } from "../src/services.js";

async function cleanupArtifacts(manager: ArtifactManager) {
  const existing = manager.list();
  await Promise.all(existing.map((entry) => manager.remove(entry.artifactId)));
}

describe("artifact manager", () => {
  afterEach(async () => {
    // Individual tests create their own manager instances and clean them locally.
  });

  it("creates inline text artifacts and reads them back as text resources", async () => {
    const manager = new ArtifactManager();
    try {
      const artifact = await manager.createTextArtifact("report", "application/json", JSON.stringify({ ok: true }));
      const service = {} as ProxmoxService;
      const content = await manager.readResource(artifact.artifactId, service);

      expect(artifact.uri).toContain("proxmox://artifacts/");
      expect("text" in content).toBe(true);
      if ("text" in content) {
        expect(content.text).toContain("\"ok\":true");
      }
    } finally {
      await cleanupArtifacts(manager);
    }
  });

  it("creates binary artifacts and exposes them as blob resources", async () => {
    const manager = new ArtifactManager();
    try {
      const artifact = await manager.createBinaryArtifact("binary", "application/octet-stream", Buffer.from([0, 1, 2, 255]));
      const service = {} as ProxmoxService;
      const content = await manager.readResource(artifact.artifactId, service);

      expect(artifact.encoding).toBe("base64");
      expect("blob" in content).toBe(true);
      if ("blob" in content) {
        expect(Buffer.from(content.blob, "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
      }
    } finally {
      await cleanupArtifacts(manager);
    }
  });

  it("supports reading linked local files through the artifact namespace", async () => {
    const manager = new ArtifactManager();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proxmox-mcp-artifact-test-"));
    const filePath = path.join(dir, "linked.txt");
    await fs.writeFile(filePath, "linked artifact");
    try {
      const artifact = manager.linkLocalFile("file", "text/plain", filePath, 15, { encoding: "utf8" });
      const service = {} as ProxmoxService;
      const content = await manager.readResource(artifact.artifactId, service);

      expect("text" in content).toBe(true);
      if ("text" in content) {
        expect(content.text).toBe("linked artifact");
      }
    } finally {
      await cleanupArtifacts(manager);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves text input from artifact URIs", async () => {
    const manager = new ArtifactManager();
    try {
      const artifact = await manager.createTextArtifact("config", "text/plain", "hello artifact input");
      const text = await manager.readArtifactText({ resourceUri: artifact.uri }, {} as ProxmoxService);
      expect(text).toBe("hello artifact input");
    } finally {
      await cleanupArtifacts(manager);
    }
  });
});
