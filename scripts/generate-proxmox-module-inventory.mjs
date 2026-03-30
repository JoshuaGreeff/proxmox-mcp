import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "vendor", "pve-docs", "api-viewer", "apidata.js");
const jsonOutPath = path.join(repoRoot, "docs", "proxmox", "module-inventory.json");
const markdownOutPath = path.join(repoRoot, "docs", "proxmox", "module-inventory.md");

const raw = fs.readFileSync(sourcePath, "utf8");
const sandbox = {};
vm.runInNewContext(`${raw}\nthis.apiSchema = apiSchema;`, sandbox);
const apiSchema = sandbox.apiSchema;

function walk(node, current = "") {
  const seg = node.text ? `/${node.text}` : "";
  const pathValue = `${current}${seg}` || "/";
  const paths = node.info ? [pathValue] : [];
  for (const child of node.children || []) {
    paths.push(...walk(child, pathValue));
  }
  return paths;
}

const apiPaths = apiSchema.flatMap((root) => walk(root));

const modules = [
  {
    name: "version",
    endpointPrefixes: ["/version"],
    tools: ["proxmox_cluster_status"],
    validationState: "validated",
    preferredTransport: "REST",
    notes: "Shared version read used by cluster inventory and status paths.",
  },
  {
    name: "cluster-core",
    endpointPrefixes: ["/cluster/status", "/cluster/resources", "/cluster/nextid", "/cluster/tasks", "/cluster/log"],
    tools: ["proxmox_inventory_overview", "proxmox_cluster_status"],
    validationState: "validated",
    preferredTransport: "REST",
    notes: "Core cluster visibility and task-oriented reads.",
  },
  {
    name: "cluster-config",
    endpointPrefixes: ["/cluster/config"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Use proxmox_api_call until typed cluster config tools are validated.",
  },
  {
    name: "cluster-mapping",
    endpointPrefixes: ["/cluster/mapping/pci"],
    tools: [
      "proxmox_pci_mapping_list",
      "proxmox_pci_mapping_get",
      "proxmox_pci_mapping_create",
      "proxmox_pci_mapping_update",
      "proxmox_pci_mapping_delete",
    ],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Cluster PCI resource mappings enable non-root, REST-shaped passthrough workflows through mapping identifiers instead of raw host device IDs.",
  },
  {
    name: "cluster-firewall",
    endpointPrefixes: ["/cluster/firewall"],
    tools: ["proxmox_firewall_get"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Cluster firewall reads exist; mutating coverage remains generic-only.",
  },
  {
    name: "cluster-ha",
    endpointPrefixes: ["/cluster/ha"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "HA should remain generic-only until lab-validated.",
  },
  {
    name: "cluster-sdn",
    endpointPrefixes: ["/cluster/sdn"],
    tools: ["proxmox_sdn_list"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Only listing is typed today.",
  },
  {
    name: "cluster-notifications",
    endpointPrefixes: ["/cluster/notifications"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Future typed module after notification workflows are validated.",
  },
  {
    name: "cluster-metrics",
    endpointPrefixes: ["/cluster/metrics"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Metrics endpoints are available but not yet typed.",
  },
  {
    name: "cluster-replication",
    endpointPrefixes: ["/cluster/replication"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Replication should become a dedicated module later.",
  },
  {
    name: "cluster-backup",
    endpointPrefixes: ["/cluster/backup", "/cluster/backup-info"],
    tools: ["proxmox_backup_jobs"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Read coverage is typed; broader lifecycle coverage still generic-only.",
  },
  {
    name: "cluster-ceph",
    endpointPrefixes: ["/cluster/ceph"],
    tools: ["proxmox_ceph_status"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Cluster Ceph status is typed; write paths remain generic-only.",
  },
  {
    name: "access-users",
    endpointPrefixes: ["/access/users"],
    tools: ["proxmox_user_list"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "User list is typed; create/update/token lifecycle is still generic-only.",
  },
  {
    name: "access-groups",
    endpointPrefixes: ["/access/groups"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Future typed group management.",
  },
  {
    name: "access-roles",
    endpointPrefixes: ["/access/roles"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Future typed role management.",
  },
  {
    name: "access-acl",
    endpointPrefixes: ["/access/acl", "/access/permissions"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "ACL and permission inspection/mutation remain generic-only.",
  },
  {
    name: "access-realms",
    endpointPrefixes: ["/access/domains"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Realm and sync jobs remain generic-only.",
  },
  {
    name: "access-auth",
    endpointPrefixes: ["/access/ticket", "/access/password", "/access/openid", "/access/tfa", "/access/vncticket"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Server-managed auth lifecycle is internal; user-facing typed auth tools are not yet productized.",
  },
  {
    name: "node-core",
    endpointPrefixes: ["/nodes", "/nodes/{node}/status", "/nodes/{node}/version", "/nodes/{node}/time", "/nodes/{node}/report", "/nodes/{node}/rrd", "/nodes/{node}/rrddata"],
    tools: ["proxmox_node_list", "proxmox_node_get", "proxmox_node_action", "proxmox_inventory_overview", "proxmox_cluster_status"],
    validationState: "validated",
    preferredTransport: "REST",
    notes: "Covers node inventory and lifecycle reads/actions.",
  },
  {
    name: "node-storage",
    endpointPrefixes: ["/nodes/{node}/storage", "/storage"],
    tools: ["proxmox_storage_list", "proxmox_storage_get", "proxmox_storage_download_url"],
    validationState: "validated",
    preferredTransport: "REST",
    notes: "Snippet file CRUD still requires SSH/file fallback.",
  },
  {
    name: "node-network",
    endpointPrefixes: ["/nodes/{node}/network", "/nodes/{node}/dns", "/nodes/{node}/hosts", "/nodes/{node}/netstat"],
    tools: ["proxmox_network_list"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Only network listing is typed today.",
  },
  {
    name: "node-disks",
    endpointPrefixes: ["/nodes/{node}/disks", "/nodes/{node}/hardware", "/nodes/{node}/scan"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Disk and scan families remain generic-only.",
  },
  {
    name: "node-services",
    endpointPrefixes: ["/nodes/{node}/services", "/nodes/{node}/tasks", "/nodes/{node}/apt", "/nodes/{node}/subscription"],
    tools: ["proxmox_task_list", "proxmox_task_get"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Task reads are typed; apt and service control remain generic-only.",
  },
  {
    name: "node-certificates",
    endpointPrefixes: ["/nodes/{node}/certificates"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "Candidate for artifact-backed certificate workflows later.",
  },
  {
    name: "node-apt",
    endpointPrefixes: ["/nodes/{node}/apt"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "REST + SSH fallback",
    notes: "Any typed apt coverage must remain explicitly high risk.",
  },
  {
    name: "qemu-read",
    endpointPrefixes: ["/nodes/{node}/qemu"],
    tools: ["proxmox_vm_list", "proxmox_vm_get", "proxmox_vm_template_list", "proxmox_vm_template_get"],
    validationState: "validated",
    preferredTransport: "REST",
    notes: "Includes template inspection because templates are QEMU resources.",
  },
  {
    name: "qemu-lifecycle",
    endpointPrefixes: ["/nodes/{node}/qemu/{vmid}/status", "/nodes/{node}/qemu/{vmid}/clone", "/nodes/{node}/qemu/{vmid}/template", "/nodes/{node}/qemu/{vmid}/resize"],
    tools: ["proxmox_vm_action", "proxmox_vm_clone", "proxmox_vm_convert_to_template", "proxmox_vm_destroy"],
    validationState: "validated",
    preferredTransport: "REST",
    notes: "Low-level lifecycle and clone primitives are typed.",
  },
  {
    name: "qemu-config",
    endpointPrefixes: ["/nodes/{node}/qemu", "/nodes/{node}/qemu/{vmid}/config"],
    tools: ["proxmox_vm_create", "proxmox_vm_update_config", "proxmox_vm_pci_attach", "proxmox_vm_pci_detach", "proxmox_vm_cloud_init_dump"],
    validationState: "validated",
    preferredTransport: "REST + SSH fallback",
    notes: "Cloud-init dump currently uses `qm cloudinit dump` via approved CLI. PCI passthrough uses REST first and falls back to `qm set` only for the known root-only raw non-mapped `hostpci` case.",
  },
  {
    name: "qemu-guest-agent",
    endpointPrefixes: ["/nodes/{node}/qemu/{vmid}/agent"],
    tools: ["proxmox_vm_guest_exec", "proxmox_file_read", "proxmox_file_write"],
    validationState: "validated",
    preferredTransport: "REST + guest agent",
    notes: "Falls back to configured guest transports when guest agent is unavailable.",
  },
  {
    name: "qemu-console",
    endpointPrefixes: ["/nodes/{node}/qemu/{vmid}/termproxy", "/nodes/{node}/qemu/{vmid}/vncproxy"],
    tools: ["proxmox_console_ticket"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Console ticketing is typed at a common console module level.",
  },
  {
    name: "qemu-boot-diagnostics",
    endpointPrefixes: ["/nodes/{node}/qemu/{vmid}/status", "/nodes/{node}/qemu/{vmid}/config", "/nodes/{node}/qemu/{vmid}/agent"],
    tools: ["proxmox_vm_boot_diagnose"],
    validationState: "typed",
    preferredTransport: "REST + CLI + SSH fallback",
    notes: "Boot diagnostics aggregate VM, guest-agent, cloud-init, and bounded node-side inspection signals. Bootstrap validation keeps known distro rules explicit.",
  },
  {
    name: "lxc-read",
    endpointPrefixes: ["/nodes/{node}/lxc"],
    tools: ["proxmox_lxc_list", "proxmox_lxc_get"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Container inventory and config/status reads are typed.",
  },
  {
    name: "lxc-lifecycle",
    endpointPrefixes: ["/nodes/{node}/lxc/{vmid}/status"],
    tools: ["proxmox_lxc_action"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Lifecycle actions are typed; broader provisioning remains generic-only.",
  },
  {
    name: "lxc-console",
    endpointPrefixes: ["/nodes/{node}/lxc/{vmid}/termproxy", "/nodes/{node}/lxc/{vmid}/vncproxy"],
    tools: ["proxmox_console_ticket"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Console ticketing is shared with node and QEMU console flows.",
  },
  {
    name: "storage-core",
    endpointPrefixes: ["/storage", "/nodes/{node}/storage"],
    tools: ["proxmox_storage_list", "proxmox_storage_get", "proxmox_storage_download_url", "proxmox_cloud_init_snippet_list", "proxmox_cloud_init_snippet_get", "proxmox_cloud_init_snippet_put", "proxmox_cloud_init_snippet_delete"],
    validationState: "validated",
    preferredTransport: "REST + SSH fallback",
    notes: "Generic storage is REST-first; snippet file CRUD uses validated SSH/file fallback.",
  },
  {
    name: "backup",
    endpointPrefixes: ["/cluster/backup", "/nodes/{node}/vzdump"],
    tools: ["proxmox_backup_jobs", "proxmox_backup_start"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Cluster backup reads and node backup starts are typed.",
  },
  {
    name: "replication",
    endpointPrefixes: ["/cluster/replication", "/nodes/{node}/replication"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "No typed replication coverage yet.",
  },
  {
    name: "firewall",
    endpointPrefixes: ["/cluster/firewall", "/nodes/{node}/firewall", "/nodes/{node}/qemu/{vmid}/firewall", "/nodes/{node}/lxc/{vmid}/firewall"],
    tools: ["proxmox_firewall_get"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Read-only typed coverage across cluster/node/guest scopes.",
  },
  {
    name: "sdn",
    endpointPrefixes: ["/cluster/sdn", "/nodes/{node}/sdn"],
    tools: ["proxmox_sdn_list"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Only cluster-level list coverage is typed today.",
  },
  {
    name: "ceph",
    endpointPrefixes: ["/cluster/ceph", "/nodes/{node}/ceph"],
    tools: ["proxmox_ceph_status"],
    validationState: "typed",
    preferredTransport: "REST",
    notes: "Only status reads are typed.",
  },
  {
    name: "ha",
    endpointPrefixes: ["/cluster/ha"],
    tools: [],
    validationState: "generic-only",
    preferredTransport: "generic escape hatch only",
    notes: "HA remains generic-only until validated.",
  },
  {
    name: "console-and-tasks",
    endpointPrefixes: ["/nodes/{node}/termproxy", "/nodes/{node}/vncshell", "/nodes/{node}/vncwebsocket", "/nodes/{node}/tasks", "/cluster/tasks"],
    tools: ["proxmox_console_ticket", "proxmox_task_list", "proxmox_task_get", "job_get", "job_wait", "job_cancel", "job_logs"],
    validationState: "validated",
    preferredTransport: "REST",
    notes: "Proxmox console and task surfaces plus server-owned job wrappers.",
  },
];

function uniqueMatches(prefixes) {
  return apiPaths.filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)));
}

const inventory = modules.map((module) => {
  const matchedPaths = uniqueMatches(module.endpointPrefixes);
  return {
    ...module,
    matchedPathCount: matchedPaths.length,
    matchedPaths: matchedPaths.sort(),
  };
});

const payload = {
  generatedAt: new Date().toISOString(),
  source: "vendor/pve-docs/api-viewer/apidata.js",
  moduleCount: inventory.length,
  modules: inventory,
};

const markdown = [
  "# Proxmox Module Inventory",
  "",
  "This inventory is generated from the vendored Proxmox API schema and maintained module definitions.",
  "",
  `Generated: ${payload.generatedAt}`,
  "",
  "| Module | Endpoint Prefixes | Tools | State | Preferred Transport | Matched Paths |",
  "| --- | --- | --- | --- | --- | ---: |",
  ...inventory.map((module) =>
    `| \`${module.name}\` | ${module.endpointPrefixes.map((entry) => `\`${entry}\``).join("<br>")} | ${module.tools.length > 0 ? module.tools.map((entry) => `\`${entry}\``).join("<br>") : "—"} | \`${module.validationState}\` | \`${module.preferredTransport}\` | ${module.matchedPathCount} |`,
  ),
  "",
  "## Notes",
  "",
  ...inventory.flatMap((module) => [`### ${module.name}`, module.notes, ""]),
];

fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
fs.writeFileSync(jsonOutPath, JSON.stringify(payload, null, 2) + "\n");
fs.writeFileSync(markdownOutPath, `${markdown.join("\n")}\n`);
console.log(`Wrote ${jsonOutPath}`);
console.log(`Wrote ${markdownOutPath}`);
