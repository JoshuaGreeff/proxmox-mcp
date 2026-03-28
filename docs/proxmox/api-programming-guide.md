# Proxmox API Programming Guide

## Base API model
The official Proxmox VE API is HTTPS-based and uses JSON plus JSON Schema. The documented base URL is:

```text
https://your.server:8006/api2/json/
```

The schema is also surfaced through:
- The public API viewer
- The `pvesh` CLI
- The vendored schema in [vendor/pve-docs/api-viewer/apidata.js](../../vendor/pve-docs/api-viewer/apidata.js)

## Authentication
Use API tokens by default for a service-style MCP integration.

Practical options:
- Session ticket plus `CSRFPreventionToken` for browser-like sessions
- API token via `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET` for stateless automation

Implementation notes:
- Token permissions are a subset of the backing user.
- Proxmox recommends explicit ACL scoping for privilege-separated tokens.
- The token secret is only returned once at creation time.
- A practical MCP bootstrap flow is to start with `ticket` auth for first-time enrollment, generate an API token through `/access/users/{userid}/token/{tokenid}`, then switch the server to token auth for steady-state automation.

## Programmatic access patterns
### Direct REST
Use HTTPS against `api2/json`.

Typical patterns:
- `GET` for reads
- `POST` for creates and actions
- `PUT` for updates
- `DELETE` for removals

### `pvesh`
`pvesh` exposes the same API locally on a Proxmox node.

Examples from the official docs:
- `pvesh get /nodes`
- `pvesh usage cluster/options -v`
- `pvesh set cluster/options -console html5`

### API batch execution
`/nodes/{node}/execute` exists, but it is not host shell exec.

What it does:
- Accepts a JSON-encoded array of API commands
- Runs multiple Proxmox API operations in order
- Is documented as root-only

This is useful for orchestration batching inside Proxmox itself, not for arbitrary shell command transport.

## Capability by target type
### Proxmox node
Available directly through official REST:
- Cluster membership
- Node status and tasks
- Storage
- Networking
- Firewall
- APT and package actions
- Certificates
- Wake-on-LAN
- Console proxy endpoints
- Batched API calls via `/nodes/{node}/execute`

Not confirmed as simple REST shell exec:
- Arbitrary host shell command execution

Relevant endpoints:
- `/nodes/{node}/status`
- `/nodes/{node}/tasks`
- `/nodes/{node}/termproxy`
- `/nodes/{node}/vncshell`
- `/nodes/{node}/execute`

### QEMU VM
Available through official REST:
- Full lifecycle and config management
- Console proxy
- Snapshot/migration/storage actions
- QEMU monitor commands
- Guest agent operations when installed

Important guest-agent endpoints:
- `/nodes/{node}/qemu/{vmid}/agent/exec`
- `/nodes/{node}/qemu/{vmid}/agent/exec-status`
- `/nodes/{node}/qemu/{vmid}/agent/file-read`
- `/nodes/{node}/qemu/{vmid}/agent/file-write`

This means a Proxmox connector can perform:
- Non-interactive guest command execution
- File retrieval
- File write operations

But only for VMs with a functioning guest agent and the necessary permissions.

### LXC container
Available through official REST:
- Lifecycle and config management
- Snapshot/migration/storage actions
- Network and firewall management
- Console proxy endpoints

Important endpoints:
- `/nodes/{node}/lxc/{vmid}/status/*`
- `/nodes/{node}/lxc/{vmid}/termproxy`
- `/nodes/{node}/lxc/{vmid}/vncproxy`
- `/nodes/{node}/lxc/{vmid}/vncwebsocket`

Current limitation from the official schema:
- No simple REST endpoint equivalent to QEMU guest-agent `exec`, `file-read`, or `file-write` was found for LXC guests.

## Recommended connector strategy
### Use Proxmox REST for
- Discovery
- Inventory
- Permissions-aware actions
- Tasks and operation polling
- Lifecycle operations
- Storage and network orchestration

### Use Proxmox guest-agent APIs for
- VM guest exec
- VM file read/write

### Use SSH or a custom installed connector for
- Arbitrary shell execution on Proxmox nodes
- Arbitrary shell execution inside LXC guests
- Arbitrary shell execution inside VMs without guest agent support
- Nested Docker or Kubernetes operations inside guests

## Suggested MCP abstraction
Separate tools by capability instead of pretending one transport can do everything.

Suggested capability classes:
- `inventory`
- `lifecycle`
- `console`
- `guest_exec`
- `guest_file_read`
- `guest_file_write`
- `host_shell`
- `container_shell`

That lets the MCP layer decide whether a request is satisfiable through Proxmox alone or needs SSH or an installed agent.
