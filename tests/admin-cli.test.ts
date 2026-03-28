import { describe, expect, it } from "vitest";
import { buildBootstrapConnection, buildSecretStoreConfig, parseAdminArgs } from "../src/admin-cli.js";

describe("admin CLI parsing", () => {
  it("parses enroll arguments and secret backend settings", () => {
    const parsed = parseAdminArgs([
      "enroll",
      "--cluster",
      "lab",
      "--node",
      "pve-example",
      "--host",
      "proxmox.example.internal",
      "--bootstrap-user",
      "root",
      "--bootstrap-password",
      "bootstrap-password",
      "--secret-backend",
      "file",
      "--secret-file",
      "/tmp/proxmox-mcp-secrets.json",
      "--sudoers-allowlist",
      "/usr/bin/pvesh",
      "--sudoers-allowlist",
      "/usr/sbin/qm",
    ]);

    expect(parsed.command).toBe("enroll");
    expect(buildBootstrapConnection(parsed.options)).toMatchObject({
      host: "proxmox.example.internal",
      username: "root",
      password: "bootstrap-password",
      hostKeyPolicy: "strict",
    });
    expect(buildSecretStoreConfig(parsed.options)).toEqual({
      type: "file",
      filePath: "/tmp/proxmox-mcp-secrets.json",
    });
  });

  it("rejects unsupported commands", () => {
    expect(() => parseAdminArgs(["bogus"])).toThrow(/Usage/);
  });
});
