import { z } from "zod";
import type { ServerContext } from "../../mcp-common.js";
import { commonExecutionSchema, completedJobResult, emitProgress, jobHandleResult, settleJob, textResult } from "../../mcp-common.js";
import type { TargetRef } from "../../types.js";

/** Registers QEMU VM, guest, and template primitives. */
export function registerQemuTools(context: ServerContext) {
  const { server, domains, service, jobManager } = context;
  const clusterSchema = z.string().describe("Configured cluster alias.");
  const nodeSchema = z.string().describe("Proxmox node name.");
  const vmidSchema = z.number().int().positive().describe("QEMU VM numeric ID.");

  // Uses: inventory discovery for QEMU VMs.
  server.registerTool("proxmox_vm_list", { description: "List QEMU VMs in a cluster.", inputSchema: { cluster: clusterSchema } }, async ({ cluster }) =>
    textResult(`QEMU VMs for ${cluster}`, await domains.qemu.list(cluster)),
  );

  // Uses: inventory discovery plus `/nodes/{node}/qemu/{vmid}/status/current` and `/nodes/{node}/qemu/{vmid}/config`.
  server.registerTool("proxmox_vm_get", { description: "Get QEMU VM status and config.", inputSchema: { cluster: clusterSchema, vmid: vmidSchema } }, async ({ cluster, vmid }) =>
    textResult(`VM ${vmid}`, await domains.qemu.get(cluster, vmid)),
  );

  /**
   * Uses:
   * - `/nodes/{node}/qemu/{vmid}/status/current`
   * - `/nodes/{node}/qemu/{vmid}/config`
   * - `/nodes/{node}/qemu/{vmid}/agent/ping`
   * - `/nodes/{node}/qemu/{vmid}/agent/info`
   * - `qm cloudinit dump` through the validated CLI fallback
   *
   * Fallback:
   * - this is a bounded diagnostics tool, so guest-agent and cloud-init failures are returned as structured findings
   *   instead of short-circuiting on the first failing probe
   */
  server.registerTool(
    "proxmox_vm_guest_agent_diagnose",
    {
      description: "Diagnose guest-agent readiness and related cloud-init/bootstrap signals for a QEMU VM.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        node: z.string().optional().describe("Optional node override. The current VM location is resolved when omitted."),
        timeoutMs: z.number().int().positive().optional().describe("Optional request timeout in milliseconds."),
      },
    },
    async ({ cluster, vmid, node, timeoutMs }, extra) =>
      textResult(`Guest-agent diagnosis for VM ${vmid}`, await domains.qemu.diagnoseGuestAgent(cluster, vmid, node, timeoutMs, extra.signal)),
  );

  // Uses: `/nodes/{node}/qemu/{vmid}/agent/ping`.
  server.registerTool(
    "proxmox_vm_agent_ping",
    {
      description: "Ping the QEMU guest agent for a VM.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        node: z.string().optional().describe("Optional node override. The current VM location is resolved when omitted."),
        timeoutMs: z.number().int().positive().optional().describe("Optional request timeout in milliseconds."),
      },
    },
    async ({ cluster, vmid, node, timeoutMs }, extra) => {
      const result = await domains.qemu.agentPing(cluster, vmid, node, timeoutMs, extra.signal);
      return textResult(`Guest agent ping for VM ${vmid}`, result.data);
    },
  );

  // Uses: `/nodes/{node}/qemu/{vmid}/agent/info`.
  server.registerTool(
    "proxmox_vm_agent_info",
    {
      description: "Read QEMU guest agent capabilities and version information for a VM.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        node: z.string().optional().describe("Optional node override. The current VM location is resolved when omitted."),
        timeoutMs: z.number().int().positive().optional().describe("Optional request timeout in milliseconds."),
      },
    },
    async ({ cluster, vmid, node, timeoutMs }, extra) => {
      const result = await domains.qemu.agentInfo(cluster, vmid, node, timeoutMs, extra.signal);
      return textResult(`Guest agent info for VM ${vmid}`, result.data);
    },
  );

  // Uses: `/nodes/{node}/qemu/{vmid}/status/{action}` lifecycle endpoints.
  server.registerTool(
    "proxmox_vm_action",
    {
      description: "Run a common QEMU VM lifecycle action such as start, stop, reboot, reset, suspend, or resume.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        action: z.enum(["start", "stop", "shutdown", "reboot", "reset", "suspend", "resume"]),
        args: z.record(z.string(), z.unknown()).default({}),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, vmid, action, args, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "qemu_vm", vmid };
      const response = await domains.qemu.action(cluster, vmid, action, args, timeoutMs, extra.signal);
      if (!response.upid) {
        return textResult(`VM action ${action} completed`, response.data);
      }

      const job = jobManager.create(target, `vm:${action}`);
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });

      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `VM action ${action} finished`) : jobHandleResult(job, `VM action ${action} running`);
    },
  );

  // Uses: guest-agent endpoints first, then validated guest transports through the shared shell service.
  // Fallback: validated guest shell transport when guest-agent coverage is not sufficient.
  server.registerTool(
    "proxmox_vm_guest_exec",
    {
      description: "Execute a command inside a QEMU VM using the guest agent or configured guest transport.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        command: z.string().min(1),
        interpreter: z.enum(["sh", "bash", "powershell", "cmd"]).default("sh"),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, vmid, command, interpreter, waitMode, timeoutMs }, extra) => {
      const target: TargetRef = { cluster, kind: "qemu_vm", vmid };
      const job = jobManager.create(target, "vm_guest_exec");
      jobManager.run(job.jobId, async (jobContext) => {
        const result = await domains.qemu.guestExec(
          target,
          { command, interpreter, useSudo: false },
          timeoutMs,
          jobContext.signal,
          (chunk) => jobContext.appendLog(chunk),
          async (progress) => {
            jobContext.setProgress(progress.progress, progress.total, progress.message);
            await emitProgress(extra, progress);
          },
        );
        return result;
      });

      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, "VM guest command finished") : jobHandleResult(job, "VM guest command running");
    },
  );

  // Uses: `/cluster/resources` plus `/nodes/{node}/qemu/{vmid}/config` for template inspection.
  server.registerTool("proxmox_vm_template_list", { description: "List QEMU VM templates currently present in a cluster.", inputSchema: { cluster: clusterSchema } }, async ({ cluster }) =>
    textResult(`VM templates for ${cluster}`, await domains.qemu.listTemplates(cluster)),
  );

  // Uses: `/cluster/resources` plus `/nodes/{node}/qemu/{vmid}/config` for template inspection.
  server.registerTool(
    "proxmox_vm_template_get",
    { description: "Read the config for a QEMU VM template.", inputSchema: { cluster: clusterSchema, vmid: vmidSchema.describe("Template VMID.") } },
    async ({ cluster, vmid }) => textResult(`VM template ${vmid}`, await domains.qemu.getTemplate(cluster, vmid)),
  );

  // Uses: `/nodes/{node}/qemu` create endpoint.
  server.registerTool(
    "proxmox_vm_create",
    {
      description: "Create a QEMU VM through the documented REST endpoint using low-level config arguments.",
      inputSchema: {
        cluster: clusterSchema,
        node: nodeSchema,
        vmid: vmidSchema,
        args: z.record(z.string(), z.unknown()).default({}).describe("Raw Proxmox QEMU create arguments other than vmid."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, node, vmid, args, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "node", node };
      const response = await domains.qemu.create(cluster, node, vmid, args, timeoutMs, extra.signal);
      if (!response.upid) {
        return textResult(`VM ${vmid} created`, response.data);
      }
      const job = jobManager.create(target, "vm:create");
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `VM ${vmid} creation finished`) : jobHandleResult(job, `VM ${vmid} creating`);
    },
  );

  // Uses: `/nodes/{node}/qemu/{vmid}/config`.
  server.registerTool(
    "proxmox_vm_update_config",
    {
      description: "Update a QEMU VM config through the documented REST endpoint using low-level config arguments.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        node: z.string().optional().describe("Optional node override. The current VM location is resolved when omitted."),
        args: z.record(z.string(), z.unknown()).default({}).describe("Raw Proxmox QEMU config-update arguments."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, vmid, node, args, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "qemu_vm", vmid, ...(node ? { node } : {}) };
      const response = await domains.qemu.updateConfig(cluster, vmid, args, node, timeoutMs, extra.signal);
      if (!response.upid) {
        return textResult(`VM ${vmid} config updated`, response.data);
      }
      const job = jobManager.create(target, "vm:update_config");
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `VM ${vmid} config update finished`) : jobHandleResult(job, `VM ${vmid} config updating`);
    },
  );

  // Uses: `/nodes/{node}/qemu/{vmid}/template`.
  server.registerTool(
    "proxmox_vm_convert_to_template",
    {
      description: "Convert an existing QEMU VM into a Proxmox template.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        node: z.string().optional().describe("Optional node override. The current VM location is resolved when omitted."),
        disk: z.string().optional().describe("Optional single disk to convert to a base image."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, vmid, node, disk, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "qemu_vm", vmid, ...(node ? { node } : {}) };
      const response = await domains.qemu.convertToTemplate(cluster, vmid, disk ? { disk } : {}, node, timeoutMs, extra.signal);
      if (!response.upid) {
        return textResult(`VM ${vmid} converted to template`, response.data);
      }
      const job = jobManager.create(target, "vm:convert_to_template");
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `VM ${vmid} template conversion finished`) : jobHandleResult(job, `VM ${vmid} converting to template`);
    },
  );

  // Uses: `/nodes/{node}/qemu/{vmid}/clone`.
  server.registerTool(
    "proxmox_vm_clone",
    {
      description: "Clone a QEMU VM or template through the documented REST endpoint using low-level clone arguments.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema.describe("Source VM or template VMID."),
        node: z.string().optional().describe("Optional source node override. The current VM location is resolved when omitted."),
        newid: vmidSchema.describe("Destination VMID for the clone."),
        name: z.string().optional().describe("Optional new VM name."),
        full: z.boolean().optional().describe("Whether to force a full clone."),
        storage: z.string().optional().describe("Optional target storage for a full clone."),
        target: z.string().optional().describe("Optional target node."),
        pool: z.string().optional().describe("Optional VM pool."),
        description: z.string().optional().describe("Optional description for the clone."),
        snapname: z.string().optional().describe("Optional snapshot name to clone from."),
        bwlimit: z.number().int().nonnegative().optional().describe("Optional bandwidth limit in KiB/s."),
        format: z.enum(["raw", "qcow2", "vmdk"]).optional().describe("Optional target format for full clones on file-based storage."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, vmid, node, newid, name, full, storage, target: targetNode, pool, description, snapname, bwlimit, format, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const targetRef: TargetRef = { cluster, kind: "qemu_vm", vmid, ...(node ? { node } : {}) };
      const response = await domains.qemu.clone(cluster, vmid, { newid, name, full, storage, target: targetNode, pool, description, snapname, bwlimit, format }, node, timeoutMs, extra.signal);
      if (!response.upid) {
        return textResult(`VM ${vmid} cloned to ${newid}`, response.data);
      }
      const job = jobManager.create(targetRef, "vm:clone");
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `VM ${vmid} clone to ${newid} finished`) : jobHandleResult(job, `VM ${vmid} cloning to ${newid}`);
    },
  );

  // Uses: `/nodes/{node}/qemu/{vmid}` DELETE endpoint.
  server.registerTool(
    "proxmox_vm_destroy",
    {
      description: "Destroy a QEMU VM or template through the documented REST endpoint.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        node: z.string().optional().describe("Optional node override. The current VM location is resolved when omitted."),
        destroyUnreferencedDisks: z.boolean().optional().describe("Whether to destroy matching unreferenced disks as well."),
        purge: z.boolean().optional().describe("Whether to purge backup, HA, and replication references."),
        skiplock: z.boolean().optional().describe("Whether to ignore locks. Root-only on the Proxmox side."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, vmid, node, destroyUnreferencedDisks, purge, skiplock, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "qemu_vm", vmid, ...(node ? { node } : {}) };
      const response = await domains.qemu.destroy(
        cluster,
        vmid,
        {
          ...(destroyUnreferencedDisks !== undefined ? { "destroy-unreferenced-disks": destroyUnreferencedDisks } : {}),
          ...(purge !== undefined ? { purge } : {}),
          ...(skiplock !== undefined ? { skiplock } : {}),
        },
        node,
        timeoutMs,
        extra.signal,
      );
      if (!response.upid) {
        return textResult(`VM ${vmid} destroyed`, response.data);
      }
      const job = jobManager.create(target, "vm:destroy");
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `VM ${vmid} destroy finished`) : jobHandleResult(job, `VM ${vmid} destroying`);
    },
  );
}
