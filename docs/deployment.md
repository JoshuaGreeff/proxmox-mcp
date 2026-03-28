# Deployment

Production target:

- `PROXMOX_MCP_MODE=http`
- `PROXMOX_MCP_AUTH_MODE=oidc`
- `PROXMOX_MCP_SECRET_BACKEND=file|vault`
- audit logging enabled

Required HTTP settings:

- `PROXMOX_MCP_HTTP_HOST`
- `PROXMOX_MCP_HTTP_PORT`
- `PROXMOX_MCP_HTTP_PATH`
- `PROXMOX_MCP_HTTP_PUBLIC_BASE_URL`

Required OIDC settings:

- `PROXMOX_MCP_OIDC_ISSUER`
- `PROXMOX_MCP_OIDC_AUDIENCE`
- optional `PROXMOX_MCP_OIDC_JWKS_URL`

Secret backends:

- `env`
  - read-only
  - intended for local testing and simple stdio setups
- `file`
  - permission-hardened JSON store
  - suitable for single-node self-hosted deployments
- `vault`
  - first production-grade backend
  - supports read/write/delete through the admin CLI

External enrollment is handled by `proxmox-mcp-admin`:

- `enroll`
- `rotate`
- `status`
- `deprovision`

The MCP runtime no longer needs privileged bootstrap SSH credentials during normal startup.
