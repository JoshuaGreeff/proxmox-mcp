# Security

The supported security model is:

- OAuth/OIDC at the MCP layer
- server-owned downstream Proxmox credentials
- one-time privileged enrollment outside normal runtime
- split identities for typed API access and high-risk shell access

Runtime identities:

- typed API plane
  - Proxmox API token
  - used for typed REST-backed tools
- shell plane
  - SSH key-based Linux account
  - used for `proxmox_cli_run`, `proxmox_shell_run`, `proxmox_file_read`, `proxmox_file_write`, and node terminal access

Auth scopes:

- `proxmox.read`
- `proxmox.mutate`
- `proxmox.escape`
- `proxmox.admin`

Current scope mapping:

- read-only typed tools: `proxmox.read`
- mutating typed tools: `proxmox.mutate`
- shell/CLI/file and guest exec escape paths: `proxmox.escape`

Host key policy:

- enrolled shell identities are expected to use `strict` host-key validation with a pinned fingerprint
- unpinned shell identities are treated as incomplete for steady-state runtime use

Dev-only exceptions:

- `PROXMOX_MCP_LOCAL_BOOTSTRAP=1` enables the legacy SSH bootstrap path
- that mode is limited to explicit local stdio runs and should not be used for remote HTTP deployment
