import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxmoxApiClient } from "../src/api.js";
import { buildEnrollmentScript, buildApiTokenSecretId, buildShellKeySecretId, enroll, generateShellKeyPair } from "../src/admin-enroll.js";
import { MemorySecretStore } from "../src/admin-secrets.js";
import { SshExecutor } from "../src/ssh.js";

const originalExec = SshExecutor.prototype.exec;
const originalRequest = ProxmoxApiClient.prototype.request;

afterEach(() => {
  SshExecutor.prototype.exec = originalExec;
  ProxmoxApiClient.prototype.request = originalRequest;
  vi.restoreAllMocks();
});

describe("admin enrollment", () => {
  it("generates an OpenSSH ed25519 key pair", () => {
    const pair = generateShellKeyPair("proxmox-mcp-shell");
    expect(pair.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(pair.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
  });

  it("builds a hardened enrollment script with explicit sudoers allowlist", () => {
    const script = buildEnrollmentScript(
      {
        cluster: "lab",
        node: "pve-example",
        apiUser: "mcp",
        apiRealm: "pam",
        tokenId: "mcp",
        shellUsername: "proxmox-mcp-shell",
        bootstrap: { host: "proxmox.example.internal", username: "root", password: "bootstrap-password" },
        secretStore: new MemorySecretStore(),
        sudoersAllowlist: ["/usr/bin/pvesh", "/usr/sbin/qm"],
      },
      "ssh-ed25519 AAAA",
    );

    expect(script).toContain("authorized_keys");
    expect(script).toContain("pveum user token add");
    expect(script).toContain("pveum acl modify / --users \"$api_userid\" --roles Administrator");
    expect(script).toContain("proxmox-mcp-shell ALL=(ALL) NOPASSWD: /usr/bin/pvesh, /usr/sbin/qm");
    expect(script).toContain("visudo -cf \"$sudoers_path\"");
  });

  it("enrolls a node, writes secrets, and validates the new credentials", async () => {
    const store = new MemorySecretStore();
    const calls: string[] = [];
    SshExecutor.prototype.exec = vi.fn(async (_target, command) => {
      calls.push(command);
      if (command.includes("id -u")) {
        return { stdout: "0\n", stderr: "", exitCode: 0 };
      }

      return {
        stdout: JSON.stringify({
          node: "pve-example",
          fullTokenId: "mcp@pam!mcp",
          value: "runtime-token-secret",
          expire: Math.floor(Date.now() / 1000) + 1200,
        }),
        stderr: "",
        exitCode: 0,
      };
    });

    ProxmoxApiClient.prototype.request = vi.fn(async () => ({ data: { version: "8.4" } })) as any;

    const result = await enroll({
      cluster: "lab",
      node: "pve-example",
      apiUser: "mcp",
      apiRealm: "pam",
      tokenId: "mcp",
      shellUsername: "proxmox-mcp-shell",
      bootstrap: { host: "proxmox.example.internal", username: "root", password: "bootstrap-password" },
      secretStore: store,
    });

    const document = await store.read();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(result.validated).toBe(true);
    expect(buildApiTokenSecretId({
      cluster: "lab",
      node: "pve-example",
      apiUser: "mcp",
      apiRealm: "pam",
      tokenId: "mcp",
      shellUsername: "proxmox-mcp-shell",
    })).toBe("lab:api-token:mcp@pam!mcp");
    expect(buildShellKeySecretId({
      cluster: "lab",
      node: "pve-example",
      apiUser: "mcp",
      apiRealm: "pam",
      tokenId: "mcp",
      shellUsername: "proxmox-mcp-shell",
    })).toBe("lab:shell-key:pve-example:proxmox-mcp-shell");
    expect(document.records).toHaveLength(2);
    expect(document.records.map((record: { kind: string }) => record.kind)).toEqual(expect.arrayContaining(["proxmox_api_token", "shell_ssh_key"]));
  });
});
