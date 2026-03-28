import { z } from "zod";
import type { ServerContext } from "../../mcp-common.js";
import { commonExecutionSchema, completedJobResult, emitProgress, jobHandleResult, settleJob, textResult } from "../../mcp-common.js";
import type { TargetRef } from "../../types.js";

/** Registers node-scoped lifecycle, status, network, and terminal primitives. */
export function registerNodeTools(context: ServerContext) {
  const { server, domains, service, jobManager } = context;
  const clusterSchema = z.string().describe("Configured cluster alias.");
  const nodeSchema = z.string().describe("Proxmox node name.");

  // Uses: `/nodes` with inventory-backed capability discovery.
  server.registerTool(
    "proxmox_node_list",
    {
      description: "List nodes in a cluster with discovered capabilities.",
      inputSchema: { cluster: clusterSchema },
    },
    async ({ cluster }) => textResult(`Nodes for ${cluster}`, await domains.node.list(cluster)),
  );

  // Uses: `/nodes/{node}/status`.
  server.registerTool(
    "proxmox_node_get",
    {
      description: "Get current node status and selected metadata.",
      inputSchema: { cluster: clusterSchema, node: nodeSchema },
    },
    async ({ cluster, node }) => textResult(`Node ${node} status`, (await domains.node.get(cluster, node)).data),
  );

  // Uses: node lifecycle endpoints such as `/nodes/{node}/status`, `/nodes/{node}/wakeonlan`, and `/nodes/{node}/startall`.
  server.registerTool(
    "proxmox_node_action",
    {
      description: "Run a common node lifecycle action such as reboot, shutdown, or wake-on-LAN.",
      inputSchema: {
        cluster: clusterSchema,
        node: nodeSchema,
        action: z.enum(["reboot", "shutdown", "wakeonlan", "startall", "stopall", "suspendall", "migrateall"]),
        args: z.record(z.string(), z.unknown()).default({}),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, node, action, args, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "node", node };
      const response = await domains.node.action(cluster, node, action, args, timeoutMs, extra.signal);
      if (!response.upid) {
        return textResult(`Node action ${action} completed`, response.data);
      }

      const job = jobManager.create(target, `node:${action}`);
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });

      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `Node action ${action} finished`) : jobHandleResult(job, `Node action ${action} running`);
    },
  );

  // Uses: `/nodes/{node}/network`.
  server.registerTool(
    "proxmox_network_list",
    {
      description: "List node network interfaces and bridges.",
      inputSchema: { cluster: clusterSchema, node: nodeSchema },
    },
    async ({ cluster, node }) => textResult(`Network interfaces for ${node}`, (await domains.node.listNetwork(cluster, node)).data),
  );

  // Uses: node SSH plus internal shell transport policies.
  // Fallback: explicit high-risk node terminal path instead of a typed REST family.
  server.registerTool(
    "proxmox_node_terminal_run",
    {
      description: "Run a stateless shell command on a Proxmox node and wait for completion or a background job handle.",
      inputSchema: {
        cluster: clusterSchema,
        node: z.string().min(1).describe("Proxmox node name."),
        command: z.string().min(1),
        interpreter: z.enum(["sh", "bash", "powershell", "cmd"]).default("sh"),
        useSudo: z.boolean().default(false),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, node, command, interpreter, useSudo, waitMode }, extra) => {
      const job = jobManager.create({ cluster, kind: "node", node }, "node_terminal_run");
      jobManager.run(job.jobId, async (jobContext) => {
        const result = await domains.node.terminal(
          cluster,
          node,
          { command, interpreter, useSudo },
          jobContext.signal ?? extra.signal,
          (chunk) => jobContext.appendLog(chunk),
        );
        jobContext.appendLog(result.stdout);
        jobContext.appendLog(result.stderr);
        return result;
      });

      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `Node terminal command finished on ${node}`) : jobHandleResult(job, `Node terminal command running on ${node}`);
    },
  );
}
