# LXC Tools

This folder contains LXC container MCP tool registrations.

Current tools:
- `proxmox_lxc_list`
- `proxmox_lxc_get`
- `proxmox_lxc_action`

These tools map to LXC endpoint families such as:
- `/nodes/{node}/lxc`
- `/nodes/{node}/lxc/{vmid}/config`
- `/nodes/{node}/lxc/{vmid}/status/*`

Transport preference:
- REST first for inventory, reads, and lifecycle actions

Validation boundary:
- do not assume LXC has the same guest-agent exec/file semantics as QEMU unless validated separately
