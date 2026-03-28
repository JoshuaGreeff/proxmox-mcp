import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callToolRecord,
  createLiveClient,
  liveCancelEnabled,
  liveCluster,
  liveEnabled,
  liveGuestDockerEnabled,
  liveMutationEnabled,
  liveNode,
  liveTemplateVmid,
  liveVmid,
} from "./mcp-live-helpers.js";

const describeLive = liveEnabled ? describe.sequential : describe.skip;
const describeMutation = liveEnabled && liveMutationEnabled ? describe.sequential : describe.skip;
const describeGuestDocker = liveEnabled && liveGuestDockerEnabled ? describe.sequential : describe.skip;
const itCancel = liveEnabled && liveMutationEnabled && liveCancelEnabled ? it : it.skip;

describeLive("live MCP integration", () => {
  let client: Client;

  beforeAll(async () => {
    client = await createLiveClient();
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it(
    "lists core Proxmox tools",
    async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);

      expect(names).toContain("proxmox_inventory_overview");
      expect(names).toContain("proxmox_vm_guest_exec");
      expect(names).toContain("proxmox_cli_run");
      expect(names).toContain("proxmox_api_call");
      expect(names).toContain("proxmox_vm_template_list");
      expect(names).toContain("proxmox_storage_download_url");
      expect(names).toContain("proxmox_vm_create");
      expect(names).toContain("proxmox_vm_update_config");
      expect(names).toContain("proxmox_vm_convert_to_template");
      expect(names).toContain("proxmox_vm_clone");
      expect(names).toContain("proxmox_vm_destroy");
      expect(names).toContain("proxmox_cloud_init_snippet_list");
      expect(names).toContain("proxmox_node_terminal_run");
    },
    30_000,
  );

  it(
    "returns inventory for the live T2 lab",
    async () => {
      const data = await callToolRecord(client, "proxmox_inventory_overview", {
        cluster: liveCluster,
        forceRefresh: true,
      });

      const nodes = (data.nodes as Array<Record<string, unknown>> | undefined) ?? [];
      const qemuVms = (data.qemuVms as Array<Record<string, unknown>> | undefined) ?? [];

      expect(nodes.some((node) => node.displayName === liveNode)).toBe(true);
      expect(qemuVms.some((vm) => vm.vmid === liveVmid)).toBe(true);
    },
    30_000,
  );

  it(
    "lists validated VM templates",
    async () => {
      const data = await callToolRecord(client, "proxmox_vm_template_list", {
        cluster: liveCluster,
      });

      const templates = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
      expect(templates.some((template) => template.vmid === liveTemplateVmid)).toBe(true);
    },
    30_000,
  );

  it(
    "reads a validated VM template config",
    async () => {
      const data = await callToolRecord(client, "proxmox_vm_template_get", {
        cluster: liveCluster,
        vmid: liveTemplateVmid,
      });

      const config = data.config as Record<string, unknown>;
      expect(String(config.cicustom)).toContain("vendor=");
      expect(config.template).not.toBeDefined();
    },
    30_000,
  );

  it(
    "executes commands inside the guest through MCP",
    async () => {
      const data = await callToolRecord(client, "proxmox_vm_guest_exec", {
        cluster: liveCluster,
        vmid: liveVmid,
        interpreter: "bash",
        waitMode: "wait",
        timeoutMs: 30_000,
        command: "echo live-mcp-ok && cloud-init status && id",
      });

      const result = data.result as Record<string, unknown>;
      expect(String(result.stdout)).toContain("live-mcp-ok");
      expect(String(result.stdout)).toContain("status: done");
      expect(String(result.stdout)).toContain("uid=0(root)");
      expect(result.exitCode).toBe(0);
    },
    45_000,
  );

  it(
    "round-trips a guest file via the guest agent",
    async () => {
      const filePath = "/tmp/live-mcp-roundtrip.txt";
      await callToolRecord(client, "proxmox_file_write", {
        cluster: liveCluster,
        targetKind: "qemu_vm",
        vmid: liveVmid,
        filePath,
        content: "live-mcp-roundtrip",
      });

      const readResult = await callToolRecord(client, "proxmox_file_read", {
        cluster: liveCluster,
        targetKind: "qemu_vm",
        vmid: liveVmid,
        filePath,
      });

      expect(readResult.content).toBe("live-mcp-roundtrip");
      expect(readResult.source).toBe("guest_agent");
    },
    30_000,
  );

  it(
    "runs a Proxmox CLI command over node SSH",
    async () => {
      const data = await callToolRecord(client, "proxmox_cli_run", {
        cluster: liveCluster,
        node: liveNode,
        family: "pvesm",
        args: ["status"],
        waitMode: "wait",
        timeoutMs: 30_000,
      });

      const result = data.result as Record<string, unknown>;
      expect(String(result.stdout)).toContain("local");
      expect(String(result.stdout)).toContain("local-lvm");
      expect(result.exitCode).toBe(0);
    },
    45_000,
  );

  it(
    "runs a shell command on the Proxmox node",
    async () => {
      const data = await callToolRecord(client, "proxmox_shell_run", {
        cluster: liveCluster,
        targetKind: "node",
        node: liveNode,
        interpreter: "bash",
        waitMode: "wait",
        timeoutMs: 20_000,
        command: "uname -a",
      });

      const result = data.result as Record<string, unknown>;
      expect(String(result.stdout)).toContain("Linux");
      expect(result.exitCode).toBe(0);
    },
    30_000,
  );

  it(
    "runs a node terminal command through the convenience tool",
    async () => {
      const data = await callToolRecord(client, "proxmox_node_terminal_run", {
        cluster: liveCluster,
        node: liveNode,
        interpreter: "bash",
        waitMode: "wait",
        command: "echo node-terminal-ok && hostname -s",
      });

      const result = data.result as Record<string, unknown>;
      expect(String(result.stdout)).toContain("node-terminal-ok");
      expect(result.exitCode).toBe(0);
    },
    30_000,
  );

  it(
    "supports raw Proxmox API calls",
    async () => {
      const data = await callToolRecord(client, "proxmox_api_call", {
        cluster: liveCluster,
        method: "GET",
        path: `/nodes/${liveNode}/tasks`,
        args: {},
      });

      const tasks = data.data as Array<Record<string, unknown>>;
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
    },
    30_000,
  );
});

