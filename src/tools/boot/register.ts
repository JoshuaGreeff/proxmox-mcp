import type { ServerContext } from "../../mcp-common.js";
import { textResult } from "../../mcp-common.js";
import { z } from "zod";
import { createClusterSchema, createVmidSchema } from "../../tool-inputs.js";

/** Registers VM boot diagnostics tools. */
export function registerBootTools(context: ServerContext) {
  const { server, domains } = context;
  const clusterSchema = createClusterSchema(context.config);
  const vmidSchema = createVmidSchema("QEMU VM numeric ID.");

  /**
   * Uses:
   * - VM status/config reads
   * - guest-agent ping/info
   * - cloud-init dump
   * - node-side offline disk inspection via the validated node-terminal fallback
   *
   * Fallback:
   * - the node-side inspection path is only used when guest-agent and cloud-init level signals are insufficient
   * - offline inspection remains read-only and bounded to diagnostics-oriented evidence gathering
   */
  server.registerTool(
    "proxmox_vm_boot_diagnose",
    {
      description: "Diagnose why a QEMU VM or clone did not complete its first-boot/bootstrap path.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: vmidSchema,
        node: z.string().optional().describe("Optional node override. The current VM location is resolved when omitted."),
        timeoutMs: z.number().int().positive().optional().describe("Optional request timeout in milliseconds."),
      },
    },
    async ({ cluster, vmid, node, timeoutMs }, extra) =>
      textResult(`Boot diagnosis for VM ${vmid}`, await domains.boot.diagnoseVmBoot(cluster, vmid, node, timeoutMs, extra.signal)),
  );
}
