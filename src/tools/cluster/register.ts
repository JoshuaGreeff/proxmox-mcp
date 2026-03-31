import { z } from "zod";
import type { ServerContext } from "../../mcp-common.js";
import { textResult } from "../../mcp-common.js";
import { commonExecutionSchema } from "../../mcp-common.js";
import { createClusterSchema } from "../../tool-inputs.js";

/** Registers cluster-scoped inventory and status primitives. */
export function registerClusterTools(context: ServerContext) {
  const { server, domains } = context;
  const clusterSchema = createClusterSchema(context.config);
  const pciMappingIdSchema = z.string().describe("Logical cluster-wide PCI mapping ID.");

  // Uses: `/cluster/resources`, `/cluster/status`, and `/version` through the cluster domain service.
  server.registerTool(
    "proxmox_inventory_overview",
    {
      description: "Return cluster inventory and discovered capabilities for nodes, VMs, containers, and storages. In a single-cluster setup, `cluster` may be omitted.",
      inputSchema: {
        cluster: clusterSchema,
        probeRemote: z.boolean().default(false).describe("Whether to probe for docker and remote shell reachability where possible."),
        forceRefresh: z.boolean().default(false).describe("Whether to bypass the in-memory inventory cache."),
      },
    },
    async ({ cluster, probeRemote, forceRefresh }) =>
      textResult(`Inventory overview for ${cluster}`, await domains.cluster.inventoryOverview(cluster, { probeRemote, forceRefresh })),
  );

  // Uses: `/cluster/status` and `/version`.
  server.registerTool(
    "proxmox_cluster_status",
    {
      description: "Return cluster status and version information for a configured cluster alias. In a single-cluster setup, `cluster` may be omitted.",
      inputSchema: { cluster: clusterSchema },
    },
    async ({ cluster }) => textResult(`Cluster status for ${cluster}`, await domains.cluster.getStatus(cluster)),
  );

  // Uses: `/cluster/mapping/pci`.
  server.registerTool(
    "proxmox_pci_mapping_list",
    {
      description: "List cluster PCI resource mappings through the documented REST endpoint.",
      inputSchema: {
        cluster: clusterSchema,
        checkNode: z.string().optional().describe("Optional node name used for Proxmox mapping diagnostics."),
      },
    },
    async ({ cluster, checkNode }) =>
      textResult(`PCI mappings for ${cluster}`, (await domains.cluster.listPciMappings(cluster, checkNode)).data),
  );

  // Uses: `/cluster/mapping/pci/{id}`.
  server.registerTool(
    "proxmox_pci_mapping_get",
    {
      description: "Get a single cluster PCI resource mapping by ID.",
      inputSchema: {
        cluster: clusterSchema,
        id: pciMappingIdSchema,
      },
    },
    async ({ cluster, id }) => textResult(`PCI mapping ${id}`, (await domains.cluster.getPciMapping(cluster, id)).data),
  );

  // Uses: `/cluster/mapping/pci`.
  server.registerTool(
    "proxmox_pci_mapping_create",
    {
      description: "Create a cluster PCI resource mapping through the documented REST endpoint.",
      inputSchema: {
        cluster: clusterSchema,
        id: pciMappingIdSchema,
        map: z.array(z.string()).min(1).describe("One or more Proxmox map entries such as `node=pve-example,path=0000:21:00,id=10de:2204`."),
        description: z.string().optional().describe("Optional logical mapping description."),
        mdev: z.boolean().optional().describe("Whether the mapped PCI devices can provide mediated devices."),
        liveMigrationCapable: z.boolean().optional().describe("Whether the mapped device is marked as live-migration capable."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, id, map, description, mdev, liveMigrationCapable, timeoutMs }) =>
      textResult(
        `PCI mapping ${id} created`,
        (await domains.cluster.createPciMapping(
          cluster,
          {
            id,
            map,
            ...(description !== undefined ? { description } : {}),
            ...(mdev !== undefined ? { mdev } : {}),
            ...(liveMigrationCapable !== undefined ? { "live-migration-capable": liveMigrationCapable } : {}),
          },
          timeoutMs,
        )).data,
      ),
  );

  // Uses: `/cluster/mapping/pci/{id}`.
  server.registerTool(
    "proxmox_pci_mapping_update",
    {
      description: "Update a cluster PCI resource mapping through the documented REST endpoint.",
      inputSchema: {
        cluster: clusterSchema,
        id: pciMappingIdSchema,
        map: z.array(z.string()).optional().describe("Replacement Proxmox map entries."),
        description: z.string().optional().describe("Optional logical mapping description."),
        mdev: z.boolean().optional().describe("Whether the mapped PCI devices can provide mediated devices."),
        liveMigrationCapable: z.boolean().optional().describe("Whether the mapped device is marked as live-migration capable."),
        delete: z.string().optional().describe("Optional comma-separated list of mapping fields to delete."),
        digest: z.string().optional().describe("Optional config digest for concurrent-modification protection."),
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, id, map, description, mdev, liveMigrationCapable, delete: deleteFields, digest, timeoutMs }) =>
      textResult(
        `PCI mapping ${id} updated`,
        (await domains.cluster.updatePciMapping(
          cluster,
          id,
          {
            id,
            ...(map !== undefined ? { map } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(mdev !== undefined ? { mdev } : {}),
            ...(liveMigrationCapable !== undefined ? { "live-migration-capable": liveMigrationCapable } : {}),
            ...(deleteFields !== undefined ? { delete: deleteFields } : {}),
            ...(digest !== undefined ? { digest } : {}),
          },
          timeoutMs,
        )).data,
      ),
  );

  // Uses: `/cluster/mapping/pci/{id}`.
  server.registerTool(
    "proxmox_pci_mapping_delete",
    {
      description: "Delete a cluster PCI resource mapping by ID.",
      inputSchema: {
        cluster: clusterSchema,
        id: pciMappingIdSchema,
        ...commonExecutionSchema,
      },
    },
    async ({ cluster, id, timeoutMs }) =>
      textResult(`PCI mapping ${id} deleted`, (await domains.cluster.deletePciMapping(cluster, id, timeoutMs)).data),
  );
}
