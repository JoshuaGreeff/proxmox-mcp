import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../../mcp-common.js";
import { artifactResult, commonExecutionSchema, completedJobResult, emitProgress, jobHandleResult, settleJob, textResult } from "../../mcp-common.js";
import { parseUpidJobId } from "../../jobs.js";
import { CAPABILITY_NAMES, type JobState, type ServerJob, type TargetRef } from "../../types.js";
import { nowIso, sleep } from "../../utils.js";

function upidNode(upid: string): string {
  const node = upid.split(":")[1];
  if (!node) {
    throw new Error(`Invalid UPID '${upid}'`);
  }
  return node;
}

function upidStartedAt(upid: string): string {
  const startHex = upid.split(":")[4];
  if (!startHex) {
    return nowIso();
  }

  const seconds = Number.parseInt(startHex, 16);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return nowIso();
  }

  return new Date(seconds * 1000).toISOString();
}

function normalizeTaskLogs(log: unknown): string[] {
  if (!Array.isArray(log)) {
    return [];
  }

  return log.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }

    if (entry && typeof entry === "object" && typeof (entry as { t?: unknown }).t === "string") {
      return (entry as { t: string }).t;
    }

    return JSON.stringify(entry);
  });
}

function classifyUpidState(status: unknown): { state: JobState; error?: string } {
  const record = status && typeof status === "object" ? status as Record<string, unknown> : {};
  if (record.status !== "stopped") {
    return { state: "running" };
  }

  const exitStatus = typeof record.exitstatus === "string" ? record.exitstatus.trim() : "";
  if (!exitStatus || exitStatus.toUpperCase() === "OK") {
    return { state: "completed" };
  }

  if (/(abort|cancel|interrupt)/i.test(exitStatus)) {
    return { state: "cancelled", error: exitStatus };
  }

  return { state: "failed", error: exitStatus };
}

async function readUpidJobSnapshot(context: ServerContext, jobId: string): Promise<ServerJob> {
  const handle = parseUpidJobId(jobId);
  if (!handle) {
    throw new Error(`Unknown job '${jobId}'`);
  }

  const node = upidNode(handle.upid);
  const status = await context.service.getTaskStatus(handle.target.cluster, node, handle.upid);
  const log = await context.service.getTaskLog(handle.target.cluster, node, handle.upid);
  const logs = normalizeTaskLogs(log);
  const classified = classifyUpidState(status);

  return {
    jobId,
    target: handle.target,
    operation: handle.operation,
    state: classified.state,
    startedAt: upidStartedAt(handle.upid),
    updatedAt: nowIso(),
    logsAvailable: logs.length > 0,
    logs,
    resultRef: { type: "proxmox_upid", value: handle.upid },
    relatedUpid: handle.upid,
    result: {
      status,
      log,
    },
    ...(classified.error ? { error: classified.error } : {}),
  };
}

async function waitForUpidJobSnapshot(context: ServerContext, jobId: string, timeoutMs?: number, signal?: AbortSignal): Promise<ServerJob> {
  const started = Date.now();
  while (true) {
    const snapshot = await readUpidJobSnapshot(context, jobId);
    if (snapshot.state !== "running") {
      return snapshot;
    }

    if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) {
      return snapshot;
    }

    await sleep(1_000, signal);
  }
}

