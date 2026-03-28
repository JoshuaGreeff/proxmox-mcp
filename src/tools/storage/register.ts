import { z } from "zod";
import type { ServerContext } from "../../mcp-common.js";
import { artifactResult, commonExecutionSchema, completedJobResult, emitProgress, jobHandleResult, settleJob, textResult } from "../../mcp-common.js";
import type { TargetRef } from "../../types.js";

/** Registers storage and cloud-init snippet primitives. */
export function registerStorageTools(context: ServerContext) {
  const { server, domains, service, jobManager, artifacts } = context;
  const clusterSchema = z.string().describe("Configured cluster alias.");
  const nodeSchema = z.string().describe("Proxmox node name.");

  server.registerTool("proxmox_storage_list", { description: "List storages visible to the cluster.", inputSchema: { cluster: clusterSchema } }, async ({ cluster }) =>
    textResult(`Storages for ${cluster}`, (await domains.storage.list(cluster)).data),
  );

  server.registerTool(
    "proxmox_storage_get",
    { description: "Get a specific storage definition.", inputSchema: { cluster: clusterSchema, storage: z.string().min(1) } },
    async ({ cluster, storage }) => textResult(`Storage ${storage}`, (await domains.storage.get(cluster, storage)).data),
  );

  // Uses: `/nodes/{node}/storage/{storage}/download-url`.
  server.registerTool(
    "proxmox_storage_download_url",
    {
      description: "Download a file into Proxmox storage through the documented download-url endpoint.",
      inputSchema: {
        cluster: clusterSchema,
        node: nodeSchema,
        storage: z.string().min(1).describe("Proxmox storage identifier."),
        content: z.enum(["iso", "vztmpl", "import"]).describe("Storage content type for the downloaded file."),
        filename: z.string().min(1).describe("Destination filename inside the storage content area."),
        url: z.string().url().describe("HTTP or HTTPS URL to download."),
        verifyCertificates: z.boolean().optional().describe("Whether to verify TLS certificates for the remote URL."),
        checksum: z.string().optional().describe("Optional expected checksum."),
        checksumAlgorithm: z.enum(["md5", "sha1", "sha224", "sha256", "sha384", "sha512"]).optional().describe("Checksum algorithm used with checksum."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, node, storage, content, filename, url, verifyCertificates, checksum, checksumAlgorithm, waitMode, timeoutMs, pollIntervalMs }, extra) => {
      const target: TargetRef = { cluster, kind: "node", node };
      const response = await domains.storage.downloadUrl(
        cluster,
        node,
        storage,
        { content, filename, url, verifyCertificates, checksum, checksumAlgorithm },
        timeoutMs,
        extra.signal,
      );
      if (!response.upid) {
        return textResult(`Storage download to ${storage} completed`, response.data);
      }

      const job = jobManager.create(target, "storage:download_url");
      job.relatedUpid = response.upid;
      jobManager.run(job.jobId, async (jobContext) => {
        jobContext.setRelatedUpid(response.upid!);
        return service.waitForUpid(cluster, response.upid!, pollIntervalMs ?? 2_000, jobContext.signal, async (progress) => {
          jobContext.setProgress(progress.progress, progress.total, progress.message);
          await emitProgress(extra, progress);
        });
      });

      const settled = await settleJob(jobManager, job.jobId, waitMode);
      return settled ? completedJobResult(settled, `Storage download to ${storage} finished`) : jobHandleResult(job, `Storage download to ${storage} running`);
    },
  );

  // Uses: validated snippet storage fallback over SSH/file because Proxmox REST does not expose generic snippet CRUD.
  server.registerTool(
    "proxmox_cloud_init_snippet_list",
    {
      description: "List cloud-init snippets on snippet-capable Proxmox storage.",
      inputSchema: {
        cluster: clusterSchema,
        node: z.string().optional().describe("Optional Proxmox node. Uses cluster default when omitted."),
        storage: z.string().optional().describe("Optional snippet storage override. Defaults to cluster defaultSnippetStorage."),
      },
    },
    async ({ cluster, node, storage }, extra) => textResult(`Cloud-init snippets for ${cluster}`, await domains.storage.listSnippets(cluster, node, storage, extra.signal)),
  );

  // Uses: validated snippet storage fallback over SSH/file because Proxmox REST does not expose generic snippet file CRUD.
  server.registerTool(
    "proxmox_cloud_init_snippet_get",
    {
      description: "Read a cloud-init snippet from Proxmox snippet storage.",
      inputSchema: {
        cluster: clusterSchema,
        node: z.string().optional(),
        storage: z.string().optional(),
        snippetPath: z.string().min(1).describe("Snippet path relative to the storage snippets root."),
      },
    },
    async ({ cluster, node, storage, snippetPath }, extra) => {
      const result = await domains.storage.getSnippet(cluster, node, storage, snippetPath, extra.signal);
      return artifactResult(`Cloud-init snippet ${snippetPath}`, artifacts, {
        kind: "cloud_init",
        mimeType: "text/yaml",
        data: Buffer.from(result.content, "utf8"),
        summary: {
          cluster: result.cluster,
          node: result.node,
          storage: result.storage,
          path: result.path,
          volumeId: result.volumeId,
        },
      });
    },
  );

  // Uses: validated snippet storage fallback over SSH/file; accepts inline text or artifact-backed input.
  server.registerTool(
    "proxmox_cloud_init_snippet_put",
    {
      description: "Write a cloud-init snippet onto snippet-capable Proxmox storage.",
      inputSchema: {
        cluster: clusterSchema,
        node: z.string().optional(),
        storage: z.string().optional(),
        snippetPath: z.string().min(1).describe("Snippet path relative to the storage snippets root."),
        content: z.string().optional().describe("Inline cloud-init YAML to write."),
        artifactId: z.string().optional().describe("Optional server artifact id to write instead of inline content."),
        resourceUri: z.string().optional().describe("Optional proxmox://artifacts/... URI to write instead of inline content."),
      },
    },
    async ({ cluster, node, storage, snippetPath, content, artifactId, resourceUri }, extra) => {
      if (content === undefined && !artifactId && !resourceUri) {
        throw new Error("Snippet write requires content, artifactId, or resourceUri");
      }
      const resolvedContent = artifactId || resourceUri ? await artifacts.readArtifactText({ artifactId, resourceUri }, service) : content!;
      return textResult(`Cloud-init snippet ${snippetPath} written`, await domains.storage.putSnippet(cluster, node, storage, snippetPath, resolvedContent, extra.signal));
    },
  );

  // Uses: validated snippet storage fallback over SSH/file because Proxmox REST does not expose generic snippet file CRUD.
  server.registerTool(
    "proxmox_cloud_init_snippet_delete",
    {
      description: "Delete a cloud-init snippet from Proxmox snippet storage.",
      inputSchema: {
        cluster: clusterSchema,
        node: z.string().optional(),
        storage: z.string().optional(),
        snippetPath: z.string().min(1).describe("Snippet path relative to the storage snippets root."),
      },
    },
    async ({ cluster, node, storage, snippetPath }, extra) =>
      textResult(`Cloud-init snippet ${snippetPath} deleted`, await domains.storage.deleteSnippet(cluster, node, storage, snippetPath, extra.signal)),
  );

  // Uses: `qm cloudinit dump` through the approved CLI surface until a clean REST equivalent is validated.
  server.registerTool(
    "proxmox_vm_cloud_init_dump",
    {
      description: "Dump the generated cloud-init user, network, or meta config for a VM or template.",
      inputSchema: {
        cluster: clusterSchema,
        vmid: z.number().int().positive(),
        section: z.enum(["user", "network", "meta"]).default("user"),
      },
    },
    async ({ cluster, vmid, section }, extra) => {
      const result = await service.dumpVmCloudInit(cluster, vmid, section, extra.signal);
      return artifactResult(`Cloud-init ${section} for VM ${vmid}`, artifacts, {
        kind: "cloud_init",
        mimeType: "text/yaml",
        data: Buffer.from(result.content, "utf8"),
        summary: {
          cluster: result.cluster,
          node: result.node,
          vmid: result.vmid,
          section: result.section,
        },
      });
    },
  );
}
