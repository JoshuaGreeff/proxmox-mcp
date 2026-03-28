# Node Tools

This folder contains node-scoped MCP tool registrations.

Current tools:
- `proxmox_node_list`
- `proxmox_node_get`
- `proxmox_node_action`
- `proxmox_network_list`
- `proxmox_node_terminal_run`

These tools map to node-focused Proxmox families such as:
- `/nodes`
- `/nodes/{node}/status`
- `/nodes/{node}/network`
- node lifecycle action endpoints

Transport preference:
- REST first for status, network, and lifecycle actions
- node terminal uses the validated shell transport and stays explicitly high risk

Validation boundary:
- terminal access here is a convenience primitive, not a workflow engine or interactive PTY layer
