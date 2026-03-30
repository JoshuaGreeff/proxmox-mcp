import { describe, expect, it } from "vitest";
import { completedJobResult, jobHandleResult, textResult } from "../src/mcp-common.js";

describe("textResult", () => {
  it("keeps object payloads as structured content", () => {
    const result = textResult("Object result", { ok: true, count: 2 });

    expect(result.structuredContent).toEqual({ ok: true, count: 2 });
  });

  it("wraps array payloads for structured content", () => {
    const result = textResult("Array result", [{ id: 1 }, { id: 2 }]);

    expect(result.structuredContent).toEqual({ data: [{ id: 1 }, { id: 2 }] });
  });

  it("wraps scalar payloads for structured content", () => {
    const result = textResult("Scalar result", "ok");

    expect(result.structuredContent).toEqual({ data: "ok" });
  });

  it("includes durability metadata in job handle results", () => {
    const result = jobHandleResult({
      jobId: "job_123",
      target: { cluster: "lab", kind: "node", node: "pve01" },
      operation: "shell_run",
      state: "running",
      startedAt: "2026-03-30T00:00:00.000Z",
      updatedAt: "2026-03-30T00:00:00.000Z",
      logsAvailable: false,
      logs: [],
    });

    expect(result.structuredContent).toMatchObject({
      jobId: "job_123",
      durability: "process_local",
    });
  });

  it("includes UPID durability metadata in completed job results", () => {
    const result = completedJobResult({
      jobId: "proxmox_upid_job_x",
      target: { cluster: "lab", kind: "qemu_vm", vmid: 100 },
      operation: "vm:start",
      state: "completed",
      startedAt: "2026-03-30T00:00:00.000Z",
      updatedAt: "2026-03-30T00:00:01.000Z",
      logsAvailable: true,
      logs: ["started"],
      relatedUpid: "UPID:pve01:00000001:00000002:67E89B80:qmstart:100:root@pam:",
      result: { ok: true },
    });

    expect(result.structuredContent).toMatchObject({
      relatedUpid: "UPID:pve01:00000001:00000002:67E89B80:qmstart:100:root@pam:",
      durability: "proxmox_upid",
    });
  });
});
