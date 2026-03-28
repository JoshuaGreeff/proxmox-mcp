/**
 * Types for VM boot/bootstrap diagnostics.
 *
 * This module is intentionally separate from the generic QEMU domain primitives because
 * boot failures often span several layers at once:
 * - Proxmox VM shape
 * - cloud-init or tiny-cloud behavior inside the guest
 * - package-manager/runtime failures revealed only after first boot
 * - node-side offline inspection of a guest disk
 *
 * The public MCP tools built on top of these types are still VM-scoped, but their
 * implementation is allowed to aggregate several closely related low-level signals.
 */

export type BootstrapStack = "cloud-init" | "tiny-cloud" | "unknown";

export interface OfflineBootInspection {
  attempted: boolean;
  supported: boolean;
  privilegedNodeShellRequired: boolean;
  blockDevicePath?: string | null;
  mountSource?: string | null;
  bootstrapStack: BootstrapStack;
  osRelease?: string | null;
  sections: Record<string, string>;
  errors: string[];
}
