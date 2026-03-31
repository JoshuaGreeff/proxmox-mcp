import { z } from "zod";
import type { RuntimeConfig } from "./config.js";

function configuredClusterNames(config: RuntimeConfig): string[] {
  return config.clusters.map((cluster) => cluster.name);
}

function clusterErrorMessage(config: RuntimeConfig): string {
  const names = configuredClusterNames(config);
  if (names.length === 1) {
    return `\`cluster\` must be the configured cluster alias. Omit it only when the server has exactly one configured cluster; this server will then use \`${names[0]}\`.`;
  }

  if (names.length > 1) {
    return `\`cluster\` must be one of the configured cluster aliases: ${names.map((name) => `\`${name}\``).join(", ")}.`;
  }

  return "`cluster` must be a configured cluster alias.";
}

function normalizeVmidInput(value: unknown): unknown {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return value;
}

export function createClusterSchema(config: RuntimeConfig) {
  const names = configuredClusterNames(config);
  const description =
    names.length === 1
      ? `Configured cluster alias. Omit this when exactly one cluster is configured; the server will use \`${names[0]}\`.`
      : "Configured cluster alias.";
  const base = z
    .string({
      error: () => clusterErrorMessage(config),
    })
    .trim()
    .min(1, clusterErrorMessage(config))
    .describe(description);

  if (names.length === 1) {
    return z.preprocess((value) => (value === undefined ? names[0] : typeof value === "string" ? value.trim() : value), base);
  }

  return z.preprocess((value) => (typeof value === "string" ? value.trim() : value), base);
}

export function createVmidSchema(description = "QEMU VM numeric ID.") {
  const message = "`vmid` must be a positive integer or a digit-only string such as `100`.";
  return z.preprocess(
    normalizeVmidInput,
    z
      .number({
        error: () => message,
      })
      .int(message)
      .positive(message)
      .describe(description),
  );
}

export function createCommandStringSchema(description: string) {
  const message =
    "`command` must be a single command string. Use `interpreter` to select `bash`, `sh`, `powershell`, or `cmd`; do not pass argv arrays such as `[\"bash\", \"-lc\", \"uname -a\"]`.";
  return z
    .string({
      error: () => message,
    })
    .min(1, message)
    .describe(description);
}
