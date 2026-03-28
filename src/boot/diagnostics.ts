import type { CommandResult } from "../types.js";
import type { BootstrapStack, OfflineBootInspection } from "./types.js";

/**
 * Offline boot inspection helpers.
 *
 * These helpers are intentionally explicit because they are the least API-shaped part of the
 * boot diagnostics flow. They exist only for VM diagnostics, where node-side fallback is
 * sometimes the only way to understand why bootstrap never reached a working guest-agent state.
 */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function addSection(lines: string[], key: string, body: string) {
  lines.push(`echo '__RCMCP_BEGIN__:${key}'`);
  lines.push(body);
  lines.push(`echo '__RCMCP_END__:${key}'`);
}

/**
 * Builds a bounded node-side shell script for offline guest boot inspection.
 *
 * Uses:
 * - loopback mounting of a guest disk on the Proxmox node
 * - offline reads of guest files and logs
 *
 * Fallback:
 * - this is only attempted when the backing disk path can be resolved to a node-local block device
 */
export function buildOfflineVmBootInspectionScript(blockDevicePath: string, vmid: number): string {
  const workDir = `/tmp/rcmcp-boot-${vmid}`;
  const lines: string[] = [
    "set -euo pipefail",
    "if [ \"$(id -u)\" -ne 0 ]; then",
    "  echo '__RCMCP_ERROR__:root_required'",
    "  exit 0",
    "fi",
    `BLOCK_DEVICE=${shellQuote(blockDevicePath)}`,
    `WORKDIR=${shellQuote(workDir)}`,
    "mkdir -p \"$WORKDIR\"",
    "mountpoint -q \"$WORKDIR\" && umount \"$WORKDIR\" || true",
    "losetup -D >/dev/null 2>&1 || true",
    "if [ ! -b \"$BLOCK_DEVICE\" ]; then",
    "  echo '__RCMCP_ERROR__:block_device_missing'",
    "  exit 0",
    "fi",
    "loopdev=$(losetup -Pf --show \"$BLOCK_DEVICE\")",
    "mounted=''",
    "for candidate in \"$loopdev\" \"${loopdev}p1\" \"${loopdev}p2\" \"${loopdev}p3\" \"${loopdev}p4\" \"${loopdev}p5\"; do",
    "  if [ -b \"$candidate\" ] && mount \"$candidate\" \"$WORKDIR\" 2>/dev/null; then",
    "    mounted=\"$candidate\"",
    "    if [ -f \"$WORKDIR/etc/os-release\" ]; then",
    "      break",
    "    fi",
    "    umount \"$WORKDIR\"",
    "    mounted=''",
    "  fi",
    "done",
    "if [ -z \"$mounted\" ]; then",
    "  echo '__RCMCP_ERROR__:mount_failed'",
    "  losetup -d \"$loopdev\" >/dev/null 2>&1 || true",
    "  exit 0",
    "fi",
    "cleanup() {",
    "  mountpoint -q \"$WORKDIR\" && umount \"$WORKDIR\" || true",
    "  losetup -d \"$loopdev\" >/dev/null 2>&1 || true",
    "}",
    "trap cleanup EXIT",
    "echo '__RCMCP_MOUNT__:'\"$mounted\"",
  ];

  addSection(lines, "OS_RELEASE", "cat \"$WORKDIR/etc/os-release\" 2>/dev/null || true");
  addSection(
    lines,
    "BOOTSTRAP_STACK",
    [
      "if [ -f \"$WORKDIR/etc/tiny-cloud.conf\" ]; then echo tiny-cloud; fi",
      "if [ -x \"$WORKDIR/usr/bin/cloud-init\" ] || [ -d \"$WORKDIR/etc/cloud\" ]; then echo cloud-init; fi",
      "if [ ! -f \"$WORKDIR/etc/tiny-cloud.conf\" ] && [ ! -x \"$WORKDIR/usr/bin/cloud-init\" ] && [ ! -d \"$WORKDIR/etc/cloud\" ]; then echo unknown; fi",
    ].join("\n"),
  );
  addSection(lines, "CLOUD_STATE_FILES", "find \"$WORKDIR/var/lib/cloud\" -maxdepth 4 -type f 2>/dev/null | sort | sed -n '1,120p' || true");
  addSection(lines, "CLOUD_INIT_OUTPUT", "sed -n '1,220p' \"$WORKDIR/var/log/cloud-init-output.log\" 2>/dev/null || true");
  addSection(
    lines,
    "CLOUD_INIT_JOURNAL",
    "journalctl --directory=\"$WORKDIR/var/log/journal\" --no-pager 2>/dev/null | egrep 'cloud-init|ds-identify|DataSource|NoCloud|qemu-guest-agent' | sed -n '1,220p' || true",
  );
  addSection(
    lines,
    "TINY_CLOUD_MESSAGES",
    "egrep -i 'tiny-cloud|cloud|qemu|apk|rc-service|doas' \"$WORKDIR/var/log/messages\" 2>/dev/null | sed -n '1,220p' || true",
  );
  addSection(lines, "APK_LOG", "sed -n '1,220p' \"$WORKDIR/var/log/apk.log\" 2>/dev/null || true");
  addSection(lines, "DPKG_STATUS", "grep -E 'Package: (cloud-init|qemu-guest-agent)$' -A3 \"$WORKDIR/var/lib/dpkg/status\" 2>/dev/null || true");

  return lines.join("\n");
}

/**
 * Parses the marked stdout produced by `buildOfflineVmBootInspectionScript`.
 */
export function parseOfflineVmBootInspection(
  result: CommandResult,
  blockDevicePath: string,
): OfflineBootInspection {
  const sections: Record<string, string> = {};
  const errors: string[] = [];
  const lines = result.stdout.split(/\r?\n/);
  let currentSection: string | null = null;
  let currentBuffer: string[] = [];
  let mountSource: string | null = null;

  for (const line of lines) {
    if (line.startsWith("__RCMCP_MOUNT__:")) {
      mountSource = line.slice("__RCMCP_MOUNT__:".length).trim() || null;
      continue;
    }
    if (line.startsWith("__RCMCP_ERROR__:")) {
      errors.push(line.slice("__RCMCP_ERROR__:".length).trim());
      continue;
    }
    if (line.startsWith("__RCMCP_BEGIN__:")) {
      currentSection = line.slice("__RCMCP_BEGIN__:".length).trim();
      currentBuffer = [];
      continue;
    }
    if (line.startsWith("__RCMCP_END__:")) {
      const key = line.slice("__RCMCP_END__:".length).trim();
      if (currentSection === key) {
        sections[key] = currentBuffer.join("\n").trim();
        currentSection = null;
        currentBuffer = [];
      }
      continue;
    }
    if (currentSection) {
      currentBuffer.push(line);
    }
  }

  if (result.stderr.trim().length > 0) {
    errors.push(result.stderr.trim());
  }

  const bootstrapLines = (sections.BOOTSTRAP_STACK ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bootstrapStack = (bootstrapLines[0] ?? "unknown") as BootstrapStack;

  return {
    attempted: true,
    supported: errors.length === 0 || sections.OS_RELEASE !== undefined,
    privilegedNodeShellRequired: true,
    blockDevicePath,
    mountSource,
    bootstrapStack,
    osRelease: sections.OS_RELEASE ?? null,
    sections,
    errors,
  };
}

