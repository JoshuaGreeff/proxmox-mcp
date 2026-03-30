import { describe, expect, it } from "vitest";
import { JobManager, makeUpidJobId, parseUpidJobId } from "../src/jobs.js";

describe("UPID-backed job handles", () => {
  it("round-trips a rehydratable job id", () => {
    const jobId = makeUpidJobId(
      { cluster: "lab", kind: "qemu_vm", vmid: 100 },
      "vm:start",
      "UPID:pve01:00000001:00000002:67E89B80:qmstart:100:root@pam:",
    );

    expect(parseUpidJobId(jobId)).toEqual({
      v: 1,
      operation: "vm:start",
      target: { cluster: "lab", kind: "qemu_vm", vmid: 100 },
      upid: "UPID:pve01:00000001:00000002:67E89B80:qmstart:100:root@pam:",
    });
  });

  it("returns null for non-UPID job ids", () => {
    expect(parseUpidJobId("job_123")).toBeNull();
    expect(parseUpidJobId("proxmox_upid_job_not-json")).toBeNull();
  });

  it("creates an in-memory job snapshot whose id can be rehydrated later from the UPID", () => {
    const manager = new JobManager();
    const job = manager.createUpidJob(
      { cluster: "lab", kind: "node", node: "pve01" },
      "backup:start",
      "UPID:pve01:00000001:00000002:67E89B80:vzdump::root@pam:",
    );

    expect(job.relatedUpid).toBe("UPID:pve01:00000001:00000002:67E89B80:vzdump::root@pam:");
    expect(job.resultRef).toEqual({
      type: "proxmox_upid",
      value: "UPID:pve01:00000001:00000002:67E89B80:vzdump::root@pam:",
    });
    expect(parseUpidJobId(job.jobId)).toEqual({
      v: 1,
      operation: "backup:start",
      target: { cluster: "lab", kind: "node", node: "pve01" },
      upid: "UPID:pve01:00000001:00000002:67E89B80:vzdump::root@pam:",
    });
  });
});
