import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "ssh2";
import type { RuntimeConfig, SshProfileConfig, WinRmProfileConfig } from "./config.js";
import type { CommandResult } from "./types.js";
import { shellJoin } from "./utils.js";

/** Concrete SSH connection target after config lookup. */
export interface SshTarget {
  host: string;
  port?: number;
  profile: SshProfileConfig;
}

/** Streaming execution options shared by SSH and guest-shell callers. */
export interface ExecOptions {
  signal?: AbortSignal;
  onStdout?: (chunk: string) => Promise<void> | void;
  onStderr?: (chunk: string) => Promise<void> | void;
}

/** Verifies an SSH host key against a configured SHA-256 fingerprint. */
function expectedKeyMatches(expected: string | undefined, hostKey: Buffer): boolean {
  if (!expected) {
    return false;
  }

  const normalizedExpected = expected.replace(/^SHA256:/i, "").trim();
  const actual = crypto.createHash("sha256").update(hostKey).digest("base64");
  return actual === normalizedExpected;
}

/**
 * Thin SSH execution wrapper used for Proxmox node commands and SSH guest fallbacks.
 *
 * Underlying client: https://www.npmjs.com/package/ssh2
 */
export class SshExecutor {
  /** Executes a single remote command and captures exit code plus streamed output. */
  async exec(target: SshTarget, command: string, options: ExecOptions = {}): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const client = new Client();
      let stdout = "";
      let stderr = "";
      let settled = false;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        client.end();
        reject(error);
      };

      const finish = (result: CommandResult) => {
        if (settled) {
          return;
        }
        settled = true;
        client.end();
        resolve(result);
      };

      if (options.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            fail(new Error("SSH command aborted"));
          },
          { once: true },
        );
      }

      client
        .on("ready", () => {
          client.exec(command, (error, stream) => {
            if (error) {
              fail(error);
              return;
            }

            let exitCode = 0;
            let signalName: string | undefined;
            stream.on("data", async (chunk: Buffer | string) => {
              const text = chunk.toString();
              stdout += text;
              await options.onStdout?.(text);
            });

            stream.stderr.on("data", async (chunk: Buffer | string) => {
              const text = chunk.toString();
              stderr += text;
              await options.onStderr?.(text);
            });

            stream.on("exit", (code?: number, signal?: string) => {
              exitCode = code ?? 0;
              signalName = signal;
            });

            stream.on("close", () => {
              finish({
                stdout,
                stderr,
                exitCode,
                signal: signalName,
              });
            });

            if (options.signal) {
              options.signal.addEventListener(
                "abort",
                () => {
                  try {
                    stream.signal("TERM");
                  } catch {
                    stream.close();
                  }
                },
                { once: true },
              );
            }
          });
        })
        .on("error", fail)
        .connect({
          host: target.host,
          port: target.port ?? target.profile.port,
          username: target.profile.username,
          password: target.profile.password,
          passphrase: target.profile.passphrase,
          privateKey: target.profile.privateKey ?? (target.profile.privateKeyPath ? fs.readFileSync(target.profile.privateKeyPath, "utf8") : undefined),
          hostVerifier: (hostKey: Buffer) => {
            if (target.profile.hostKeyPolicy === "insecure" || target.profile.hostKeyPolicy === "accept-new") {
              return true;
            }

            return expectedKeyMatches(target.profile.expectedHostKey, hostKey);
          },
        });
    });
  }
}

/** Builds a one-shot PowerShell remoting script for a Windows guest target. */
function buildPowerShellRemotingScript(host: string, profile: WinRmProfileConfig, command: string): string {
  const credentialLines = profile.password
    ? [
        `$securePassword = ConvertTo-SecureString ${JSON.stringify(profile.password)} -AsPlainText -Force`,
        `$credential = New-Object System.Management.Automation.PSCredential(${JSON.stringify(profile.username)}, $securePassword)`,
      ]
    : [`$credential = $null`];

  const sessionOptions = profile.skipCertificateChecks
    ? `-SessionOption (New-PSSessionOption -SkipCACheck -SkipCNCheck)`
    : "";
  const credentialArgument = profile.password ? "-Credential $credential" : "";
  const transportArgument = profile.transport === "default" ? "" : `-${profile.transport.toUpperCase()}`;
  const sslArgument = profile.useSsl ? "-UseSSL" : "";

  return [
    ...credentialLines,
    `$result = Invoke-Command -ComputerName ${JSON.stringify(host)} ${credentialArgument} ${transportArgument} ${sslArgument} ${sessionOptions} -ScriptBlock { ${command} } 2>&1 | Out-String`,
    `Write-Output $result`,
  ].join(";\n");
}

/** Executes PowerShell Remoting commands for Windows guest fallbacks. */
export class PowerShellRemotingExecutor {
  constructor(private readonly config: RuntimeConfig) {}

  /** Runs a command via the configured WinRM/PowerShell profile. */
  async exec(profileName: string, host: string, command: string, signal?: AbortSignal): Promise<CommandResult> {
    const profile = this.config.winrmProfileMap.get(profileName);
    if (!profile) {
      throw new Error(`Unknown WinRM profile: ${profileName}`);
    }

    const powershell = profile.powershellPath;
    const script = buildPowerShellRemotingScript(host, profile, command);

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code, signalName) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
          signal: signalName ?? undefined,
        });
      });

      signal?.addEventListener(
        "abort",
        () => {
          child.kill();
          reject(new Error("PowerShell remoting aborted"));
        },
        { once: true },
      );
    });
  }
}

/** Builds a POSIX shell invocation that matches how Proxmox guest-agent exec is called. */
export function buildLinuxShellCommand(interpreter: "sh" | "bash", command: string): string {
  return shellJoin([interpreter === "bash" ? "/bin/bash" : "/bin/sh", "-lc", command]);
}

/** Builds a Windows shell invocation for `cmd.exe` or `powershell.exe`. */
export function buildWindowsShellCommand(interpreter: "powershell" | "cmd", command: string): string {
  if (interpreter === "cmd") {
    return `cmd.exe /c ${JSON.stringify(command)}`;
  }

  return `powershell.exe -NoProfile -NonInteractive -Command ${JSON.stringify(command)}`;
}
