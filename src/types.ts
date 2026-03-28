export const TARGET_KINDS = [
  "cluster",
  "node",
  "qemu_vm",
  "lxc_container",
  "linux_guest",
  "windows_guest",
] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];

export const CAPABILITY_NAMES = [
  "inventory",
  "lifecycle",
  "config",
  "task_wait",
  "console",
  "guest_exec",
  "guest_file_io",
  "host_shell",
  "guest_shell",
  "docker_shell",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type WaitMode = "wait" | "deferred" | "auto";
export type JobState = "pending" | "running" | "completed" | "failed" | "cancelled";
export type ArtifactBacking = "memory" | "temp_file" | "proxmox_file" | "local_file";
export type ArtifactEncoding = "utf8" | "base64";

export interface TargetRef {
  cluster: string;
  kind: TargetKind;
  node?: string;
  vmid?: number;
  guestName?: string;
}

export interface ProgressSnapshot {
  progress: number;
  total?: number;
  message?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

export interface ArtifactRef {
  artifactId: string;
  uri: string;
  kind: string;
  mimeType: string;
  backing: ArtifactBacking;
  size: number;
  encoding: ArtifactEncoding;
  createdAt: string;
  expiresAt?: string;
}

export interface ServerJob {
  jobId: string;
  target: TargetRef;
  operation: string;
  state: JobState;
  startedAt: string;
  updatedAt: string;
  progress?: ProgressSnapshot;
  logsAvailable: boolean;
  resultRef?: {
    type: "proxmox_upid" | "memory";
    value: string;
  };
  relatedUpid?: string;
  result?: unknown;
  error?: string;
  logs: string[];
  artifacts?: ArtifactRef[];
}

export interface ClusterSummary {
  cluster: string;
  version?: unknown;
  status?: unknown;
  nodes: NodeSummary[];
  qemuVms: VmSummary[];
  lxcContainers: LxcSummary[];
  storages: unknown[];
}

export interface BaseSummary {
  target: TargetRef;
  displayName: string;
  status?: string;
  capabilities: CapabilityName[];
  preferredTransport?: string;
  reachable: boolean | null;
}

export interface NodeSummary extends BaseSummary {
  node: string;
}

export interface VmSummary extends BaseSummary {
  vmid: number;
  node: string;
  guestKind: "linux_guest" | "windows_guest" | "unknown";
  guestAgentAvailable: boolean;
}

export interface LxcSummary extends BaseSummary {
  vmid: number;
  node: string;
}

export interface ResolvedNodeTarget {
  cluster: string;
  node: string;
  host: string;
  port: number;
  sshProfile: string;
}

export interface ResolvedLinuxGuestTarget {
  cluster: string;
  kind: "qemu_vm" | "lxc_container";
  vmid: number;
  node?: string;
  host?: string;
  sshProfile?: string;
}

export interface ResolvedWindowsGuestTarget {
  cluster: string;
  vmid: number;
  node?: string;
  host?: string;
  winrmProfile?: string;
}

export interface EffectivePolicy {
  allowApiRead: boolean;
  allowApiWrite: boolean;
  allowCliFamilies: string[];
  allowRawCli: boolean;
  allowShell: boolean;
  allowFileRead: boolean;
  allowFileWrite: boolean;
  allowSudo: boolean;
  maxTimeoutMs: number;
}

export interface ToolExecutionOptions {
  waitMode: WaitMode;
  timeoutMs?: number;
  pollIntervalMs?: number;
}
