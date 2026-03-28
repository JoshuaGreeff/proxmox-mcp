# AGENTS.md

## Purpose
This repository builds a Proxmox control MCP server.

The product goal is full operational coverage of a running Proxmox environment through three layers used together:
- Proxmox REST/API for the management plane
- Proxmox CLI over SSH for node-local coverage gaps
- Explicit, policy-gated shell and file access for host/guest operations that are not cleanly exposed through REST

Current priority:
- Treat Proxmox VE as an official upstream dependency.
- Prefer official Proxmox documentation and schema over forum posts or third-party wrappers.
- Preserve a client-agnostic MCP server that works over stdio and does not depend on experimental MCP task support.

## Working Rules
- Do not guess Proxmox API behavior when the answer can be verified in `vendor/pve-docs` or the official Proxmox API docs.
- Separate Proxmox management-plane actions from guest OS command execution.
- Do not describe `/nodes/{node}/execute` as arbitrary shell execution. It is an API batch executor.
- Prefer typed MCP tools first. Use the generic escape hatches only when typed tools do not cover the operation.
- Model capability by target type:
  - Proxmox node
  - QEMU VM
  - LXC container
  - Guest OS inside a VM or container
- Treat remote command execution as high risk. Design for explicit target selection, least privilege, auditability, and deny-by-default policies.
- Treat file writes, raw shell, `apt`, and destructive lifecycle actions as high-risk operations that must stay policy-gated and auditable.
- Keep the server zero-install from the target perspective. Do not introduce a mandatory guest-side agent unless the user explicitly wants an optional connector model.

## Source Of Truth
- Upstream docs mirror: `vendor/pve-docs`
- Local integration guides: `docs/proxmox`
- Official API wiki: `https://pve.proxmox.com/wiki/Proxmox_VE_API`
- Official API viewer: `https://pve.proxmox.com/pve-docs/api-viewer/index.html`

## Architecture Constraints
- Use Proxmox REST for lifecycle, inventory, storage, networking, permissions, cluster, and task orchestration.
- Use QEMU guest agent endpoints for VM guest exec and file IO when available.
- Do not assume equivalent REST exec/file APIs exist for LXC guests; verify first.
- For arbitrary host shell access on Proxmox nodes, plan on SSH or an installed agent, not the Proxmox REST API alone.
- For Linux guests, prefer guest agent first and SSH second.
- For Windows guests, prefer guest agent first and PowerShell remoting second.
- Nested Docker support belongs on top of guest shell access, not as a separate v1 control plane.
- Long-running operations must work through the server-owned job layer even when the MCP client does not support progress or task-like semantics.

## MCP Product Rules
- Primary transport is stdio.
- Typed tools should cover the common Proxmox domains:
  - inventory
  - cluster/node actions
  - VM/LXC lifecycle
  - storage, network, firewall, backup, users, Ceph, SDN, tasks, console
- `proxmox_api_call` is the REST completeness guarantee.
- `proxmox_cli_run` is the non-REST completeness guarantee for approved Proxmox CLI families.
- `proxmox_shell_run`, `proxmox_file_read`, and `proxmox_file_write` are explicit escape hatches and should stay visibly high risk in both design and documentation.
- Expose async work through `job_get`, `job_wait`, `job_cancel`, and `job_logs`.
- Emit MCP progress notifications when possible, but do not make correctness depend on client support for them.

## Repo Map
- `src/`
  - MCP server, tool registration, env-based config loading, policy enforcement, job manager, Proxmox API client, SSH/PowerShell transports
- `tests/`
  - unit tests for schema validation, policy behavior, and inventory/capability discovery
- `vendor/pve-docs/`
  - vendored official Proxmox documentation and API viewer schema
- `docs/proxmox/`
  - local integration notes derived from upstream docs

## Implementation Expectations
- Keep schema-driven validation tied to the vendored Proxmox API viewer data.
- Normalize Proxmox task handling around UPIDs.
- Preserve deny-by-default policy behavior.
- Record shell, CLI, API mutation, and file operations to the audit log with secret redaction.
- Keep config and tool names stable unless a breaking rename is justified and documented.
- Keep the developed app's documentation up to date as part of normal implementation work. When behavior, setup, tool surface, lab state, or operator workflow changes, update the relevant tracked docs in the same change.
- Keep lab documentation aligned with what has actually been validated on the disposable T2 environment, not just the intended design.

## Expected Repo Changes
- Keep generated Proxmox summaries reproducible from upstream sources.
- If `vendor/pve-docs` is refreshed, regenerate `docs/proxmox/api-summary.json`.
- Prefer small, auditable scripts over one-off manual extraction steps.
- Keep README and `config.toml` env examples aligned with the actual implemented MCP surface.
- If new typed tools are added, update the documented tool inventory and keep escape-hatch usage narrow.
