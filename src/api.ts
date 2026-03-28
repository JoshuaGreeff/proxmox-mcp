import fs from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";
import type { ClusterConfig } from "./config.js";
import { sleep } from "./utils.js";

/** Common HTTP request options for Proxmox API calls and task polling. */
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Options specific to long-running Proxmox task waits. */
export interface TaskWaitOptions extends RequestOptions {
  pollIntervalMs?: number;
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => Promise<void> | void;
}

/** Subset of Proxmox task status fields used by the MCP server. */
export interface TaskStatus {
  node: string;
  upid: string;
  status: "running" | "stopped";
  exitstatus?: string;
  user?: string;
  starttime?: number;
  type?: string;
  id?: string;
}

/** Encodes booleans and structured values the way Proxmox form handlers expect them. */
function encodeFormValue(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Appends request parameters using Proxmox-compatible repeated keys for arrays.
 *
 * Proxmox accepts repeated form/query keys for list-like values, which is how the
 * guest-agent exec endpoints expect the `command` argv to be transmitted.
 */
function appendParam(params: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      params.append(key, encodeFormValue(entry));
    }
    return;
  }

  params.set(key, encodeFormValue(value));
}

/** Parses the node name out of a Proxmox UPID task identifier. */
function parseUpid(upid: string): { node: string } {
  const parts = upid.split(":");
  if (parts.length < 3 || parts[0] !== "UPID") {
    throw new Error(`Invalid UPID: ${upid}`);
  }

  return { node: parts[1] ?? "" };
}

/**
 * Minimal Proxmox `/api2/json` client with token or ticket authentication.
 *
 * Official API reference:
 * https://pve.proxmox.com/wiki/Proxmox_VE_API
 * https://pve.proxmox.com/pve-docs/api-viewer/index.html
 */
export class ProxmoxApiClient {
  private readonly dispatcher: Agent;
  private ticketCookie?: string;
  private csrfToken?: string;

  constructor(private readonly cluster: ClusterConfig) {
    this.dispatcher = new Agent({
      connect: {
        rejectUnauthorized: cluster.tls.rejectUnauthorized,
        ca: cluster.tls.caFile ? fs.readFileSync(cluster.tls.caFile, "utf8") : undefined,
      },
    });
  }

  /** Builds the cluster-local `/api2/json` URL for a relative API path. */
  private baseUrl(pathname: string): string {
    return `${this.cluster.apiUrl.replace(/\/+$/, "")}/api2/json${pathname}`;
  }

  /** Lazily authenticates the ticket flow and caches the auth cookie and CSRF token. */
  private async ensureTicket(signal?: AbortSignal): Promise<void> {
    if (this.cluster.auth.type !== "ticket") {
      return;
    }

    if (this.ticketCookie && this.csrfToken) {
      return;
    }

    const body = new URLSearchParams({
      username: this.cluster.auth.username,
      password: this.cluster.auth.password,
      realm: this.cluster.auth.realm,
      ...(this.cluster.auth.otp ? { otp: this.cluster.auth.otp } : {}),
    });

    const response = await undiciFetch(this.baseUrl("/access/ticket"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      dispatcher: this.dispatcher,
      signal,
    });

    const payload = (await response.json()) as { data?: { ticket?: string; CSRFPreventionToken?: string } };
    if (!response.ok || !payload.data?.ticket) {
      throw new Error(`Proxmox ticket authentication failed for cluster ${this.cluster.name}`);
    }

    this.ticketCookie = `PVEAuthCookie=${payload.data.ticket}`;
    this.csrfToken = payload.data.CSRFPreventionToken;
  }

