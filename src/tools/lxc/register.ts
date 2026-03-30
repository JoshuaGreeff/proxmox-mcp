import { z } from "zod";
import type { ServerContext } from "../../mcp-common.js";
import { commonExecutionSchema, completedJobResult, emitProgress, jobHandleResult, settleJob, textResult } from "../../mcp-common.js";
import type { TargetRef } from "../../types.js";

/** Registers LXC container primitives. */
export function registerLxcTools(context: ServerContext) {
  const { server, domains, service, jobManager } = context;
  const clusterSchema = z.string().describe("Configured cluster alias.");
  const vmidSchema = z.number().int().positive().describe("QEMU VM or LXC CT numeric ID.");

  server.registerTool("proxmox_lxc_list", { description: "List Linux containers in a cluster.", inputSchema: { cluster: clusterSchema } }, async ({ cluster }) =>
    textResult(`LXC containers for ${cluster}`, await domains.lxc.list(cluster)),
  );

  server.registerTool("proxmox_lxc_get", { description: "Get LXC container status and config.", inputSchema: { cluster: clusterSchema, vmid: vmidSchema } }, async ({ cluster, vmid }) =>
    textResult(`LXC ${vmid}`, await domains.lxc.get(cluster, vmid)),
  );

  // Uses: `/nodes/{node}/lxc/{vmid}/status/{action}` lifecycle endpoints.
  server.registerTool(
    "proxmox_lxc_action",
    {
      description: "Run a common LXC container lifecycle action such as start, stop, shutdown, reboot, suspend, or resume.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        action: z.enum(["start", "stop", "shutdown", "reboot", "suspend", "resume"]),
        args: z.record(z.string(), z.unknown()).default({}),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, vmid, action, args, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "lxc_container", vmid };
      const response = await domains.lxc.action(cluster, vmid, action, args, timeoutMs, extra.signal);
      if (!response.upid) {
        return textResult(`LXC action ${action} completed`, response.data);
      }
      const job = jobManager.createUpidJob(target, `lxc:${action}`, response.upid);
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `LXC action ${action} finished`) : jobHandleResult(job, `LXC action ${action} running`);
    },
  );
}
