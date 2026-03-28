import type { RuntimeConfig, SshProfileConfig } from "./config.js";
import { refreshRuntimeIndexes, runtimeShellProfileForCluster } from "./config.js";
import { ManagedAuthLifecycle } from "./managed-auth.js";
import {
  apiTokenConfigured,
  createSecretStore,
  shellSecretConfigured,
  type RuntimeSecretBundle,
  type SecretStore,
} from "./secrets.js";

/** Result of bootstrapping runtime config plus any optional local-maintainer auth coordinator. */
export interface RuntimeInitializationResult {
  config: RuntimeConfig;
  authLifecycle?: ManagedAuthLifecycle;
  secretStore: SecretStore;
  reloadSecrets: () => Promise<void>;
}

function upsertSshProfile(config: RuntimeConfig, profile: SshProfileConfig): void {
  const index = config.sshProfiles.findIndex((entry) => entry.name === profile.name);
  if (index >= 0) {
    config.sshProfiles[index] = profile;
  } else {
    config.sshProfiles.push(profile);
  }
}

function removeSshProfile(config: RuntimeConfig, profileName: string): void {
  const index = config.sshProfiles.findIndex((entry) => entry.name === profileName);
  if (index >= 0) {
    config.sshProfiles.splice(index, 1);
  }
}

function applyRuntimeShellSecret(config: RuntimeConfig, clusterName: string, bundle: RuntimeSecretBundle | undefined): void {
  const cluster = config.clusterMap.get(clusterName);
  if (!cluster) {
    throw new Error(`Unknown cluster '${clusterName}'`);
  }

  const profileName = runtimeShellProfileForCluster(clusterName);
  if (!shellSecretConfigured(bundle)) {
    removeSshProfile(config, profileName);
    refreshRuntimeIndexes(config);
    return;
  }

  const shell = bundle!.shellSsh!;
  upsertSshProfile(config, {
    name: profileName,
    username: shell.username,
    port: shell.port ?? cluster.sshPort,
    privateKey: shell.privateKey,
    privateKeyPath: shell.privateKeyPath,
    publicKey: shell.publicKey,
    publicKeyPath: shell.publicKeyPath,
    passphrase: shell.passphrase,
    hostKeyPolicy: shell.hostKeyPolicy ?? "strict",
    expectedHostKey: shell.expectedHostKey,
    shell: shell.shell ?? "/bin/sh",
    prefixCommand: shell.prefixCommand ?? [],
  });

  if (cluster.defaultNode && !cluster.nodes.some((entry) => entry.name === cluster.defaultNode)) {
    cluster.nodes.push({
      name: cluster.defaultNode,
      host: cluster.host,
      port: cluster.sshPort,
      sshProfile: profileName,
    });
  }

  cluster.nodes = cluster.nodes.map((entry) =>
    entry.sshProfile === profileName || entry.sshProfile.startsWith("__runtime_shell_")
      ? { ...entry, sshProfile: profileName }
      : entry,
  );

  refreshRuntimeIndexes(config);
}

function applyRuntimeApiSecret(config: RuntimeConfig, clusterName: string, bundle: RuntimeSecretBundle | undefined): void {
  const cluster = config.clusterMap.get(clusterName);
  if (!cluster) {
    throw new Error(`Unknown cluster '${clusterName}'`);
  }

  if (!apiTokenConfigured(bundle)) {
    throw new Error(`Missing steady-state API token secret for cluster '${clusterName}' in ${config.secretStore.type} backend`);
  }

  cluster.auth = {
    type: "api_token",
    user: bundle!.apiToken!.user,
    realm: bundle!.apiToken!.realm,
    tokenId: bundle!.apiToken!.tokenId,
    secret: bundle!.apiToken!.secret,
  };
}

async function hydrateSteadyStateSecrets(config: RuntimeConfig, secretStore: SecretStore): Promise<void> {
  for (const cluster of config.clusters) {
    if (cluster.auth.type !== "secret_ref") {
      continue;
    }

    const secretCluster = cluster.auth.secretCluster ?? cluster.name;
    const bundle = await secretStore.getClusterSecrets(secretCluster);
    applyRuntimeApiSecret(config, cluster.name, bundle);
    applyRuntimeShellSecret(config, cluster.name, bundle);
  }

  refreshRuntimeIndexes(config);
}

/**
 * Resolves steady-state runtime credentials from the configured secret backend before the server starts.
 *
 * Local bootstrap remains available only for explicit stdio maintainer mode and should not be used for
 * production HTTP deployments.
 */
export async function initializeRuntimeConfig(config: RuntimeConfig): Promise<RuntimeInitializationResult> {
  const secretStore = createSecretStore(config);
  const reloadSecrets = async () => hydrateSteadyStateSecrets(config, secretStore);

  if (config.clusters.some((cluster) => cluster.auth.type === "secret_ref")) {
    await reloadSecrets();
  }

  let authLifecycle: ManagedAuthLifecycle | undefined;
  if (config.clusters.some((cluster) => cluster.auth.type === "ssh_bootstrap")) {
    if (!(config.mode === "stdio" && config.mcpAuth.mode === "none" && config.localBootstrap.enabled)) {
      throw new Error("ssh_bootstrap auth is only allowed for explicit local stdio maintainer mode.");
    }

    authLifecycle = new ManagedAuthLifecycle(config);
    await authLifecycle.initialize();
  }

  return {
    config,
    authLifecycle,
    secretStore,
    reloadSecrets,
  };
}