  /** Builds auth headers for either API token or ticket-based requests. */
  private async buildHeaders(method: string, signal?: AbortSignal): Promise<Record<string, string>> {
    if (this.cluster.auth.type === "api_token") {
      return {
        Authorization: `PVEAPIToken=${this.cluster.auth.user}@${this.cluster.auth.realm}!${this.cluster.auth.tokenId}=${this.cluster.auth.secret}`,
      };
    }

    if (this.cluster.auth.type === "secret_ref") {
      throw new Error(`Cluster ${this.cluster.name} is not hydrated with steady-state API credentials yet`);
    }

    if (this.cluster.auth.type === "ssh_bootstrap") {
      throw new Error(`Cluster ${this.cluster.name} is still configured for local bootstrap and is not valid for normal API runtime`);
    }

    await this.ensureTicket(signal);
    const headers: Record<string, string> = {
      Cookie: this.ticketCookie ?? "",
    };

    if (method !== "GET" && method !== "HEAD" && this.csrfToken) {
      headers.CSRFPreventionToken = this.csrfToken;
    }

    return headers;
  }

  /** Executes a Proxmox REST request and returns the unwrapped `data` payload. */
  async request<T = unknown>(
    method: string,
    pathname: string,
    args: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const upperMethod = method.toUpperCase();
    const url = new URL(this.baseUrl(pathname));
    const headers = await this.buildHeaders(upperMethod, options.signal);

    let body: URLSearchParams | undefined;
    if (upperMethod === "GET" || upperMethod === "DELETE") {
      for (const [key, value] of Object.entries(args)) {
        appendParam(url.searchParams, key, value);
      }
    } else {
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        appendParam(body, key, value);
      }
      headers["content-type"] = "application/x-www-form-urlencoded";
    }

    const controller = new AbortController();
    const timeout = options.timeoutMs
      ? setTimeout(() => controller.abort(new Error(`Request timeout after ${options.timeoutMs}ms`)), options.timeoutMs)
      : undefined;

    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const response = await undiciFetch(url, {
        method: upperMethod,
        headers,
        body,
        dispatcher: this.dispatcher,
        signal: controller.signal,
      });

      const rawText = await response.text();
      let payload: unknown = undefined;

      if (rawText.length > 0) {
        try {
          payload = JSON.parse(rawText);
        } catch {
          payload = rawText;
        }
      }

      if (!response.ok) {
        throw new Error(`Proxmox API ${upperMethod} ${pathname} failed: ${response.status} ${JSON.stringify(payload)}`);
      }

      // Proxmox normally responds as `{ data: ... }`, but some endpoints and errors surface
      // plain JSON or plain text, so the client tolerates both.
      const data = payload && typeof payload === "object" && "data" in payload ? (payload as { data: T }).data : (payload as T);
      return data;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /** Reads the current status for a single Proxmox task UPID. */
  async getTaskStatus(node: string, upid: string, options: RequestOptions = {}): Promise<TaskStatus> {
    return this.request<TaskStatus>("GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`, {}, options);
  }

  /** Reads the accumulated task log for a single Proxmox task UPID. */
  async getTaskLog(node: string, upid: string, options: RequestOptions = {}): Promise<Array<{ n: number; t: string }>> {
    return this.request("GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log`, {}, options);
  }

  /** Requests task cancellation on endpoints that support DELETE on the UPID. */
  async cancelTask(node: string, upid: string, options: RequestOptions = {}): Promise<void> {
    await this.request("DELETE", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`, {}, options);
  }

  /**
   * Polls a Proxmox UPID until it transitions to `stopped`.
   *
   * This mirrors how the Proxmox UI watches long-running tasks rather than relying
   * on a push callback from the API.
   */
  async waitForTask(upid: string, options: TaskWaitOptions = {}): Promise<TaskStatus> {
    const { node } = parseUpid(upid);
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    let attempts = 0;
    while (true) {
      if (options.signal?.aborted) {
        throw new Error("Task wait aborted");
      }

      const status = await this.getTaskStatus(node, upid, options);
      attempts += 1;

      if (status.status === "stopped") {
        return status;
      }

      if (options.onProgress) {
        await options.onProgress({
          progress: attempts,
          message: `Task ${upid} is still running on ${node}`,
        });
      }

      await sleep(pollIntervalMs, options.signal);
    }
  }
}

/** Identifies Proxmox task handles returned as `UPID:...` strings. */
export function isUpid(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("UPID:");
}