describeMutation("live MCP mutation coverage", () => {
  let client: Client;

  beforeAll(async () => {
    client = await createLiveClient();
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  itCancel(
    "cancels a deferred shell job",
    async () => {
      const job = await callToolRecord(client, "proxmox_shell_run", {
        cluster: liveCluster,
        targetKind: "node",
        node: liveNode,
        interpreter: "bash",
        waitMode: "deferred",
        timeoutMs: 120_000,
        command: "echo start && sleep 60 && echo done",
      });

      const cancelled = await callToolRecord(client, "job_cancel", {
        jobId: String(job.jobId),
      });

      expect(["running", "cancelled"]).toContain(String(cancelled.state));

      let settled = cancelled;
      for (let attempt = 0; attempt < 10 && settled.state !== "cancelled"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        settled = await callToolRecord(client, "job_get", {
          jobId: String(job.jobId),
        });
      }

      expect(settled.state).toBe("cancelled");
      expect(String(settled.error)).toContain("aborted");
    },
    45_000,
  );

  it(
    "round-trips a cloud-init snippet on Proxmox storage",
    async () => {
      const snippetPath = `live-tests/${Date.now()}-snippet.yml`;
      const content = "#cloud-config\nhostname: live-snippet-test\n";

      try {
        const written = await callToolRecord(client, "proxmox_cloud_init_snippet_put", {
          cluster: liveCluster,
          node: liveNode,
          storage: "local",
          snippetPath,
          content,
        });

        expect(String(written.volumeId)).toContain("local:snippets/");

        const readBack = await callToolRecord(client, "proxmox_cloud_init_snippet_get", {
          cluster: liveCluster,
          node: liveNode,
          storage: "local",
          snippetPath,
        });

        expect(readBack.content).toBe(content);
      } finally {
        await callToolRecord(client, "proxmox_cloud_init_snippet_delete", {
          cluster: liveCluster,
          node: liveNode,
          storage: "local",
          snippetPath,
        });
      }
    },
    45_000,
  );

  it(
    "clones a template through the low-level vm clone tool and reads back the clone config",
    async () => {
      const cloneVmid = Number(`94${String(Date.now()).slice(-3)}`);
      const cloneName = `live-template-clone-${cloneVmid}`;

      try {
        const cloned = await callToolRecord(client, "proxmox_vm_clone", {
          cluster: liveCluster,
          vmid: liveTemplateVmid,
          newid: cloneVmid,
          name: cloneName,
          full: false,
          waitMode: "wait",
          timeoutMs: 180_000,
          pollIntervalMs: 1000,
        });

        expect(String(cloned.relatedUpid)).toContain("qmclone");

        const vm = await callToolRecord(client, "proxmox_vm_get", {
          cluster: liveCluster,
          vmid: cloneVmid,
        });

        const config = vm.config as Record<string, unknown>;
        expect(String(config.name)).toBe(cloneName);
      } finally {
        await callToolRecord(client, "proxmox_vm_destroy", {
          cluster: liveCluster,
          vmid: cloneVmid,
          purge: true,
          destroyUnreferencedDisks: true,
          waitMode: "wait",
          timeoutMs: 120_000,
          pollIntervalMs: 1000,
        });
      }
    },
    240_000,
  );

  it(
    "updates VM config through the low-level config tool",
    async () => {
      const cloneVmid = Number(`95${String(Date.now()).slice(-3)}`);
      const cloneName = `live-config-update-${cloneVmid}`;

      try {
        await callToolRecord(client, "proxmox_vm_clone", {
          cluster: liveCluster,
          vmid: liveTemplateVmid,
          newid: cloneVmid,
          name: cloneName,
          full: false,
          waitMode: "wait",
          timeoutMs: 180_000,
          pollIntervalMs: 1000,
        });

        const updated = await callToolRecord(client, "proxmox_vm_update_config", {
          cluster: liveCluster,
          vmid: cloneVmid,
          args: {
            memory: 1536,
            balloon: 768,
          },
          waitMode: "wait",
          timeoutMs: 60_000,
          pollIntervalMs: 1000,
        });

        expect(String(updated.relatedUpid)).toContain("qmset");

        const vm = await callToolRecord(client, "proxmox_vm_get", {
          cluster: liveCluster,
          vmid: cloneVmid,
        });
        const config = vm.config as Record<string, unknown>;
        expect(Number(config.memory)).toBe(1536);
        expect(Number(config.balloon)).toBe(768);
      } finally {
        await callToolRecord(client, "proxmox_vm_destroy", {
          cluster: liveCluster,
          vmid: cloneVmid,
          purge: true,
          destroyUnreferencedDisks: true,
          waitMode: "wait",
          timeoutMs: 120_000,
          pollIntervalMs: 1000,
        });
      }
    },
    180_000,
  );

  it(
    "creates and deletes a VM snapshot through the generic API tool",
    async () => {
      const snapName = `live-test-${Date.now()}`;

      const created = await callToolRecord(client, "proxmox_api_call", {
        cluster: liveCluster,
        method: "POST",
        path: `/nodes/${liveNode}/qemu/${liveVmid}/snapshot`,
        args: {
          snapname: snapName,
          description: "live MCP snapshot test",
        },
        waitMode: "wait",
        timeoutMs: 60_000,
        pollIntervalMs: 1_000,
      });

      expect(String(created.relatedUpid)).toContain("qmsnapshot");

      const removed = await callToolRecord(client, "proxmox_api_call", {
        cluster: liveCluster,
        method: "DELETE",
        path: `/nodes/${liveNode}/qemu/${liveVmid}/snapshot/${snapName}`,
        args: {},
        waitMode: "wait",
        timeoutMs: 60_000,
        pollIntervalMs: 1_000,
      });

      expect(String(removed.relatedUpid)).toContain("qmdelsnapshot");
    },
    120_000,
  );
});

describeGuestDocker("live guest Docker coverage", () => {
  let client: Client;

  beforeAll(async () => {
    client = await createLiveClient();
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it(
    "verifies the guest Docker debug stack",
    async () => {
      const data = await callToolRecord(client, "proxmox_vm_guest_exec", {
        cluster: liveCluster,
        vmid: liveVmid,
        interpreter: "bash",
        waitMode: "wait",
        timeoutMs: 60_000,
        command:
          "set -e; docker --version; docker compose version; cd /opt/mcp-mini-homelab; docker compose ps; curl -fsS http://127.0.0.1:8081 | sed -n '1,6p'; curl -k -fsS https://127.0.0.1:9443/api/status",
      });

      const result = data.result as Record<string, unknown>;
      const stdout = String(result.stdout);

      expect(stdout).toContain("Docker version");
      expect(stdout).toContain("Docker Compose version");
      expect(stdout).toContain("mini-whoami");
      expect(stdout).toContain("mini-dozzle");
      expect(stdout).toContain("mini-portainer");
      expect(stdout).toContain("Hostname:");
      expect(stdout).toContain("\"Version\"");
    },
    90_000,
  );
});
