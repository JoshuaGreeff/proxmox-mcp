# Proxmox Module Inventory

This inventory is generated from the vendored Proxmox API schema and maintained module definitions.

Generated: 2026-03-30T01:30:51.993Z

| Module | Endpoint Prefixes | Tools | State | Preferred Transport | Matched Paths |
| --- | --- | --- | --- | --- | ---: |
| `version` | `/version` | `proxmox_cluster_status` | `validated` | `REST` | 1 |
| `cluster-core` | `/cluster/status`<br>`/cluster/resources`<br>`/cluster/nextid`<br>`/cluster/tasks`<br>`/cluster/log` | `proxmox_inventory_overview`<br>`proxmox_cluster_status` | `validated` | `REST` | 5 |
| `cluster-config` | `/cluster/config` | — | `generic-only` | `generic escape hatch only` | 7 |
| `cluster-mapping` | `/cluster/mapping/pci` | `proxmox_pci_mapping_list`<br>`proxmox_pci_mapping_get`<br>`proxmox_pci_mapping_create`<br>`proxmox_pci_mapping_update`<br>`proxmox_pci_mapping_delete` | `typed` | `REST` | 2 |
| `cluster-firewall` | `/cluster/firewall` | `proxmox_firewall_get` | `typed` | `REST` | 14 |
| `cluster-ha` | `/cluster/ha` | — | `generic-only` | `generic escape hatch only` | 12 |
| `cluster-sdn` | `/cluster/sdn` | `proxmox_sdn_list` | `typed` | `REST` | 28 |
| `cluster-notifications` | `/cluster/notifications` | — | `generic-only` | `generic escape hatch only` | 16 |
| `cluster-metrics` | `/cluster/metrics` | — | `generic-only` | `generic escape hatch only` | 4 |
| `cluster-replication` | `/cluster/replication` | — | `generic-only` | `generic escape hatch only` | 2 |
| `cluster-backup` | `/cluster/backup`<br>`/cluster/backup-info` | `proxmox_backup_jobs` | `typed` | `REST` | 5 |
| `cluster-ceph` | `/cluster/ceph` | `proxmox_ceph_status` | `typed` | `REST` | 5 |
| `access-users` | `/access/users` | `proxmox_user_list` | `typed` | `REST` | 6 |
| `access-groups` | `/access/groups` | — | `generic-only` | `generic escape hatch only` | 2 |
| `access-roles` | `/access/roles` | — | `generic-only` | `generic escape hatch only` | 2 |
| `access-acl` | `/access/acl`<br>`/access/permissions` | — | `generic-only` | `generic escape hatch only` | 2 |
| `access-realms` | `/access/domains` | — | `generic-only` | `generic escape hatch only` | 3 |
| `access-auth` | `/access/ticket`<br>`/access/password`<br>`/access/openid`<br>`/access/tfa`<br>`/access/vncticket` | — | `generic-only` | `generic escape hatch only` | 9 |
| `node-core` | `/nodes`<br>`/nodes/{node}/status`<br>`/nodes/{node}/version`<br>`/nodes/{node}/time`<br>`/nodes/{node}/report`<br>`/nodes/{node}/rrd`<br>`/nodes/{node}/rrddata` | `proxmox_node_list`<br>`proxmox_node_get`<br>`proxmox_node_action`<br>`proxmox_inventory_overview`<br>`proxmox_cluster_status` | `validated` | `REST` | 272 |
| `node-storage` | `/nodes/{node}/storage`<br>`/storage` | `proxmox_storage_list`<br>`proxmox_storage_get`<br>`proxmox_storage_download_url` | `validated` | `REST` | 16 |
| `node-network` | `/nodes/{node}/network`<br>`/nodes/{node}/dns`<br>`/nodes/{node}/hosts`<br>`/nodes/{node}/netstat` | `proxmox_network_list` | `typed` | `REST` | 5 |
| `node-disks` | `/nodes/{node}/disks`<br>`/nodes/{node}/hardware`<br>`/nodes/{node}/scan` | — | `generic-only` | `generic escape hatch only` | 26 |
| `node-services` | `/nodes/{node}/services`<br>`/nodes/{node}/tasks`<br>`/nodes/{node}/apt`<br>`/nodes/{node}/subscription` | `proxmox_task_list`<br>`proxmox_task_get` | `typed` | `REST` | 17 |
| `node-certificates` | `/nodes/{node}/certificates` | — | `generic-only` | `generic escape hatch only` | 5 |
| `node-apt` | `/nodes/{node}/apt` | — | `generic-only` | `REST + SSH fallback` | 5 |
| `qemu-read` | `/nodes/{node}/qemu` | `proxmox_vm_list`<br>`proxmox_vm_get`<br>`proxmox_vm_template_list`<br>`proxmox_vm_template_get` | `validated` | `REST` | 75 |
| `qemu-lifecycle` | `/nodes/{node}/qemu/{vmid}/status`<br>`/nodes/{node}/qemu/{vmid}/clone`<br>`/nodes/{node}/qemu/{vmid}/template`<br>`/nodes/{node}/qemu/{vmid}/resize` | `proxmox_vm_action`<br>`proxmox_vm_clone`<br>`proxmox_vm_convert_to_template`<br>`proxmox_vm_destroy` | `validated` | `REST` | 12 |
| `qemu-config` | `/nodes/{node}/qemu`<br>`/nodes/{node}/qemu/{vmid}/config` | `proxmox_vm_create`<br>`proxmox_vm_update_config`<br>`proxmox_vm_pci_attach`<br>`proxmox_vm_pci_detach`<br>`proxmox_vm_cloud_init_dump` | `validated` | `REST + SSH fallback` | 75 |
| `qemu-guest-agent` | `/nodes/{node}/qemu/{vmid}/agent` | `proxmox_vm_guest_exec`<br>`proxmox_file_read`<br>`proxmox_file_write` | `validated` | `REST + guest agent` | 26 |
| `qemu-console` | `/nodes/{node}/qemu/{vmid}/termproxy`<br>`/nodes/{node}/qemu/{vmid}/vncproxy` | `proxmox_console_ticket` | `typed` | `REST` | 2 |
| `qemu-boot-diagnostics` | `/nodes/{node}/qemu/{vmid}/status`<br>`/nodes/{node}/qemu/{vmid}/config`<br>`/nodes/{node}/qemu/{vmid}/agent` | `proxmox_vm_boot_diagnose` | `typed` | `REST + CLI + SSH fallback` | 36 |
| `lxc-read` | `/nodes/{node}/lxc` | `proxmox_lxc_list`<br>`proxmox_lxc_get` | `typed` | `REST` | 43 |
| `lxc-lifecycle` | `/nodes/{node}/lxc/{vmid}/status` | `proxmox_lxc_action` | `typed` | `REST` | 8 |
| `lxc-console` | `/nodes/{node}/lxc/{vmid}/termproxy`<br>`/nodes/{node}/lxc/{vmid}/vncproxy` | `proxmox_console_ticket` | `typed` | `REST` | 2 |
| `storage-core` | `/storage`<br>`/nodes/{node}/storage` | `proxmox_storage_list`<br>`proxmox_storage_get`<br>`proxmox_storage_download_url`<br>`proxmox_cloud_init_snippet_list`<br>`proxmox_cloud_init_snippet_get`<br>`proxmox_cloud_init_snippet_put`<br>`proxmox_cloud_init_snippet_delete` | `validated` | `REST + SSH fallback` | 16 |
| `backup` | `/cluster/backup`<br>`/nodes/{node}/vzdump` | `proxmox_backup_jobs`<br>`proxmox_backup_start` | `typed` | `REST` | 8 |
| `replication` | `/cluster/replication`<br>`/nodes/{node}/replication` | — | `generic-only` | `generic escape hatch only` | 7 |
| `firewall` | `/cluster/firewall`<br>`/nodes/{node}/firewall`<br>`/nodes/{node}/qemu/{vmid}/firewall`<br>`/nodes/{node}/lxc/{vmid}/firewall` | `proxmox_firewall_get` | `typed` | `REST` | 41 |
| `sdn` | `/cluster/sdn`<br>`/nodes/{node}/sdn` | `proxmox_sdn_list` | `typed` | `REST` | 40 |
| `ceph` | `/cluster/ceph`<br>`/nodes/{node}/ceph` | `proxmox_ceph_status` | `typed` | `REST` | 37 |
| `ha` | `/cluster/ha` | — | `generic-only` | `generic escape hatch only` | 12 |
| `console-and-tasks` | `/nodes/{node}/termproxy`<br>`/nodes/{node}/vncshell`<br>`/nodes/{node}/vncwebsocket`<br>`/nodes/{node}/tasks`<br>`/cluster/tasks` | `proxmox_console_ticket`<br>`proxmox_task_list`<br>`proxmox_task_get`<br>`job_get`<br>`job_wait`<br>`job_cancel`<br>`job_logs` | `validated` | `REST` | 8 |

