# Proxmox-MCP

[![CI](https://img.shields.io/github/actions/workflow/status/JoshuaGreeff/proxmox-mcp/ci.yml?branch=main&label=ci)](https://github.com/JoshuaGreeff/proxmox-mcp/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/JoshuaGreeff/proxmox-mcp/codeql.yml?branch=main&label=codeql)](https://github.com/JoshuaGreeff/proxmox-mcp/actions/workflows/codeql.yml)
[![OpenSSF Scorecards](https://img.shields.io/github/actions/workflow/status/JoshuaGreeff/proxmox-mcp/scorecards.yml?branch=main&label=scorecards)](https://github.com/JoshuaGreeff/proxmox-mcp/actions/workflows/scorecards.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Status: Beta](https://img.shields.io/badge/status-beta-1f6feb)](./docs/production-readiness.md)
[![GitHub stars](https://img.shields.io/github/stars/JoshuaGreeff/proxmox-mcp?style=social)](https://github.com/JoshuaGreeff/proxmox-mcp/stargazers)

`Proxmox-MCP` is a typed MCP server for operating Proxmox VE through three layers used together:

- Proxmox REST for the management plane
- Proxmox CLI over SSH for node-local coverage gaps
- explicit shell and file escape hatches for high-risk host and guest operations

The server is built against the official Proxmox API schema vendored in `vendor/pve-docs`.

The framework grows by validated domain modules. A workflow only becomes a typed MCP tool after it has been exercised end-to-end in the lab. Everything else remains available through the generic API/CLI/shell/file escape hatches until it is validated.

The maintained schema-derived roadmap for module coverage lives in [module-inventory.md](./docs/proxmox/module-inventory.md).

## What This Is / What It Is Not

What this is:

- a real MCP server with typed Proxmox tools backed by official upstream docs and schema
- a client-agnostic control surface that works over stdio today and targets remote HTTP deployment with OIDC
- an operator-focused server that keeps high-risk shell, file, and guest access explicit instead of hiding it behind vague workflow wrappers

What this is not:

- a thin wrapper around ad hoc local scripts
- a fully packaged production platform with release artifacts, hosted docs, and long-term compatibility guarantees already locked down
- a policy-free remote shell broker; high-risk access stays deliberate and auditable

## Project Status

`Proxmox-MCP` is currently `Beta`.

- local `stdio` validation is in place and is the primary maintainer workflow
- `http + oidc + file|vault` is the intended production deployment shape
- release packaging, broader deployment validation, and deeper operational maturity are still in progress

See [Production Readiness](./docs/production-readiness.md) for the current support boundaries and remaining gaps.

## Community / Maintainer Docs

- [Security Policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)
- [Branching Workflow](./docs/branching.md)
- [Publishing](./docs/publishing.md)

## Current Scope

- inventory across clusters, nodes, QEMU VMs, and LXC containers
- Proxmox lifecycle, storage, network, firewall, backup, Ceph, SDN, user, task, and console operations
- low-level QEMU provisioning and template primitives plus cloud-init snippet tools
- VM boot diagnostics
- a convenience node-terminal runner for stateless node commands
- an artifact/resource layer for large text and binary tool outputs
- validated raw REST access through `proxmox_api_call`
- validated Proxmox CLI access through `proxmox_cli_run`
- explicit shell and file access through `proxmox_shell_run`, `proxmox_file_read`, and `proxmox_file_write`
- server-owned jobs for long-running operations

This repo is a real MCP server, not a wrapper around a local script collection.

## Tool Surface

Typed tools:

These are intentionally low-level, generic Proxmox primitives. The framework aims to expose an MCP-shaped Proxmox API surface, not a catalog of prebuilt operator workflows.

- `proxmox_inventory_overview`
- `proxmox_cluster_status`
- `proxmox_pci_mapping_list`, `proxmox_pci_mapping_get`, `proxmox_pci_mapping_create`, `proxmox_pci_mapping_update`, `proxmox_pci_mapping_delete`
- `proxmox_node_list`, `proxmox_node_get`, `proxmox_node_action`
- `proxmox_node_terminal_run`
- `proxmox_vm_list`, `proxmox_vm_get`, `proxmox_vm_guest_agent_diagnose`, `proxmox_vm_action`, `proxmox_vm_agent_ping`, `proxmox_vm_agent_info`, `proxmox_vm_guest_exec`
- `proxmox_vm_boot_diagnose`
- `proxmox_vm_template_list`, `proxmox_vm_template_get`
- `proxmox_storage_download_url`
- `proxmox_vm_create`, `proxmox_vm_update_config`, `proxmox_vm_convert_to_template`, `proxmox_vm_clone`, `proxmox_vm_destroy`
- `proxmox_cloud_init_snippet_list`, `proxmox_cloud_init_snippet_get`, `proxmox_cloud_init_snippet_put`, `proxmox_cloud_init_snippet_delete`, `proxmox_vm_cloud_init_dump`
- `proxmox_lxc_list`, `proxmox_lxc_get`, `proxmox_lxc_action`
- `proxmox_storage_list`, `proxmox_storage_get`
- `proxmox_network_list`
- `proxmox_firewall_get`
- `proxmox_backup_jobs`, `proxmox_backup_start`
- `proxmox_user_list`
- `proxmox_ceph_status`
- `proxmox_sdn_list`
- `proxmox_task_list`, `proxmox_task_get`
- `proxmox_console_ticket`

Completeness and escape hatches:

- `proxmox_api_call`
- `proxmox_cli_run`
- `proxmox_shell_run`
- `proxmox_file_read`
- `proxmox_file_write`
- `proxmox_bootstrap_node_access`
- `proxmox_capabilities`
- `job_get`, `job_wait`, `job_cancel`, `job_logs`

Some tools now publish large text or binary outputs as MCP artifact resources instead of forcing everything inline into a single JSON response. Those artifacts are exposed under `proxmox://artifacts/{artifactId}`.

The validated boot/bootstrap findings behind the new VM diagnostics tools are tracked in [boot-and-bootstrap.md](./docs/proxmox/boot-and-bootstrap.md).

## Configuration

The runtime startup surface is env-only. In practice that means your MCP client config or process manager env is the source of truth.

Supported deployment modes:

- `stdio`
  - local maintainer workflow
  - may use explicit local bootstrap for disposable environments only
- `http`
  - remote MCP deployment
  - requires OIDC bearer auth
- `both`
  - runs stdio and HTTP in one process for transition/testing

Core env settings:

- `PROXMOX_HOST`
- `PROXMOX_MCP_MODE=stdio|http|both`
- `PROXMOX_MCP_AUTH_MODE=none|oidc`
- `PROXMOX_MCP_SECRET_BACKEND=env|file|vault`
- `PROXMOX_API_PORT`
- `PROXMOX_DEFAULT_NODE`
- `PROXMOX_DEFAULT_BRIDGE`
- `PROXMOX_DEFAULT_VM_STORAGE`
- `PROXMOX_DEFAULT_SNIPPET_STORAGE`
- `PROXMOX_TLS_REJECT_UNAUTHORIZED`

Steady-state runtime secrets:

- env backend:
  - `PROXMOX_API_TOKEN_USER`
  - `PROXMOX_API_TOKEN_REALM`
  - `PROXMOX_API_TOKEN_ID`
  - `PROXMOX_API_TOKEN_SECRET`
  - `PROXMOX_SHELL_SSH_USERNAME`
  - `PROXMOX_SHELL_SSH_PRIVATE_KEY` or `PROXMOX_SHELL_SSH_PRIVATE_KEY_PATH`
  - `PROXMOX_SHELL_SSH_EXPECTED_HOST_KEY`
- file backend:
  - `PROXMOX_MCP_SECRET_FILE_PATH`
- vault backend:
  - `PROXMOX_MCP_SECRET_VAULT_ADDR`
  - `PROXMOX_MCP_SECRET_VAULT_PATH`
  - `PROXMOX_MCP_SECRET_VAULT_TOKEN_ENV` or `VAULT_TOKEN`

HTTP/OIDC settings:

- `PROXMOX_MCP_HTTP_HOST`
- `PROXMOX_MCP_HTTP_PORT`
- `PROXMOX_MCP_HTTP_PATH`
- `PROXMOX_MCP_HTTP_PUBLIC_BASE_URL`
- `PROXMOX_MCP_OIDC_ISSUER`
- `PROXMOX_MCP_OIDC_AUDIENCE`
- `PROXMOX_MCP_OIDC_JWKS_URL`

Dev-only local bootstrap:

- `PROXMOX_MCP_LOCAL_BOOTSTRAP=1`
- `PROXMOX_BOOTSTRAP_SSH_USERNAME` / `PROXMOX_SSH_USERNAME`
- `PROXMOX_BOOTSTRAP_SSH_PASSWORD` / `PROXMOX_SSH_PASSWORD`

That bootstrap path is intentionally limited to explicit local stdio mode. It is not the production runtime model.

## Codex / MCP Client Setup

The server still works over stdio. It resolves vendored schema and app-relative defaults from the app location rather than the current working directory, so a client does not need to set `cwd` if it launches the built entrypoint by absolute path.

Minimal steady-state stdio mode:

```toml
[mcp_servers.proxmox-mcp]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\path\\to\\Proxmox-MCP\\dist\\index.js"]
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 300

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

Optional env overrides for the steady-state path:
- `PROXMOX_API_PORT`
- `PROXMOX_DEFAULT_NODE`
- `PROXMOX_DEFAULT_BRIDGE`
- `PROXMOX_DEFAULT_VM_STORAGE`
- `PROXMOX_DEFAULT_SNIPPET_STORAGE`
- `PROXMOX_TLS_REJECT_UNAUTHORIZED`
- `PROXMOX_SHELL_SSH_*` if you want shell/CLI/file escape hatches enabled

Remote HTTP mode is the production target. See:

- [Getting Started](./docs/getting-started.md)
- [Deployment](./docs/deployment.md)
- [Security](./docs/security.md)
- [Operations](./docs/operations.md)

All supported startup overrides belong in the MCP client env block or the supervising process environment. There is no legacy config-file fallback.

## Proxmox Provisioning

Repeatable Proxmox provisioning now belongs in the MCP server, not in repo-local operator wrappers.

The old SSH-heavy provisioning scripts were removed because they duplicated the typed MCP surface and drifted from the current env-only startup model. If a workflow is reusable and Proxmox-facing, the expected path is to exercise it through MCP and improve the typed tools when needed.

The validated provisioning and template primitives are:

- `proxmox_storage_download_url`
  - downloads an image or template artifact into Proxmox storage using the documented REST endpoint
- `proxmox_vm_create`
  - creates a QEMU VM from low-level config arguments
- `proxmox_vm_update_config`
  - updates QEMU VM config from low-level config arguments such as disks, cloud-init, serial console, ballooning, or SSH keys
- `proxmox_vm_convert_to_template`
  - converts an existing VM into a template
- `proxmox_vm_clone`
  - clones a VM or template with low-level clone arguments such as `newid`, `full`, `storage`, and `target`
- `proxmox_vm_destroy`
  - destroys a VM or template through the documented REST endpoint
- `proxmox_cloud_init_snippet_*`
  - manages snippet files on Proxmox snippet-capable storage
- `proxmox_vm_cloud_init_dump`
  - dumps generated `user`, `network`, or `meta` cloud-init for debugging

Important distinctions:

- template bootstrap belongs in cloud-init snippet content stored on Proxmox snippet-capable storage
- operator-specific clone customization belongs in low-level VM config and cloud-init inputs, not in repo-local wrapper scripts
- `proxmox_node_terminal_run` is a convenience tool for stateless node commands, while `proxmox_shell_run` remains the generic high-risk shell escape hatch

For live validation of those workflows, use the direct stdio harness in [docs/direct-mcp-testing.md](./docs/direct-mcp-testing.md).

The only standalone scripts intentionally kept in this repo are host-local maintainer helpers such as:

- Hyper-V outer-lab creation/removal
- vendored-doc refresh and summary generation

Those stay outside the MCP product surface because they operate on the maintainer workstation or on repo maintenance inputs, not on managed Proxmox resources through the server.

## Development

Branching and promotion flow:

- `main` is the production-ready branch
- `dev` is the integration and pre-release branch
- normal work should branch from `dev` into short-lived `feature/*` branches, then merge back into `dev`
- release promotion should happen by merging `dev` into `main`
- urgent fixes may target `main` through `hotfix/*` branches, but must be back-merged into `dev`
- branch protection exists on both branches, but owner/admin bypass remains available for emergencies

See [Branching Workflow](./docs/branching.md) for the maintainer process.

```bash
npm install
npm run check
npm run test
npm run build
```

Run the server locally in stdio mode:

```bash
npm run dev
```

Run the admin CLI:

```bash
npm run admin -- status --secret-backend env
```

Run the built entrypoint:

```bash
node C:\path\to\Proxmox-MCP\dist\index.js
```

Live integration tests are env-gated:

```bash
$env:ENABLE_LIVE_PROXMOX_TESTS="1"
npm run test:live
```

## Repo Layout

- `src/`: server, config loader, policy enforcement, API client, SSH/WinRM transports, and domain-oriented MCP tool registrations
- `src/tools/`: MCP tool registrations grouped by Proxmox domain, each with a local maintainer README
- `tests/`: unit and live test coverage
- `docs/proxmox/`: local notes derived from official Proxmox docs
- `vendor/pve-docs/`: vendored upstream Proxmox docs and API schema
- `scripts/`: reproducible helper scripts for docs refresh and outer-lab host setup
- `docs/framework-architecture.md`: maintainer guide for framework layers and validated module rules
- `docs/direct-mcp-testing.md`: maintainer guide for direct stdio MCP validation without relying on editor MCP reloads

## Documentation

- `docs/proxmox/README.md`
- `docs/proxmox/api-programming-guide.md`
- `docs/proxmox/command-map.md`
- `docs/proxmox/api-summary.json`
- `docs/proxmox/module-inventory.md`
- `docs/proxmox/module-inventory.json`
- `docs/direct-mcp-testing.md`
- `docs/branching.md`
- `docs/production-readiness.md`
- `docs/getting-started.md`
- `docs/deployment.md`
- `docs/security.md`
- `docs/operations.md`

## Project Hygiene

The public repo should contain reproducible code and docs, not live configs, audit logs, generated build output, ISO files, or local keys. If you are preparing a release, verify that the startup instructions still point to MCP client `config.toml` env configuration only.
