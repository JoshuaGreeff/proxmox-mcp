import fs from "node:fs/promises";
import { createSecretStore, type SecretStoreConfig } from "./admin-secrets.js";
import { deprovision, enroll, rotate, status, type AdminDeprovisionOptions, type AdminEnrollmentOptions, type AdminRotationOptions, type BootstrapConnection } from "./admin-enroll.js";

export type AdminCommandName = "enroll" | "rotate" | "status" | "deprovision";

export interface ParsedAdminArgs {
  command: AdminCommandName;
  options: Record<string, string | boolean | string[]>;
}

function toBoolean(value: string | boolean | string[] | undefined): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return toBoolean(value[0]);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }

  return ["1", "true", "yes", "on"].includes(normalized);
}

export function parseAdminArgs(argv: string[]): ParsedAdminArgs {
  const [command, ...rest] = argv;
  if (!command || !["enroll", "rotate", "status", "deprovision"].includes(command)) {
    throw new Error("Usage: proxmox-mcp-admin <enroll|rotate|status|deprovision> [--flags]");
  }

  const options: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index];
    if (entry === undefined) {
      throw new Error("Unexpected end of arguments");
    }
    if (!entry.startsWith("--")) {
      throw new Error(`Unexpected positional argument '${entry}'`);
    }

    const key = entry.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    index += 1;
    const current = options[key];
    if (current === undefined) {
      options[key] = next;
    } else if (Array.isArray(current)) {
      current.push(next);
    } else {
      options[key] = [String(current), next];
    }
  }

  return { command: command as AdminCommandName, options };
}

function getString(options: Record<string, string | boolean | string[]>, key: string, fallback = ""): string {
  const value = options[key];
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  return fallback;
}

function getStringArray(options: Record<string, string | boolean | string[]>, key: string): string[] {
  const value = options[key];
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return [value];
  }

  return [];
}

async function readFileIfPresent(filePath?: string): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  return fs.readFile(filePath, "utf8");
}

export function buildBootstrapConnection(options: Record<string, string | boolean | string[]>): BootstrapConnection {
  return {
    host: getString(options, "host"),
    port: getString(options, "bootstrap-port") ? Number.parseInt(getString(options, "bootstrap-port"), 10) : undefined,
    username: getString(options, "bootstrap-user"),
    password: getString(options, "bootstrap-password") || undefined,
    privateKey: getString(options, "bootstrap-private-key") || undefined,
    passphrase: getString(options, "bootstrap-passphrase") || undefined,
    hostKeyPolicy: (getString(options, "bootstrap-host-key-policy") as BootstrapConnection["hostKeyPolicy"]) || "strict",
    expectedHostKey: getString(options, "bootstrap-expected-host-key") || undefined,
  };
}

export function buildSecretStoreConfig(options: Record<string, string | boolean | string[]>): SecretStoreConfig {
  const backend = getString(options, "secret-backend", "env") as SecretStoreConfig["type"];
  if (backend === "file") {
    const filePath = getString(options, "secret-file");
    if (!filePath) {
      throw new Error("File secret backend requires --secret-file");
    }
    return { type: "file", filePath };
  }

  if (backend === "vault") {
    const baseUrl = getString(options, "vault-url");
    const token = getString(options, "vault-token");
    const mountPath = getString(options, "vault-mount", "secret");
    const secretPath = getString(options, "vault-path", "proxmox-mcp");
    if (!baseUrl || !token) {
      throw new Error("Vault secret backend requires --vault-url and --vault-token");
    }
    return {
      type: "vault",
      vault: {
        baseUrl,
        token,
        mountPath,
        secretPath,
        namespace: getString(options, "vault-namespace") || undefined,
        insecure: toBoolean(options["vault-insecure"]),
      },
    };
  }

  return {
    type: "env",
    envVarName: getString(options, "secret-env-var", "PROXMOX_MCP_SECRETS_JSON"),
  };
}

export async function runAdminCommand(argv: string[]): Promise<unknown> {
  const parsed = parseAdminArgs(argv);
  const secretStore = createSecretStore(buildSecretStoreConfig(parsed.options));

  if (parsed.command === "status") {
    return status(secretStore);
  }

  const common = {
    cluster: getString(parsed.options, "cluster", "default"),
    node: getString(parsed.options, "node"),
    apiUser: getString(parsed.options, "api-user", "mcp"),
    apiRealm: getString(parsed.options, "api-realm", "pam"),
    tokenId: getString(parsed.options, "token-id", "mcp"),
    tokenComment: getString(parsed.options, "token-comment") || undefined,
    tokenExpireSeconds: parsed.options["token-expire-seconds"] ? Number.parseInt(getString(parsed.options, "token-expire-seconds"), 10) : undefined,
    shellUsername: getString(parsed.options, "shell-username", "proxmox-mcp-shell"),
    sudoersAllowlist: getStringArray(parsed.options, "sudoers-allowlist"),
    shellReference: getString(parsed.options, "shell-reference") || undefined,
  };

  const bootstrap = buildBootstrapConnection(parsed.options);

  if (parsed.command === "enroll") {
    const shellPrivateKeyFile = getString(parsed.options, "shell-private-key-file") || undefined;
    const shellPublicKeyFile = getString(parsed.options, "shell-public-key-file") || undefined;
    if (Boolean(shellPrivateKeyFile) !== Boolean(shellPublicKeyFile)) {
      throw new Error("Provide both --shell-private-key-file and --shell-public-key-file, or neither");
    }
    let shellKeyPair: AdminEnrollmentOptions["shellKeyPair"] | undefined;
    if (shellPrivateKeyFile || shellPublicKeyFile) {
      shellKeyPair = {
        privateKey: (await readFileIfPresent(shellPrivateKeyFile)) ?? "",
        publicKey: (await readFileIfPresent(shellPublicKeyFile)) ?? "",
      };
    }

    return enroll({
      ...common,
      bootstrap,
      secretStore,
      shellKeyPair,
    });
  }

  if (parsed.command === "rotate") {
    const retainOldSecrets = toBoolean(parsed.options["retain-old-secrets"]);
    return rotate({
      ...common,
      bootstrap,
      secretStore,
      retainOldSecrets,
    } as AdminRotationOptions);
  }

  return deprovision({
    ...common,
    bootstrap,
    secretStore,
  } as AdminDeprovisionOptions);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runAdminCommand(argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
