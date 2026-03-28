import fs from "node:fs/promises";
import type { PolicyConfig, RuntimeConfig } from "./config.js";
import type { EffectivePolicy, TargetRef } from "./types.js";
import { matchesPattern, nowIso, redactSecrets } from "./utils.js";
import { targetIdForPolicy } from "./config.js";

/** Default deny-by-default policy baseline for mutation and shell access. */
const defaultPolicy: EffectivePolicy = {
  allowApiRead: true,
  allowApiWrite: false,
  allowCliFamilies: [],
  allowRawCli: false,
  allowShell: false,
  allowFileRead: true,
  allowFileWrite: false,
  allowSudo: false,
  maxTimeoutMs: 300_000,
};

/** Checks whether a repo policy entry applies to the current target reference. */
function matchesPolicy(policy: PolicyConfig, target: TargetRef): boolean {
  return (
    matchesPattern(target.cluster, policy.match.clusters) &&
    matchesPattern(target.kind, policy.match.targetKinds) &&
    matchesPattern(targetIdForPolicy(target.kind, target.node, target.vmid), policy.match.targetIds) &&
    matchesPattern(target.node, policy.match.nodeNames)
  );
}

/** Writes newline-delimited JSON audit records with secret redaction. */
export class AuditLogger {
  constructor(private readonly auditLogPath: string) {}

  async record(entry: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify(
      {
        timestamp: nowIso(),
        ...(redactSecrets(entry) as Record<string, unknown>),
      },
      null,
      0,
    );

    await fs.appendFile(this.auditLogPath, `${payload}\n`, "utf8");
  }
}

/**
 * Resolves repo policy rules into effective per-target permissions.
 *
 * This is the actual enforcement layer; MCP client approval prompts are only UX,
 * while these checks are the hard boundary.
 */
export class PolicyService {
  constructor(private readonly config: RuntimeConfig) {}

  /** Builds the effective policy for a target by folding matching config entries. */
  getPolicy(target: TargetRef): EffectivePolicy {
    return this.config.policies.reduce<EffectivePolicy>((current, policy) => {
      if (!matchesPolicy(policy, target)) {
        return current;
      }

      return {
        allowApiRead: policy.allowApiRead,
        allowApiWrite: policy.allowApiWrite,
        allowCliFamilies: [...new Set([...current.allowCliFamilies, ...policy.allowCliFamilies])],
        allowRawCli: policy.allowRawCli,
        allowShell: policy.allowShell,
        allowFileRead: policy.allowFileRead,
        allowFileWrite: policy.allowFileWrite,
        allowSudo: policy.allowSudo,
        maxTimeoutMs: policy.maxTimeoutMs,
      };
    }, defaultPolicy);
  }

  /** Applies the policy timeout ceiling to a requested or default timeout. */
  clampTimeout(target: TargetRef, requested: number | undefined, fallback: number): number {
    const effective = this.getPolicy(target);
    const desired = requested ?? fallback;
    return Math.min(desired, effective.maxTimeoutMs);
  }

  /** Enforces read-vs-write access on the Proxmox REST layer. */
  assertApiAccess(target: TargetRef, method: string): void {
    const effective = this.getPolicy(target);
    const isRead = method.toUpperCase() === "GET";
    const allowed = isRead ? effective.allowApiRead : effective.allowApiWrite;

    if (!allowed) {
      throw new Error(`Policy denies ${method.toUpperCase()} access for ${target.kind} on cluster ${target.cluster}`);
    }
  }

  /** Enforces allowed Proxmox CLI families and optional raw-command mode. */
  assertCliAccess(target: TargetRef, family: string, raw = false): void {
    const effective = this.getPolicy(target);
    if (!effective.allowCliFamilies.includes(family)) {
      throw new Error(`Policy denies CLI family '${family}' for ${target.kind} on cluster ${target.cluster}`);
    }

    if (raw && !effective.allowRawCli) {
      throw new Error(`Policy denies raw CLI mode for ${target.kind} on cluster ${target.cluster}`);
    }
  }

  /** Enforces host or guest shell access. */
  assertShellAccess(target: TargetRef): void {
    const effective = this.getPolicy(target);
    if (!effective.allowShell) {
      throw new Error(`Policy denies shell access for ${target.kind} on cluster ${target.cluster}`);
    }
  }

  /** Enforces file read or write access. */
  assertFileAccess(target: TargetRef, mode: "read" | "write"): void {
    const effective = this.getPolicy(target);
    const allowed = mode === "read" ? effective.allowFileRead : effective.allowFileWrite;
    if (!allowed) {
      throw new Error(`Policy denies file ${mode} access for ${target.kind} on cluster ${target.cluster}`);
    }
  }

  /** Enforces privilege escalation on transports that support sudo. */
  assertSudoAccess(target: TargetRef): void {
    const effective = this.getPolicy(target);
    if (!effective.allowSudo) {
      throw new Error(`Policy denies sudo access for ${target.kind} on cluster ${target.cluster}`);
    }
  }
}
