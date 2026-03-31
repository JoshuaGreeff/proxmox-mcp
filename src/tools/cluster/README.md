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

Calling conventions:
- when the server has exactly one configured cluster, the typed `cluster` input may be omitted and the server will use that sole configured alias
- when multiple clusters are configured, callers should pass an explicit configured alias such as `default`

Validation boundary:
- keep these tools low-level and close to cluster resource semantics
- do not add bundled operator workflows here
