# Operations

Normal operator lifecycle:

1. Enroll steady-state credentials with `proxmox-mcp-admin enroll`.
2. Start `Proxmox-MCP` with `http + oidc + file|vault`.
3. Rotate credentials with `proxmox-mcp-admin rotate`.
4. Remove managed identities with `proxmox-mcp-admin deprovision`.

Runtime reload:

- send `SIGHUP` to trigger secret reload from the configured backend
- the runtime does not self-generate new credentials

Audit behavior:

- production-style modes default to `.proxmox-mcp-audit.log`
- explicit local stdio mode defaults to the OS null device

Operational notes:

- shell/CLI/file access requires a configured steady-state shell identity
- if the shell identity is absent, escape-hatch operations fail explicitly
- typed REST-backed tools continue to work with only the API token configured
