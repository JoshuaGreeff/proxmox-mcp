import type { ArtifactRef, ServerJob, TargetRef } from "./types.js";
import { makeId, nowIso } from "./utils.js";

/** Error shape for jobs that fail after producing partial diagnostic output. */
export class JobExecutionError extends Error {
  constructor(message: string, readonly result?: unknown) {
    super(message);
    this.name = "JobExecutionError";
  }
}

/** Mutable helpers exposed to tool executors while a background job is running. */
export interface JobContext {
  signal: AbortSignal;
  appendLog: (message: string) => void;
  setProgress: (progress: number, total?: number, message?: string) => void;
  setRelatedUpid: (upid: string) => void;
  setArtifacts: (artifacts: ArtifactRef[]) => void;
}

/**
 * In-memory job registry for long-running MCP work.
 *
 * MCP `tools/call` is synchronous from the client's perspective, so the server keeps
 * its own job state for deferred or auto-deferred operations:
 * https://modelcontextprotocol.io/specification/2025-06-18/server/tools
 */
export class JobManager {
  private readonly jobs = new Map<string, ServerJob>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<ServerJob>>();

  /** Creates the initial pending record before execution starts. */
  create(target: TargetRef, operation: string): ServerJob {
    const jobId = makeId("job");
    const snapshot: ServerJob = {
      jobId,
      target,
      operation,
      state: "pending",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      logsAvailable: false,
      logs: [],
    };

    this.jobs.set(jobId, snapshot);
    return snapshot;
  }

  /** Returns the current job snapshot or throws for an unknown job id. */
  get(jobId: string): ServerJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job '${jobId}'`);
    }
    return job;
  }

  /** Returns the most recent in-memory log lines for a job. */
  listLogs(jobId: string, limit = 200): string[] {
    const job = this.get(jobId);
    return job.logs.slice(-limit);
  }

  /** Runs a job and keeps state transitions consistent across success, failure, and abort. */
  run<T>(jobId: string, executor: (context: JobContext) => Promise<T>): Promise<ServerJob> {
    const job = this.get(jobId);
    job.state = "running";
    job.updatedAt = nowIso();

    const controller = new AbortController();
    this.abortControllers.set(jobId, controller);

    const completion = (async () => {
      try {
        const result = await executor({
          signal: controller.signal,
          appendLog: (message) => {
            const current = this.get(jobId);
            current.logs.push(message);
            current.logsAvailable = current.logs.length > 0;
            current.updatedAt = nowIso();
          },
          setProgress: (progress, total, message) => {
            const current = this.get(jobId);
            current.progress = { progress, total, message };
            current.updatedAt = nowIso();
          },
          setRelatedUpid: (upid) => {
            const current = this.get(jobId);
            // UPID-backed jobs can later be inspected or cancelled through Proxmox itself.
            current.relatedUpid = upid;
            current.resultRef = { type: "proxmox_upid", value: upid };
            current.updatedAt = nowIso();
          },
          setArtifacts: (artifacts) => {
            const current = this.get(jobId);
            current.artifacts = artifacts;
            current.updatedAt = nowIso();
          },
        });

        const current = this.get(jobId);
        current.state = "completed";
        current.result = result;
        current.updatedAt = nowIso();
        if (!current.resultRef) {
          current.resultRef = { type: "memory", value: jobId };
        }
        return current;
      } catch (error) {
        const current = this.get(jobId);
        current.state = controller.signal.aborted ? "cancelled" : "failed";
        current.error = error instanceof Error ? error.message : String(error);
        if (error instanceof JobExecutionError && error.result !== undefined) {
          current.result = error.result;
          if (!current.resultRef) {
            current.resultRef = { type: "memory", value: jobId };
          }
        }
        current.updatedAt = nowIso();
        return current;
      } finally {
        this.abortControllers.delete(jobId);
      }
    })();

    this.completions.set(jobId, completion);
    return completion;
  }

  /** Waits for completion or returns the latest snapshot after a timeout. */
  async wait(jobId: string, timeoutMs?: number): Promise<ServerJob> {
    const completion = this.completions.get(jobId);
    if (!completion) {
      return this.get(jobId);
    }

    if (timeoutMs === undefined) {
      return completion;
    }

    return Promise.race([
      completion,
      new Promise<ServerJob>((resolve) => {
        setTimeout(() => resolve(this.get(jobId)), timeoutMs);
      }),
    ]);
  }

  /** Signals cancellation and then returns the near-term job snapshot. */
  async cancel(jobId: string): Promise<ServerJob> {
    const controller = this.abortControllers.get(jobId);
    if (controller) {
      controller.abort();
    }
    return this.wait(jobId, 100);
  }
}
