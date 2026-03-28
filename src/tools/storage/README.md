# Storage Tools

This folder contains storage and cloud-init snippet MCP tool registrations.

Current tools:
- `proxmox_storage_list`
- `proxmox_storage_get`
- `proxmox_storage_download_url`
- `proxmox_cloud_init_snippet_list`
- `proxmox_cloud_init_snippet_get`
- `proxmox_cloud_init_snippet_put`
- `proxmox_cloud_init_snippet_delete`
- `proxmox_vm_cloud_init_dump`

These tools map to storage and snippet-related families such as:
- `/storage`
- `/nodes/{node}/storage/{storage}/download-url`
- snippet-capable storage content

Transport preference:
- REST first for storage metadata and download-url
- SSH/file fallback only for snippet CRUD because Proxmox does not expose clean generic snippet file APIs
- `qm cloudinit dump` remains a validated CLI-backed gap until a better typed REST equivalent is validated

Validation boundary:
- keep storage and snippet tools primitive and composable
- artifact-backed input and output is allowed here when content is large or binary
