import ssh2 from "ssh2";
import { z } from "zod";
import type { ClusterConfig, RuntimeConfig, SshProfileConfig } from "./config.js";
import { ProxmoxApiClient } from "./api.js";
import { type SecretDocument, type SecretRecord, type SecretStore, createSecretDocument, getSecret, summarizeSecretDocument, upsertSecret } from "./admin-secrets.js";
import { SshExecutor } from "./ssh.js";
import { nowIso, shellQuote } from "./utils.js";

const { utils: sshUtils } = ssh2;

export type BootstrapHostKeyPolicy = "strict" | "accept-new" | "insecure";

export interface BootstrapConnection {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  hostKeyPolicy?: BootstrapHostKeyPolicy;
  expectedHostKey?: string;
}

export interface AdminIdentityOptions {
  cluster: string;
  node: string;
  apiUser: string;
  apiRealm: string;
  tokenId: string;
  tokenComment?: string;
  tokenExpireSeconds?: number;
  shellUsername: string;
  sudoersAllowlist?: string[];
  shellReference?: string;
}

export interface AdminEnrollmentOptions extends AdminIdentityOptions {
  bootstrap: BootstrapConnection;
  secretStore: SecretStore;
  shellKeyPair?: { privateKey: string; publicKey: string };
}

export interface AdminRotationOptions extends AdminEnrollmentOptions {
  retainOldSecrets?: boolean;
}

export interface AdminDeprovisionOptions extends AdminIdentityOptions {
  bootstrap: BootstrapConnection;
  secretStore: SecretStore;
}

export interface SecretSummary {
  id: string;
  kind: SecretRecord["kind"];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AdminStatus {
  count: number;
  records: SecretSummary[];
}

export interface ProvisionedEnrollmentResult {
  cluster: string;
  node: string;
  apiTokenId: string;
  shellUsername: string;
  shellReference?: string;
  secretIds: string[];
  validated: boolean;
  hostKeyPolicy: BootstrapHostKeyPolicy;
  tokenExpiresAt?: string;
}

export interface RotationResult extends ProvisionedEnrollmentResult {
  retiredSecretIds: string[];
}

const allowlistDefaults = [
  "/usr/bin/pvesh",
  "/usr/sbin/qm",
  "/usr/sbin/pct",
  "/usr/bin/pvesm",
  "/usr/sbin/pveum",
  "/usr/bin/pvenode",
  "/usr/bin/pvecm",
  "/usr/bin/pveceph",
  "/usr/bin/pvesr",
  "/usr/bin/vzdump",
  "/usr/bin/apt",
];

const commandResultSchema = z.object({
  node: z.string().min(1),
  fullTokenId: z.string().min(1),
  value: z.string().min(1),
  expire: z.number().int().positive(),
});

function makeSecretBase(id: string, kind: SecretRecord["kind"], metadata: Record<string, unknown> = {}) {
  const timestamp = nowIso();
  return {
    id,
    kind,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      lifecycle: "active",
      ...metadata,
    },
  } as const;
}

export function generateShellKeyPair(comment = "proxmox-mcp-shell"): { privateKey: string; publicKey: string } {
  const pair = sshUtils.generateKeyPairSync("ed25519", { comment });
  return {
    privateKey: pair.private,
    publicKey: pair.public,
  };
}

export function buildApiTokenSecretId(options: AdminIdentityOptions): string {
  return `${options.cluster}:api-token:${options.apiUser}@${options.apiRealm}!${options.tokenId}`;
}

export function buildShellKeySecretId(options: AdminIdentityOptions): string {
  return `${options.cluster}:shell-key:${options.node}:${options.shellUsername}`;
}

export function buildShellReferenceSecretId(options: AdminIdentityOptions): string {
  return `${options.cluster}:shell-reference:${options.node}:${options.shellUsername}`;
}

export function buildSudoersLine(shellUsername: string, allowlist: string[] = allowlistDefaults): string {
  const normalized = allowlist.length > 0 ? allowlist : allowlistDefaults;
  return `${shellUsername} ALL=(ALL) NOPASSWD: ${normalized.join(", ")}`;
}

