import type { ServerContext } from "../../mcp-common.js";
import { textResult } from "../../mcp-common.js";
import { createClusterSchema } from "../../tool-inputs.js";

/** Registers access and identity primitives. */
export function registerAccessTools(context: ServerContext) {
  const { server, domains } = context;
  const clusterSchema = createClusterSchema(context.config);

  // Uses: `/access/users`.
  server.registerTool(
    "proxmox_user_list",
    {
      description: "List Proxmox users.",
      inputSchema: { cluster: clusterSchema },
    },
    async ({ cluster }) => textResult(`Users for ${cluster}`, (await domains.access.listUsers(cluster)).data),
  );
}
