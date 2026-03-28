# Getting Started

`Proxmox-MCP` has two intended startup profiles:

- local maintainer mode
  - `PROXMOX_MCP_MODE=stdio`
  - `PROXMOX_MCP_AUTH_MODE=none`
  - may use `PROXMOX_MCP_LOCAL_BOOTSTRAP=1` for disposable environments
- production mode
  - `PROXMOX_MCP_MODE=http`
  - `PROXMOX_MCP_AUTH_MODE=oidc`
  - runtime credentials come from `env`, `file`, or `vault` secret backends

Minimal steady-state stdio example:

```toml
[mcp_servers.proxmox-mcp]
command = "node"
args = ["C:\\path\\to\\Proxmox-MCP\\dist\\index.js"]

[mcp_servers.proxmox-mcp.env]
PROXMOX_HOST = "proxmox.example.internal"
PROXMOX_MCP_MODE = "stdio"
PROXMOX_MCP_AUTH_MODE = "none"
PROXMOX_MCP_SECRET_BACKEND = "env"
PROXMOX_API_TOKEN_USER = "proxmox-mcp"
PROXMOX_API_TOKEN_REALM = "pam"
PROXMOX_API_TOKEN_ID = "proxmox-mcp"
PROXMOX_API_TOKEN_SECRET = "replace-me"
PROXMOX_DEFAULT_NODE = "pve-example"
```

Dev-only local bootstrap:

```toml
PROXMOX_MCP_LOCAL_BOOTSTRAP = "1"
PROXMOX_SSH_USERNAME = "root"
PROXMOX_SSH_PASSWORD = "replace-me"
```

That bootstrap path is not the production recommendation.
