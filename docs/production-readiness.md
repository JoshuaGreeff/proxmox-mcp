# Production Readiness

`Proxmox-MCP` now has the core production security model implemented:

- `stdio` local-maintainer mode
- `http` / `both` deployment modes
- OIDC bearer validation for remote HTTP
- split steady-state identities
- pluggable secret backends (`env`, `file`, `vault`)
- external admin CLI for `enroll`, `rotate`, `status`, and `deprovision`
- explicit secret reload via `SIGHUP`

The remaining work is no longer “invent the security model”; it is mostly release hardening and operational polish.

## Supported Modes

| Area | Status | Notes |
| --- | --- | --- |
| `stdio + secret backend` | supported | primary local/dev workflow |
| `stdio + local bootstrap` | dev-only | explicit `PROXMOX_MCP_LOCAL_BOOTSTRAP=1` required |
| `http + oidc + file/vault` | supported target | intended production shape |
| `http + no auth` | unsupported | startup rejects this |

## Tool Stability Matrix

| Tool family | Status | Auth scope |
| --- | --- | --- |
| typed read tools | supported | `proxmox.read` |
| typed mutating tools | supported | `proxmox.mutate` |
| shell / CLI / file / guest exec | high-risk supported | `proxmox.escape` |
| admin enrollment | external CLI only | not part of MCP runtime |

## Secret Backend Matrix

| Backend | Status | Notes |
| --- | --- | --- |
| `env` | supported for dev | read-only |
| `file` | supported | permission-hardened local store |
| `vault` | supported target | first production-grade backend |

## Remaining Gaps

### Release Packaging

- no container image or signed release artifact yet
- no published Node.js / Proxmox support matrix yet
- no release automation or migration policy yet

### Operational Hardening

- no documented audit rotation/retention policy yet
- no published rollback playbooks per mutation class yet
- no formal troubleshooting guide for enrollment, OIDC, or secret reload failures yet

### Validation Depth

- live CI still is not enforcing the documented production deployment path
- multi-node and HA validation remain limited
- secret rotation and HTTP auth need more disposable-environment live coverage

### Public Repo Hygiene

- public release docs still need a final pass for wording, support boundaries, and contributor-only files
- package/release naming is aligned, but public publishing flow still needs to be finalized

## Minimum Release Gate

- `npm run check`
- `npm run test`
- `npm run build`
- disposable live validation for:
  - `stdio + steady-state secret backend`
  - `http + oidc + file|vault`
  - `proxmox-mcp-admin enroll`
  - `proxmox-mcp-admin rotate`
  - `proxmox-mcp-admin deprovision`
