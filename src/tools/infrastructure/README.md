# Infrastructure Tools

This folder contains cross-cutting infrastructure MCP tool registrations that are still generic primitives but do not yet warrant smaller folders.

Current tools:
- `proxmox_firewall_get`
- `proxmox_backup_jobs`
- `proxmox_backup_start`
- `proxmox_ceph_status`
- `proxmox_sdn_list`
- `proxmox_task_list`
- `proxmox_task_get`
- `proxmox_console_ticket`

These tools map to infrastructure families such as:
- cluster, node, VM, and LXC firewall endpoints
- `/cluster/backup`
- `/nodes/{node}/vzdump`
- `/cluster/ceph/status`
- `/cluster/sdn`
- node task endpoints
- console proxy ticket endpoints

Transport preference:
- REST first

Validation boundary:
- this folder is a temporary grouping for validated low-level primitives, not a place for bundled workflows