export function buildEnrollmentScript(
  options: AdminEnrollmentOptions,
  shellPublicKey: string,
  mode: "enroll" | "rotate" = "enroll",
): string {
  const tokenExpire = Math.floor(Date.now() / 1000) + (options.tokenExpireSeconds ?? 20 * 60);
  const apiUserId = `${options.apiUser}@${options.apiRealm}`;
  const shellHome = `/home/${options.shellUsername}`;
  const sudoersPath = "/etc/sudoers.d/proxmox-mcp-shell";
  const allowlist = buildSudoersLine(options.shellUsername, options.sudoersAllowlist);

  return [
    "set -euo pipefail",
    `api_user=${shellQuote(options.apiUser)}`,
    `api_realm=${shellQuote(options.apiRealm)}`,
    `api_userid=${shellQuote(apiUserId)}`,
    `token_id=${shellQuote(options.tokenId)}`,
    `token_comment=${shellQuote(options.tokenComment ?? "proxmox-mcp admin enrollment")}`,
    `token_expire=${shellQuote(String(tokenExpire))}`,
    `shell_user=${shellQuote(options.shellUsername)}`,
    `shell_home=${shellQuote(shellHome)}`,
    `shell_pubkey=${shellQuote(shellPublicKey)}`,
    `sudoers_path=${shellQuote(sudoersPath)}`,
    `sudoers_line=${shellQuote(allowlist)}`,
    "node_name=$(hostname -s 2>/dev/null || hostname)",
    "if ! id -u \"$shell_user\" >/dev/null 2>&1; then useradd -m -s /bin/bash \"$shell_user\"; fi",
    "install -d -m 0700 \"$shell_home/.ssh\"",
    "cat > \"$shell_home/.ssh/authorized_keys\" <<'EOF'",
    shellPublicKey,
    "EOF",
    `chown -R "$shell_user:$shell_user" "$shell_home/.ssh"`,
    `chmod 0600 "$shell_home/.ssh/authorized_keys"`,
    "install -d -m 0755 /etc/sudoers.d",
    "cat > \"$sudoers_path\" <<'EOF'",
    allowlist,
    "EOF",
    "chmod 0440 \"$sudoers_path\"",
    "if command -v visudo >/dev/null 2>&1; then visudo -cf \"$sudoers_path\" >/dev/null; fi",
    "pveum user add \"$api_userid\" --comment \"$token_comment\" >/dev/null 2>&1 || true",
    "pveum user modify \"$api_userid\" --enable 1 --comment \"$token_comment\" >/dev/null 2>&1 || true",
    "pveum acl modify / --users \"$api_userid\" --roles Administrator >/dev/null",
    `pveum user token delete "$api_userid" "$token_id" >/dev/null 2>&1 || true`,
    `token_json=$(pveum user token add "$api_userid" "$token_id" --comment "$token_comment" --privsep 0 --expire "$token_expire" --output-format json)`,
    "export TOKEN_JSON=\"$token_json\"",
    "export NODE_NAME=\"$node_name\"",
    "python3 - <<'PY'",
    "import json, os",
    "token = json.loads(os.environ['TOKEN_JSON'])",
    "print(json.dumps({",
    "  'node': os.environ['NODE_NAME'],",
    "  'fullTokenId': token['full-tokenid'],",
    "  'value': token['value'],",
    `  'expire': ${tokenExpire},`,
    `  'mode': ${JSON.stringify(mode)},`,
    "}))",
    "PY",
  ].join("\n");
}

function buildBootstrapProfile(connection: BootstrapConnection): SshProfileConfig {
  return {
    name: "__admin_bootstrap__",
    username: connection.username,
    port: connection.port ?? 22,
    password: connection.password,
    privateKey: connection.privateKey,
    passphrase: connection.passphrase,
    hostKeyPolicy: connection.hostKeyPolicy ?? "strict",
    expectedHostKey: connection.expectedHostKey,
    shell: "/bin/sh",
    prefixCommand: [],
  };
}