## Notes

### version
Shared version read used by cluster inventory and status paths.

### cluster-core
Core cluster visibility and task-oriented reads.

### cluster-config
Use proxmox_api_call until typed cluster config tools are validated.

### cluster-mapping
Cluster PCI resource mappings enable non-root, REST-shaped passthrough workflows through mapping identifiers instead of raw host device IDs.

### cluster-firewall
Cluster firewall reads exist; mutating coverage remains generic-only.

### cluster-ha
HA should remain generic-only until lab-validated.

### cluster-sdn
Only listing is typed today.

### cluster-notifications
Future typed module after notification workflows are validated.

### cluster-metrics
Metrics endpoints are available but not yet typed.

### cluster-replication
Replication should become a dedicated module later.

### cluster-backup
Read coverage is typed; broader lifecycle coverage still generic-only.

### cluster-ceph
Cluster Ceph status is typed; write paths remain generic-only.

### access-users
User list is typed; create/update/token lifecycle is still generic-only.

### access-groups
Future typed group management.

### access-roles
Future typed role management.

### access-acl
ACL and permission inspection/mutation remain generic-only.

### access-realms
Realm and sync jobs remain generic-only.

### access-auth
Server-managed auth lifecycle is internal; user-facing typed auth tools are not yet productized.

### node-core
Covers node inventory and lifecycle reads/actions.

