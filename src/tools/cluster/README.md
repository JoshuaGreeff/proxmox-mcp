# Cluster Tools

This folder contains cluster-scoped MCP tool registrations.

Current tools:
- `proxmox_inventory_overview`
- `proxmox_cluster_status`
- `proxmox_pci_mapping_list`
- `proxmox_pci_mapping_get`
- `proxmox_pci_mapping_create`
- `proxmox_pci_mapping_update`
- `proxmox_pci_mapping_delete`

These tools map to cluster-wide Proxmox resource discovery and status families such as:
- `/cluster/resources`
- `/cluster/status`
- `/version`
- `/cluster/mapping/pci`

Transport preference:
- REST first
- no SSH fallback for the current tools in this folder

Validation boundary:
- keep these tools low-level and close to cluster resource semantics
- do not add bundled operator workflows here
