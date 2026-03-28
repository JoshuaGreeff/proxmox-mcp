import { z } from "zod";
import type { ServerContext } from "../../mcp-common.js";
import { commonExecutionSchema, completedJobResult, emitProgress, jobHandleResult, settleJob, textResult } from "../../mcp-common.js";
import type { TargetRef } from "../../types.js";

/** Registers cross-cutting infrastructure primitives that do not yet justify narrower folders. */
export function registerInfrastructureTools(context: ServerContext) {
  const { server, domains, service, jobManager } = context;
  const clusterSchema = z.string().describe("Configured cluster alias.");
  const nodeSchema = z.string().describe("Proxmox node name.");

  // Uses: cluster, node, QEMU, and LXC firewall endpoint families.
  server.registerTool(
    "proxmox_firewall_get",
    {
      description: "Read firewall sections for cluster, node, VM, or container scopes.",
      inputSchema: {
        cluster: clusterSchema,
        scope: z.enum(["cluster", "node", "qemu_vm", "lxc_container"]),
        node: z.string().optional(),
        vmid: z.number().int().positive().optional(),
        section: z.enum(["options", "rules", "aliases", "ipset", "log", "refs"]).default("options"),
      },
    },
    async ({ cluster, scope, node, vmid, section }) => {
      let target: TargetRef;
      let path: string;
      if (scope === "cluster") {
        target = { cluster, kind: "cluster" };
        path = `/cluster/firewall/${section}`;
      } else if (scope === "node" && node) {
        target = { cluster, kind: "node", node };
        path = `/nodes/${node}/firewall/${section}`;
      } else if (scope === "qemu_vm" && node && vmid !== undefined) {
        target = { cluster, kind: "qemu_vm", node, vmid };
        path = `/nodes/${node}/qemu/${vmid}/firewall/${section}`;
      } else if (scope === "lxc_container" && node && vmid !== undefined) {
        target = { cluster, kind: "lxc_container", node, vmid };
        path = `/nodes/${node}/lxc/${vmid}/firewall/${section}`;
      } else {
        throw new Error("Invalid firewall scope arguments");
      }

      return textResult(`Firewall ${scope} ${section}`, (await domains.infrastructure.firewallGet(target, path)).data);
    },
  );

  // Uses: `/cluster/backup`.
  server.registerTool(
    "proxmox_backup_jobs",
    {
      description: "List configured cluster backup jobs.",
      inputSchema: { cluster: clusterSchema },
    },
    async ({ cluster }) => textResult(`Backup jobs for ${cluster}`, (await domains.infrastructure.backupJobs(cluster)).data),
  );

  // Uses: `/nodes/{node}/vzdump`.
  server.registerTool(
    "proxmox_backup_start",
    {
      description: "Start a vzdump backup on a node.",
      inputSchema: {
        cluster: clusterSchema,
        node: nodeSchema,
        vmid: z.array(z.number().int().positive()).optional(),
        storage: z.string().optional(),
        mode: z.enum(["snapshot", "suspend", "stop"]).optional(),
        compress: z.string().optional(),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, node, vmid, storage, mode, compress, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "node", node };
      const result = await service.proxmoxApiCall(
        target,
        "POST",
        `/nodes/${node}/vzdump`,
        {
          ...(vmid ? { vmid: vmid.join(",") } : {}),
          ...(storage ? { storage } : {}),
          ...(mode ? { mode } : {}),
          ...(compress ? { compress } : {}),
        },
        timeoutMs,
        extra.signal,
      );
      if (!result.upid) {
        return textResult(`Backup started on ${node}`, result.data);
      }

      const job = jobManager.create(target, "backup:start");
      job.relatedUpid = result.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(result.upid!);
        return service.waitForUpid(cluster, result.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });

      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, "Backup finished") : jobHandleResult(job, "Backup running");
    },
  );

  // Uses: `/cluster/ceph/status`.
  server.registerTool("proxmox_ceph_status", { description: "Read cluster Ceph status.", inputSchema: { cluster: clusterSchema } }, async ({ cluster }) =>
    textResult(`Ceph status for ${cluster}`, (await domains.infrastructure.cephStatus(cluster)).data),
  );

  // Uses: `/cluster/sdn`.
  server.registerTool("proxmox_sdn_list", { description: "List SDN resources from the cluster scope.", inputSchema: { cluster: clusterSchema } }, async ({ cluster }) =>
    textResult(`SDN resources for ${cluster}`, (await domains.infrastructure.sdnList(cluster)).data),
  );

  // Uses: `/nodes/{node}/tasks`.
  server.registerTool(
    "proxmox_task_list",
    {
      description: "List finished node tasks for a node.",
      inputSchema: { cluster: clusterSchema, node: nodeSchema },
    },
    async ({ cluster, node }) => textResult(`Tasks for ${node}`, (await domains.infrastructure.taskList(cluster, node)).data),
  );

  // Uses: node task status/log endpoints.
  server.registerTool(
    "proxmox_task_get",
    {
      description: "Get Proxmox task status and recent logs for a UPID.",
      inputSchema: {
        cluster: clusterSchema,
        node: nodeSchema,
        upid: z.string().min(1),
      },
    },
    async ({ cluster, node, upid }) => textResult(`Task ${upid}`, await domains.infrastructure.taskGet(cluster, node, upid)),
  );

  // Uses: node, VM, and LXC console proxy ticket endpoints.
  server.registerTool(
    "proxmox_console_ticket",
    {
      description: "Create a console proxy ticket for a node, QEMU VM, or LXC container.",
      inputSchema: {
        cluster: clusterSchema,
        targetKind: z.enum(["node", "qemu_vm", "lxc_container"]),
        node: z.string().optional(),
        vmid: z.number().int().positive().optional(),
        scope: z.enum(["shell", "vnc"]).default("shell"),
      },
    },
    async ({ cluster, targetKind, node, vmid, scope }) => textResult("Console ticket", await domains.infrastructure.consoleTicket(cluster, targetKind, node, vmid, scope)),
  );
}
