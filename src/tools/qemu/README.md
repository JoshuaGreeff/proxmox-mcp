# QEMU Tools

This folder contains QEMU VM, guest, and template MCP tool registrations.

Current tools:
- `proxmox_vm_list`
- `proxmox_vm_get`
- `proxmox_vm_guest_agent_diagnose`
- `proxmox_vm_action`
- `proxmox_vm_agent_ping`
- `proxmox_vm_agent_info`
- `proxmox_vm_guest_exec`
- `proxmox_vm_template_list`
- `proxmox_vm_template_get`
- `proxmox_vm_create`
- `proxmox_vm_update_config`
- `proxmox_vm_pci_attach`
- `proxmox_vm_pci_detach`
- `proxmox_vm_convert_to_template`
- `proxmox_vm_clone`
- `proxmox_vm_destroy`

These tools map to QEMU endpoint families such as:
- `/nodes/{node}/qemu`
- `/nodes/{node}/qemu/{vmid}/config`
- `/nodes/{node}/qemu/{vmid}/status/*`
- `/nodes/{node}/qemu/{vmid}/agent/*`
- `/nodes/{node}/qemu/{vmid}/clone`
- `/nodes/{node}/qemu/{vmid}/template`

Transport preference:
- REST first for VM and template lifecycle/config work
- PCI passthrough uses REST first and falls back to `qm set` only for the known root-only raw non-mapped `hostpci` case
- guest execution prefers guest-agent-capable paths and falls back to validated guest transport only when necessary
- diagnostics may aggregate several low-level signals when that makes guest boot and guest-agent failures easier to isolate

Job durability boundary:
- UPID-backed VM lifecycle and config mutations can be followed later through `job_*`
- `proxmox_vm_guest_exec` remains process-local when deferred because the server, not Proxmox, owns that execution path

Validation boundary:
- keep these tools as low-level VM primitives
- allow bounded diagnostics tools that aggregate closely related VM signals, as long as their sources and fallbacks stay explicit
- do not add preset-specific or bundled provisioning workflows here
