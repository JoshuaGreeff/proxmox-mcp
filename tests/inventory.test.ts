import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import type { RuntimeConfig } from "../src/config.js";
import { AuditLogger, PolicyService } from "../src/policy.js";
import { ProxmoxService } from "../src/services.js";

function makeRuntimeConfig(auditLogPath: string): RuntimeConfig {
  const parsed = configSchema.parse({
    clusters: [
      {
        name: "lab",
        apiUrl: "https://lab.example:8006",
        auth: { type: "api_token", user: "root", realm: "pam", tokenId: "mcp", secret: "secret" },
        nodes: [{ name: "pve1", host: "pve1.example", port: 22, sshProfile: "root-ssh" }],
      },
    ],
    sshProfiles: [
      {
        name: "root-ssh",
        username: "root",
        hostKeyPolicy: "accept-new",
      },
    ],
    auditLogPath,
  });

  return {
    ...parsed,
    configPath: path.join(os.tmpdir(), "proxmox-mcp-test-config.yaml"),
    clusterMap: new Map(parsed.clusters.map((cluster) => [cluster.name, cluster])),
    sshProfileMap: new Map(parsed.sshProfiles.map((profile) => [profile.name, profile])),
    winrmProfileMap: new Map(),
  };
}

describe("ProxmoxService inventory", () => {
  let auditLogPath: string;

  beforeEach(() => {
    auditLogPath = path.join(os.tmpdir(), `proxmox-mcp-${Date.now()}.log`);
    if (fs.existsSync(auditLogPath)) {
      fs.unlinkSync(auditLogPath);
    }
  });

  it("discovers core capabilities from Proxmox resources and guest agent config", async () => {
    const config = makeRuntimeConfig(auditLogPath);
    const service = new ProxmoxService(config, new PolicyService(config), new AuditLogger(auditLogPath));

    const mockClient = {
      request: async (_method: string, pathname: string) => {
        if (pathname === "/cluster/resources") {
          return [
            { id: "node/pve1", type: "node", node: "pve1", status: "online" },
            { id: "qemu/100", type: "qemu", node: "pve1", vmid: 100, name: "ubuntu", status: "running" },
            { id: "lxc/101", type: "lxc", node: "pve1", vmid: 101, name: "container", status: "running" },
            { id: "storage/local", type: "storage", storage: "local", status: "available" },
          ];
        }

        if (pathname === "/version") {
          return { version: "9.0" };
        }

        if (pathname === "/cluster/status") {
          return [{ type: "cluster", name: "lab" }];
        }

        if (pathname === "/nodes/pve1/qemu/100/config") {
          return { ostype: "l26", agent: 1 };
        }

        throw new Error(`Unexpected path ${pathname}`);
      },
    };

    (service as unknown as { getApiClient: () => unknown }).getApiClient = () => mockClient;

    const inventory = await service.inventoryOverview("lab");
    const vm = inventory.qemuVms[0];
    const lxc = inventory.lxcContainers[0];
    const node = inventory.nodes[0];

    expect(vm).toBeDefined();
    expect(lxc).toBeDefined();
    expect(node).toBeDefined();
    if (!vm || !lxc || !node) {
      throw new Error("Inventory should contain node, VM, and container entries");
    }

    expect(vm.capabilities).toEqual(expect.arrayContaining(["guest_exec", "guest_file_io", "guest_shell"]));
    expect(lxc.capabilities).toEqual(expect.arrayContaining(["guest_shell", "guest_file_io"]));
    expect(node.capabilities).toEqual(expect.arrayContaining(["host_shell"]));
  });
});