/** Registers generic REST/CLI/shell escape hatches plus MCP resources, prompts, and job tools. */
export function registerEscapeTools(context: ServerContext) {
  const { server, service, jobManager, artifacts } = context;
  const clusterSchema = z.string().describe("Configured cluster alias.");
  const targetKindSchema = z.enum(["node", "qemu_vm", "lxc_container", "linux_guest", "windows_guest"]);

  server.registerResource(
    "artifact-resource",
    new ResourceTemplate("proxmox://artifacts/{artifactId}", { list: undefined }),
    { title: "Server Artifact", description: "Generated or linked server artifact content exposed as an MCP resource.", mimeType: "application/octet-stream" },
    async (uri, params) => {
      const artifactId = Array.isArray(params.artifactId) ? params.artifactId[0] : params.artifactId;
      if (!artifactId) {
        throw new Error("Missing artifactId parameter");
      }
      return { contents: [await artifacts.readResource(artifactId, service)] };
    },
  );

  server.registerResource(
    "inventory-resource",
    new ResourceTemplate("proxmox://inventory/{cluster}", { list: undefined }),
    { title: "Cluster Inventory Snapshot", description: "On-demand cluster inventory with discovered capabilities.", mimeType: "application/json" },
    async (uri, params) => {
      const cluster = Array.isArray(params.cluster) ? params.cluster[0] : params.cluster;
      if (!cluster) {
        throw new Error("Missing cluster parameter");
      }
      const snapshot = await service.inventoryOverview(cluster, { probeRemote: false, forceRefresh: true });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(snapshot, null, 2) }] };
    },
  );

  server.registerResource(
    "job-log-resource",
    new ResourceTemplate("proxmox://jobs/{jobId}/logs", { list: undefined }),
    { title: "Job Logs", description: "Logs for a background job. UPID-backed jobs can be re-read from Proxmox across server restarts; process-run jobs are local to the current server.", mimeType: "text/plain" },
    async (uri, params) => {
      const jobId = Array.isArray(params.jobId) ? params.jobId[0] : params.jobId;
      if (!jobId) {
        throw new Error("Missing jobId parameter");
      }
      const localJob = jobManager.find(jobId);
      const logs = localJob ? localJob.logs : (await readUpidJobSnapshot(context, jobId)).logs;
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: logs.join("") }] };
    },
  );

  server.registerPrompt(
    "change-plan",
    {
      title: "Change Plan",
      description: "Force the model to summarize an intended Proxmox change before mutation.",
      argsSchema: {
        target: z.string().describe("Target resource or scope."),
        change: z.string().describe("Change to be made."),
        rollback: z.string().optional().describe("Rollback path if the change fails."),
      },
    },
    async ({ target, change, rollback }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Before changing ${target}, summarize the intended change, expected impact, validation steps, and rollback plan.${rollback ? ` Rollback: ${rollback}.` : ""} Change: ${change}.` } }],
    }),
  );

  server.registerPrompt(
    "risk-review",
    {
      title: "Risk Review",
      description: "Force the model to review high-risk shell or CLI operations.",
      argsSchema: {
        operation: z.string().describe("Operation to review."),
        target: z.string().describe("Target host, VM, or container."),
      },
    },
    async ({ operation, target }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Review the risk of running '${operation}' against ${target}. Identify blast radius, prerequisites, and post-change verification.` } }],
    }),
  );

  server.registerTool(
    "proxmox_api_call",
    {
      description: "Call any documented Proxmox API endpoint by HTTP method and path. This is the completeness escape hatch for REST coverage. When Proxmox returns a UPID task, deferred job follow-up can be resumed later through `job_*`.",
      inputSchema: { cluster: clusterSchema, method: z.enum(["GET", "POST", "PUT", "DELETE"]), path: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}), ...commonExecutionSchema },
    },
    async ({ cluster, method, path, args, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "cluster" };
      const result = await service.proxmoxApiCall(target, method, path, args, timeoutMs, extra.signal);
      if (!result.upid) {
        return textResult(`API ${method} ${path}`, result.data);
      }
      const job = jobManager.createUpidJob(target, `api:${method}:${path}`, result.upid);
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(result.upid!);
        return service.waitForUpid(cluster, result.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `API task for ${method} ${path} finished`) : jobHandleResult(job, `API task for ${method} ${path} running`);
    },
  );

  server.registerTool(
    "proxmox_cli_run",
    {
      description: "Run an allowed Proxmox CLI family command over SSH on a Proxmox node. Deferred jobs for this break-glass path are process-local to the current server.",
      inputSchema: {
        cluster: clusterSchema,
        node: z.string().min(1),
        family: z.enum(["pvesh", "qm", "pct", "pvesm", "pveum", "pvenode", "pvecm", "pveceph", "pvesr", "vzdump", "apt"]),
        args: z.array(z.string()).default([]),
        rawCommand: z.string().optional().describe("Optional raw command string. Requires allowRawCli policy."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, node, family, args, rawCommand, waitMode, timeoutMs }) => {
      const target: TargetRef = { cluster, kind: "node", node };
      const job = jobManager.create(target, `cli:${family}`);
      jobManager.run(job.jobId, async (jobContext) => {
        const result = await service.proxmoxCliRun(target, family, args, rawCommand, timeoutMs, jobContext.signal);
        jobContext.appendLog(result.stdout);
        jobContext.appendLog(result.stderr);
        return result;
      });
      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `CLI ${family} finished`) : jobHandleResult(job, `CLI ${family} running`);
    },
  );

  server.registerTool(
    "proxmox_shell_run",
    {
      description: "Run a policy-gated shell command against a node or guest transport. Deferred jobs for this break-glass path are process-local to the current server.",
      inputSchema: {
        cluster: clusterSchema,
        targetKind: targetKindSchema,
        node: z.string().optional(),
        vmid: z.number().int().positive().optional(),
        command: z.string().min(1),
        interpreter: z.enum(["sh", "bash", "powershell", "cmd"]).default("sh"),
        useSudo: z.boolean().default(false),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, targetKind, node, vmid, command, interpreter, useSudo, waitMode, timeoutMs }, extra) => {
      const target: TargetRef = { cluster, kind: targetKind, ...(node ? { node } : {}), ...(vmid !== undefined ? { vmid } : {}) };
      const job = jobManager.create(target, "shell_run");
      jobManager.run(job.jobId, async (jobContext) => {
        const result = await service.proxmoxShellRun(
          target,
          { command, interpreter, useSudo },
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
      return settled ? completedJobResult(settled, "Shell command finished") : jobHandleResult(job, "Shell command running");
    },
  );

  // Uses: `proxmoxFileReadBytes`, which prefers guest-agent or REST-covered transports before validated SSH/PCT fallbacks.
  server.registerTool(
    "proxmox_file_read",
    {
      description: "Read a file through the best supported transport for the target.",
      inputSchema: { cluster: clusterSchema, targetKind: targetKindSchema, node: z.string().optional(), vmid: z.number().int().positive().optional(), filePath: z.string().min(1) },
    },
    async ({ cluster, targetKind, node, vmid, filePath }) => {
      const target: TargetRef = { cluster, kind: targetKind, ...(node ? { node } : {}), ...(vmid !== undefined ? { vmid } : {}) };
      const result = await service.proxmoxFileReadBytes(target, filePath);
      return artifactResult(`Read ${filePath}`, artifacts, {
        kind: "file",
        mimeType: "application/octet-stream",
        data: result.content,
        summary: { filePath, source: result.source, size: result.content.byteLength },
      });
    },
  );

  // Uses: `proxmoxFileWrite` / `proxmoxFileWriteBytes`; artifact inputs let large or binary content flow through MCP resources instead of inline payloads.
  server.registerTool(
    "proxmox_file_write",
    {
      description: "Write a file through the best supported transport for the target.",
      inputSchema: {
        cluster: clusterSchema,
        targetKind: targetKindSchema,
        node: z.string().optional(),
        vmid: z.number().int().positive().optional(),
        filePath: z.string().min(1),
        content: z.string().optional().describe("Inline UTF-8 file content for small text writes."),
        artifactId: z.string().optional().describe("Optional server artifact id to write instead of inline content."),
        resourceUri: z.string().optional().describe("Optional proxmox://artifacts/... URI to write instead of inline content."),
      },
    },
    async ({ cluster, targetKind, node, vmid, filePath, content, artifactId, resourceUri }) => {
      if (content === undefined && !artifactId && !resourceUri) {
        throw new Error("File write requires content, artifactId, or resourceUri");
      }
      const target: TargetRef = { cluster, kind: targetKind, ...(node ? { node } : {}), ...(vmid !== undefined ? { vmid } : {}) };
      if (artifactId || resourceUri) {
        const data = await artifacts.readArtifactBuffer({ artifactId, resourceUri }, service);
        return textResult(`Wrote ${filePath}`, await service.proxmoxFileWriteBytes(target, filePath, data));
      }
      return textResult(`Wrote ${filePath}`, await service.proxmoxFileWrite(target, filePath, content!));
    },
  );

  server.registerTool(
    "job_get",
    {
      description: "Get the current state of a background job. UPID-backed jobs can be re-read from Proxmox across server sessions; process-run jobs require the same live server instance.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) => {
      const localJob = jobManager.find(jobId);
      return completedJobResult(localJob ?? await readUpidJobSnapshot(context, jobId), `Job ${jobId}`);
    },
  );

  server.registerTool(
    "job_wait",
    {
      description: "Wait for a background job to finish or return its current state after a timeout. UPID-backed jobs can be resumed across server sessions; process-run jobs cannot.",
      inputSchema: { jobId: z.string().min(1), timeoutMs: z.number().int().positive().optional() },
    },
    async ({ jobId, timeoutMs }, extra) => {
      const localJob = jobManager.find(jobId);
      const settled = localJob ? await jobManager.wait(jobId, timeoutMs) : await waitForUpidJobSnapshot(context, jobId, timeoutMs, extra.signal);
      return completedJobResult(settled, `Job ${jobId}`);
    },
  );

  server.registerTool(
    "job_cancel",
    {
      description: "Cancel a background job. UPID-backed jobs request cancellation through Proxmox and remain rehydratable later; process-run jobs are cancelled only inside the current server process.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) => {
      const localJob = jobManager.find(jobId);
      const rehydratable = parseUpidJobId(jobId);
      if (localJob?.relatedUpid || rehydratable) {
        const handle = rehydratable ?? { upid: localJob!.relatedUpid!, target: localJob!.target, operation: localJob!.operation, v: 1 as const };
        try {
          await service.cancelUpid(handle.target.cluster, handle.upid);
        } catch {
          // Best effort.
        }
        return completedJobResult(await readUpidJobSnapshot(context, jobId), `Cancellation requested for ${jobId}`);
      }

      return completedJobResult(await jobManager.cancel(jobId), `Job ${jobId} cancelled`);
    },
  );

  server.registerTool(
    "job_logs",
    {
      description: "Read recent logs for a background job. UPID-backed jobs are read from Proxmox task logs; process-run jobs return only current-server in-memory logs.",
      inputSchema: { jobId: z.string().min(1), limit: z.number().int().positive().default(200) },
    },
    async ({ jobId, limit }) => {
      const localJob = jobManager.find(jobId);
      const logs = localJob ? localJob.logs.slice(-limit) : (await readUpidJobSnapshot(context, jobId)).logs.slice(-limit);
      return textResult(`Logs for ${jobId}`, { jobId, logs });
    },
  );

  server.registerTool(
    "proxmox_bootstrap_node_access",
    {
      description: "Bootstrap first-time node enrollment by installing the configured SSH public key, generating an API token, and optionally activating the new auth in the running server.",
      inputSchema: {
        cluster: clusterSchema,
        node: z.string().min(1).describe("Configured Proxmox node name."),
        apiUser: z.string().default("root").describe("User name portion of the target Proxmox account."),
        apiRealm: z.string().default("pam").describe("Realm portion of the target Proxmox account."),
        tokenId: z.string().default("mcp").describe("Token ID to create for MCP automation."),
        comment: z.string().optional().describe("Optional Proxmox-side comment for the generated token."),
        expire: z.number().int().min(0).optional().describe("Optional token expiration as seconds since epoch. Use 0 for no expiry."),
        privsep: z.boolean().default(true).describe("Whether the token should use separate ACLs instead of inheriting the full user permissions."),
        replaceExistingToken: z.boolean().default(false).describe("Whether to delete an existing token with the same ID before creating a new one."),
        installSshPublicKey: z.boolean().default(true).describe("Whether to install the configured SSH public key into the node's authorized_keys file."),
        activateApiToken: z.boolean().default(true).describe("Whether to switch the running server to the newly created API token immediately."),
      },
    },
    async ({ cluster, node, apiUser, apiRealm, tokenId, comment, expire, privsep, replaceExistingToken, installSshPublicKey, activateApiToken }, extra) =>
      textResult(
        `Bootstrap access for ${cluster}/${node}`,
        await service.bootstrapNodeAccess(
          cluster,
          node,
          { apiUser, apiRealm, tokenId, comment, expire, privsep, replaceExistingToken, installSshPublicKey, activateApiToken },
          extra.signal,
        ),
      ),
  );

  server.registerTool("proxmox_capabilities", { description: "Return the capability names used by this server.", inputSchema: {} }, async () => textResult("Capability names", CAPABILITY_NAMES));
}