async function execBootstrapCommand(connection: BootstrapConnection, command: string): Promise<string> {
  const executor = new SshExecutor();
  const target = { host: connection.host, port: connection.port ?? 22, profile: buildBootstrapProfile(connection) };
  const result = await executor.exec(target, command);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Bootstrap command failed for ${connection.host}`);
  }
  return result.stdout.trim();
}

async function detectBootstrapMode(connection: BootstrapConnection): Promise<"root" | "sudo"> {
  const direct = await execBootstrapCommand(connection, "/bin/sh -lc 'id -u'");
  if (direct.trim() === "0") {
    return "root";
  }

  if (!connection.password) {
    throw new Error("Bootstrap SSH access requires root or password-based sudo");
  }

  const sudoCheck = await execBootstrapCommand(
    connection,
    `/bin/sh -lc ${shellQuote(`printf '%s\n' ${shellQuote(connection.password)} | sudo -S -p '' id -u`)}`,
  );
  if (sudoCheck.trim() !== "0") {
    throw new Error("Bootstrap account does not have root or password-based sudo access");
  }

  return "sudo";
}

async function runBootstrapScript(connection: BootstrapConnection, script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const body = `printf %s ${shellQuote(encoded)} | base64 -d | bash`;
  const mode = await detectBootstrapMode(connection);

  if (mode === "root") {
    return execBootstrapCommand(connection, `/bin/sh -lc ${shellQuote(body)}`);
  }

  return execBootstrapCommand(
    connection,
    `/bin/sh -lc ${shellQuote(`printf '%s\n' ${shellQuote(connection.password!)} | sudo -S -p '' /bin/bash -lc ${shellQuote(body)}`)}`,
  );
}

function makeApiTokenRecord(options: AdminIdentityOptions, tokenSecret: string, expireAt: string): SecretRecord {
  return {
    ...makeSecretBase(buildApiTokenSecretId(options), "proxmox_api_token", {
      cluster: options.cluster,
      node: options.node,
      purpose: "typed-api",
    }),
    kind: "proxmox_api_token",
    user: options.apiUser,
    realm: options.apiRealm,
    tokenId: options.tokenId,
    secret: tokenSecret,
    comment: options.tokenComment,
    expireAt,
  };
}

function makeShellKeyRecord(
  options: AdminIdentityOptions,
  keyPair: { privateKey: string; publicKey: string },
  bootstrap: BootstrapConnection,
): SecretRecord {
  return {
    ...makeSecretBase(buildShellKeySecretId(options), "shell_ssh_key", {
      cluster: options.cluster,
      node: options.node,
      purpose: "high-risk-shell",
      hostKeyPolicy: bootstrap.hostKeyPolicy ?? "strict",
      expectedHostKey: bootstrap.expectedHostKey,
    }),
    kind: "shell_ssh_key",
    username: options.shellUsername,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
}

function makeShellReferenceRecord(options: AdminIdentityOptions, reference: string, bootstrap: BootstrapConnection): SecretRecord {
  return {
    ...makeSecretBase(buildShellReferenceSecretId(options), "shell_ssh_reference", {
      cluster: options.cluster,
      node: options.node,
      purpose: "high-risk-shell-reference",
      hostKeyPolicy: bootstrap.hostKeyPolicy ?? "strict",
      expectedHostKey: bootstrap.expectedHostKey,
    }),
    kind: "shell_ssh_reference",
    username: options.shellUsername,
    reference,
  };
}

function validateDocument(document: SecretDocument): void {
  if (document.version !== 1) {
    throw new Error(`Unsupported secret document version ${document.version}`);
  }
}

async function validateApiToken(cluster: ClusterConfig, tokenRecord: Extract<SecretRecord, { kind: "proxmox_api_token" }>): Promise<void> {
  const client = new ProxmoxApiClient({
    ...cluster,
    auth: {
      type: "api_token",
      user: tokenRecord.user,
      realm: tokenRecord.realm,
      tokenId: tokenRecord.tokenId,
      secret: tokenRecord.secret,
    },
  });

  await client.request("GET", "/version");
}

async function validateShellKey(connection: BootstrapConnection, options: AdminIdentityOptions, keyRecord: Extract<SecretRecord, { kind: "shell_ssh_key" }>): Promise<void> {
  const executor = new SshExecutor();
  const result = await executor.exec(
    {
      host: connection.host,
      port: connection.port ?? 22,
      profile: {
        name: "__validated_shell__",
        username: keyRecord.username,
        port: connection.port ?? 22,
        privateKey: keyRecord.privateKey,
        passphrase: keyRecord.passphrase,
        hostKeyPolicy: connection.hostKeyPolicy ?? "strict",
        expectedHostKey: connection.expectedHostKey,
        shell: "/bin/sh",
        prefixCommand: [],
      },
    },
    "id -u && hostname -s",
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Shell validation failed for ${options.shellUsername}`);
  }
}

export function createAdminStatus(document: SecretDocument): AdminStatus {
  validateDocument(document);
  return {
    count: document.records.length,
    records: summarizeSecretDocument(document),
  };
}

