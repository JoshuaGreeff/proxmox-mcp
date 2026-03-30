import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { ArtifactManager } from "./artifacts.js";
import { createDomainServices, type DomainServices } from "./domain-services.js";
import { JobManager } from "./jobs.js";
import type { RuntimeConfig } from "./config.js";
import type { ManagedAuthLifecycle } from "./managed-auth.js";
import { AuditLogger, PolicyService } from "./policy.js";
import { ProxmoxService } from "./services.js";
import type { ArtifactRef, ServerJob, WaitMode } from "./types.js";
import { sleep } from "./utils.js";

/** Shared wait-mode schema used by tools that may run synchronously or as jobs. */
export const waitModeSchema = z.enum(["wait", "deferred", "auto"]).default("auto");

/** Common execution controls shared across typed and escape-hatch tools. */
export const commonExecutionSchema = {
  waitMode: waitModeSchema.describe("Whether to wait for completion, return a background job immediately, or auto-switch based on runtime."),
  timeoutMs: z.number().int().positive().optional().describe("Optional timeout in milliseconds."),
  pollIntervalMs: z.number().int().positive().optional().describe("Optional polling interval in milliseconds for Proxmox tasks."),
};

/**
 * Builds a valid MCP tool result with both text and structured payloads.
 *
 * `structuredContent` must be an object-shaped record, so arrays and scalars are wrapped
 * to stay compatible with MCP client validators.
 */
export function textResult(title: string, data: unknown, isError = false, artifacts: ArtifactRef[] = []) {
  const baseContent =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : { data };
  const structuredContent = artifacts.length > 0 ? { ...baseContent, artifacts } : baseContent;

  return {
    content: [
      {
        type: "text" as const,
        text: `${title}\n\n${JSON.stringify(structuredContent, null, 2)}`,
      },
    ],
    structuredContent,
    isError,
  };
}

/** Returns true when a buffer looks like printable UTF-8 text rather than arbitrary binary data. */
export function isProbablyTextBuffer(data: Buffer): boolean {
  if (data.byteLength === 0) {
    return true;
  }

  const decoded = data.toString("utf8");
  const replacementCount = (decoded.match(/\uFFFD/g) ?? []).length;
  return replacementCount === 0;
}

/** Builds a tool result that inlines small text payloads and publishes large or binary data as artifacts. */
export async function artifactResult(
  title: string,
  manager: ArtifactManager,
  options: {
    kind: "log" | "config" | "cloud_init" | "report" | "export" | "file" | "binary";
    mimeType: string;
    data: Buffer;
    summary: Record<string, unknown>;
    isError?: boolean;
    preferTempFile?: boolean;
  },
) {
  if (isProbablyTextBuffer(options.data) && options.data.byteLength <= 16 * 1024) {
    return textResult(title, { ...options.summary, content: options.data.toString("utf8") }, options.isError ?? false);
  }

  const artifact = isProbablyTextBuffer(options.data)
    ? await manager.createTextArtifact(options.kind, options.mimeType, options.data.toString("utf8"), { preferTempFile: options.preferTempFile })
    : await manager.createBinaryArtifact(options.kind, options.mimeType, options.data, { preferTempFile: options.preferTempFile });
  return textResult(title, options.summary, options.isError ?? false, [artifact]);
}

/** Builds the immediate response shape for a deferred background job. */
export function jobHandleResult(job: ServerJob, note?: string) {
  return textResult(note ?? `Background job ${job.jobId} started`, {
    jobId: job.jobId,
    state: job.state,
    operation: job.operation,
    target: job.target,
    relatedUpid: job.relatedUpid,
    durability: job.relatedUpid ? "proxmox_upid" : "process_local",
  });
}

/** Builds the terminal response shape for a completed, failed, or cancelled job. */
export function completedJobResult(job: ServerJob, note?: string) {
  const payload = {
    jobId: job.jobId,
    state: job.state,
    operation: job.operation,
    target: job.target,
    relatedUpid: job.relatedUpid,
    durability: job.relatedUpid ? "proxmox_upid" : "process_local",
    result: job.result,
    error: job.error,
    logs: job.logs.slice(-200),
    ...(job.artifacts && job.artifacts.length > 0 ? { artifacts: job.artifacts } : {}),
  };

  return textResult(note ?? `Job ${job.jobId} ${job.state}`, payload, job.state === "failed" || job.state === "cancelled", job.artifacts ?? []);
}

/**
 * Emits MCP progress notifications when the client supplied a progress token.
 *
 * Spec reference:
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress
 */
export function emitProgress(
  extra: RequestHandlerExtra<any, any>,
  progress: { progress: number; total?: number; message?: string },
): Promise<void> | undefined {
  if (extra._meta?.progressToken === undefined) {
    return undefined;
  }

  return extra.sendNotification({
    method: "notifications/progress",
    params: {
      progressToken: extra._meta.progressToken,
      progress: progress.progress,
      total: progress.total,
      message: progress.message,
    },
  });
}

/** Applies `wait`, `deferred`, or `auto` behavior to a running server-owned job. */
export async function settleJob(jobManager: JobManager, jobId: string, waitMode: WaitMode, thresholdMs = 1_000) {
  if (waitMode === "deferred") {
    return null;
  }

  if (waitMode === "wait") {
    return jobManager.wait(jobId);
  }

  const sentinel = "__sentinel__" as const;
  // `auto` waits briefly so short-lived tasks still behave like normal tool calls.
  const quickResult: ServerJob | typeof sentinel = await Promise.race([jobManager.wait(jobId), sleep(thresholdMs).then(() => sentinel)]);
  if (quickResult === sentinel) {
    return null;
  }

  return quickResult;
}

/** Shared runtime context injected into tool registration modules. */
export interface ServerContext {
  config: RuntimeConfig;
  service: ProxmoxService;
  domains: DomainServices;
  artifacts: ArtifactManager;
  jobManager: JobManager;
  server: McpServer;
}

/** Creates the service, audit, and job subsystems used by the MCP server. */
export function createServerContext(config: RuntimeConfig, authLifecycle?: ManagedAuthLifecycle): ServerContext {
  const jobManager = new JobManager();
  const artifacts = new ArtifactManager();
  const policies = new PolicyService(config);
  const audit = new AuditLogger(config.auditLogPath);
  const service = new ProxmoxService(config, policies, audit, authLifecycle);
  const domains = createDomainServices(service);

  return {
    config,
    service,
    domains,
    artifacts,
    jobManager,
    server: undefined as unknown as McpServer,
  };
}