### node-storage
Snippet file CRUD still requires SSH/file fallback.

### node-network
Only network listing is typed today.

### node-disks
Disk and scan families remain generic-only.

### node-services
Task reads are typed; apt and service control remain generic-only.

### node-certificates
Candidate for artifact-backed certificate workflows later.

### node-apt
Any typed apt coverage must remain explicitly high risk.

### qemu-read
Includes template inspection because templates are QEMU resources.

### qemu-lifecycle
Low-level lifecycle and clone primitives are typed.

### qemu-config
Cloud-init dump currently uses `qm cloudinit dump` via approved CLI. PCI passthrough uses REST first and falls back to `qm set` only for the known root-only raw non-mapped `hostpci` case.

### qemu-guest-agent
Falls back to configured guest transports when guest agent is unavailable.

### qemu-console
Console ticketing is typed at a common console module level.

### qemu-boot-diagnostics
Boot diagnostics aggregate VM, guest-agent, cloud-init, and bounded node-side inspection signals. Bootstrap validation keeps known distro rules explicit.

### lxc-read
Container inventory and config/status reads are typed.

### lxc-lifecycle
Lifecycle actions are typed; broader provisioning remains generic-only.

### lxc-console
Console ticketing is shared with node and QEMU console flows.

### storage-core
Generic storage is REST-first; snippet file CRUD uses validated SSH/file fallback.

### backup
Cluster backup reads and node backup starts are typed.

### replication
No typed replication coverage yet.

### firewall
Read-only typed coverage across cluster/node/guest scopes.

### sdn
Only cluster-level list coverage is typed today.

### ceph
Only status reads are typed.

### ha
HA remains generic-only until validated.

### console-and-tasks
Proxmox console and task surfaces plus server-owned job wrappers.