export async function enroll(options: AdminEnrollmentOptions): Promise<ProvisionedEnrollmentResult> {
  const keyPair = options.shellKeyPair ?? generateShellKeyPair(options.shellUsername);
  const script = buildEnrollmentScript(options, keyPair.publicKey, "enroll");
  const stdout = await runBootstrapScript(options.bootstrap, script);
  const parsed = commandResultSchema.parse(JSON.parse(stdout));
  const expireAt = new Date(parsed.expire * 1000).toISOString();
  const shellReference = options.shellReference ?? `${options.cluster}:${options.node}:${options.shellUsername}`;
  const nextDocument = upsertSecret(
    upsertSecret(
      createSecretDocument(),
      makeApiTokenRecord(options, parsed.value, expireAt),
    ),
    options.shellReference ? makeShellReferenceRecord(options, shellReference, options.bootstrap) : makeShellKeyRecord(options, keyPair, options.bootstrap),
  );

  await options.secretStore.write(nextDocument);

  const clusterConfig: ClusterConfig = {
    name: options.cluster,
    host: options.bootstrap.host,
    apiUrl: `https://${options.bootstrap.host}:8006`,
    apiPort: 8006,
    sshPort: options.bootstrap.port ?? 22,
    defaultBridge: "vmbr0",
    defaultSnippetStorage: "local",
    auth: {
      type: "api_token",
      user: options.apiUser,
      realm: options.apiRealm,
      tokenId: options.tokenId,
      secret: parsed.value,
    },
    tls: { rejectUnauthorized: false },
    nodes: [{ name: options.node, host: options.bootstrap.host, port: options.bootstrap.port ?? 22, sshProfile: "__validated_shell__" }],
  };

  await validateApiToken(clusterConfig, getSecret(nextDocument, buildApiTokenSecretId(options)) as Extract<SecretRecord, { kind: "proxmox_api_token" }>);
  if (!options.shellReference) {
    await validateShellKey(options.bootstrap, options, getSecret(nextDocument, buildShellKeySecretId(options)) as Extract<SecretRecord, { kind: "shell_ssh_key" }>);
  }

  return {
    cluster: options.cluster,
    node: parsed.node,
    apiTokenId: buildApiTokenSecretId(options),
    shellUsername: options.shellUsername,
    shellReference,
    secretIds: nextDocument.records.map((record) => record.id),
    validated: true,
    hostKeyPolicy: options.bootstrap.hostKeyPolicy ?? "strict",
    tokenExpiresAt: expireAt,
  };
}

export async function rotate(options: AdminRotationOptions): Promise<RotationResult> {
  const current = await options.secretStore.read();
  const retiredSecretIds = current.records.map((record) => record.id);
  const enrollment = await enroll(options);

  return {
    ...enrollment,
    retiredSecretIds,
  };
}

export async function status(secretStore: SecretStore): Promise<AdminStatus> {
  return createAdminStatus(await secretStore.read());
}

export async function deprovision(options: AdminDeprovisionOptions): Promise<{ deleted: boolean; retiredSecretIds: string[] }> {
  const document = await options.secretStore.read();
  const retiredSecretIds = document.records.map((record) => record.id);
  const tokenRecord = getSecret(document, buildApiTokenSecretId(options));
  const keyRecord = getSecret(document, buildShellKeySecretId(options));
  const referenceRecord = getSecret(document, buildShellReferenceSecretId(options));

  if (!tokenRecord && !keyRecord && !referenceRecord) {
    return { deleted: false, retiredSecretIds };
  }

  const script = [
    "set -euo pipefail",
    `api_userid=${shellQuote(`${options.apiUser}@${options.apiRealm}`)}`,
    `token_id=${shellQuote(options.tokenId)}`,
    `shell_user=${shellQuote(options.shellUsername)}`,
    "pveum user token delete \"$api_userid\" \"$token_id\" >/dev/null 2>&1 || true",
    "pveum user delete \"$api_userid\" >/dev/null 2>&1 || true",
    "rm -f /etc/sudoers.d/proxmox-mcp-shell",
    "if id -u \"$shell_user\" >/dev/null 2>&1; then userdel -r \"$shell_user\" >/dev/null 2>&1 || true; fi",
  ].join("\n");

  await runBootstrapScript(options.bootstrap, script);
  await options.secretStore.delete();
  return { deleted: true, retiredSecretIds };
}

export function buildRuntimeClusterFromEnrollment(options: AdminEnrollmentOptions, tokenSecret: string): ClusterConfig {
  return {
    name: options.cluster,
    host: options.bootstrap.host,
    apiUrl: `https://${options.bootstrap.host}:8006`,
    apiPort: 8006,
    sshPort: options.bootstrap.port ?? 22,
    defaultBridge: "vmbr0",
    defaultSnippetStorage: "local",
    auth: {
      type: "api_token",
      user: options.apiUser,
      realm: options.apiRealm,
      tokenId: options.tokenId,
      secret: tokenSecret,
    },
    tls: { rejectUnauthorized: false },
    nodes: [
      {
        name: options.node,
        host: options.bootstrap.host,
        port: options.bootstrap.port ?? 22,
        sshProfile: "__validated_shell__",
      },
    ],
  };
}
