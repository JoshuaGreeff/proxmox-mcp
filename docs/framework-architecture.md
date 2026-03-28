# Framework Architecture

`Proxmox-MCP` is a Proxmox automation framework, not a flat collection of unrelated tools.

The framework has three layers:

1. Transport and infrastructure
   - Proxmox REST client
   - approved Proxmox CLI over SSH
   - explicit shell and file transports
   - artifact manager and MCP artifact resources
   - config loading and defaults
   - steady-state secret loading plus optional dev-only local bootstrap
   - policy enforcement
   - audit logging
   - server-owned jobs

2. Validated domain modules
   - typed MCP tools built on top of the shared transports
   - added only after we have personally exercised them in the lab
   - should expose generic domain capabilities that stay as close as practical to Proxmox concepts and API boundaries
   - should feel more like an MCP-shaped Proxmox API than a bundle of operator recipes
   - should not be built around presets, opinionated bundles, or one-off operator workflows
   - own their defaults, reconciliation, validation, and docs
   - should be organized in `src/tools/<domain>/` so the repo layout mirrors the module boundaries

One explicit exception is diagnostics-oriented tooling. Those tools may aggregate several closely related low-level signals when that materially improves fault isolation, but they must still document the exact transports and evidence sources they use.

The schema-derived source of truth for planned and current domain coverage lives in [module-inventory.md](./proxmox/module-inventory.md).

3. Generic completeness tools
   - `proxmox_api_call`
   - `proxmox_cli_run`
   - `proxmox_shell_run`
   - `proxmox_file_read`
   - `proxmox_file_write`

These remain the completeness guarantee for Proxmox areas that are not yet productized as validated typed modules.

## Runtime Auth Model

The framework now treats enrollment bootstrap and steady-state runtime auth as separate concerns.

Normal runtime:
- reads a steady-state API token from the configured secret backend
- optionally reads a separate shell SSH identity for high-risk escape paths
- never self-generates new credentials during normal startup

Dev-only local bootstrap:
- remains available only for explicit stdio maintainer mode
- uses the legacy managed-auth lifecycle to reconcile a disposable environment
- is not the production security model

## Current Validated Modules

### Templates And Clones

This is the first validated framework area.

Responsibilities:
- expose low-level QEMU provisioning and template primitives
- expose template inspection as a first-class read workflow
- keep snippet placement and VM lifecycle composition explicit instead of bundling them into a single workflow tool
- keep base templates free of operator-specific SSH keys

Internal transport mix:
- REST for image download, VM creation, VM config updates, cloning, template conversion, and lifecycle reads
- SSH only for validated storage/file gaps such as snippet file placement
- snippet file management on Proxmox storage for `cicustom`

### Boot And Bootstrap

This is a dedicated diagnostics module for VM first-boot behavior.

Responsibilities:
- diagnose why a VM or clone did not complete its first-boot/bootstrap path
- document distro-specific quirks as lab findings instead of shipping a built-in recommendation engine

Internal transport mix:
- REST for VM status/config and guest-agent probes
- approved CLI for `qm cloudinit dump`
- node-terminal fallback for bounded read-only offline disk inspection when guest-side telemetry is missing

This module is intentionally separate from generic QEMU CRUD tools because first-boot failures often require multi-signal evidence gathering and bounded offline inspection.

### Cloud-Init Snippets

This module manages snippet-capable Proxmox storage for cloud-init workflows.

Responsibilities:
- list, read, write, and delete snippet files
- validate snippet-capable storage
- support template and clone workflows without dropping to raw file writes
- publish large snippet bodies and cloud-init dumps through MCP artifact resources when inline tool results are not a good fit

Important cloud-init roles:
- `user`: clone/user-specific guest configuration
- `vendor`: template-carried first-boot bootstrap or shared vendor data
- `network`: generated or custom network config
- `meta`: generated or custom instance metadata

### Node Terminal

This is a convenience module, not a replacement for raw shell or typed workflows.

Responsibilities:
- provide a node-only stateless command runner
- wait for completion or return a job handle
- keep the high-risk boundary explicit

Non-goals in the current pass:
- interactive PTY sessions
- persistent shell state
- guest terminal abstraction

## Validated Module Rule

Typed modules are only added after we have tried the workflow ourselves.

The lifecycle is:
1. perform the workflow manually
2. confirm the correct transport mix and failure modes
3. implement the typed module
4. add unit tests
5. add live validation
6. update README and this architecture doc

If a Proxmox area has not gone through that lifecycle yet, it should stay behind the generic completeness tools.

Direct live validation should use the stdio harness documented in [direct-mcp-testing.md](./direct-mcp-testing.md) instead of relying on editor-side MCP reload behavior.

## Module Design Rules

When building new validated modules:

- prefer the documented Proxmox REST API first
- treat SSH, CLI, shell, and file transports as fallback paths for validated API gaps only
- expose low-level generic typed tools that remain close to Proxmox resources and operations
- prefer a set of small composable primitives over a single large “do the whole workflow” tool
- do not start with preset-specific tools or bundled workflows when a generic typed primitive can be modeled cleanly
- allow diagnostics tools to aggregate several closely related low-level signals when that materially improves fault isolation
- if convenience wrappers are added later, they should be thin wrappers over the generic typed workflow rather than separate implementations
- keep transport choices internal so agents interact with domain concepts, not host-side command choreography
- when outputs are large or binary, prefer artifact/resource publication over oversized inline JSON
- do not add new reusable functionality to the legacy PowerShell/operator wrappers when it belongs in the MCP product surface

## Provenance Comment Rule

Public MCP tools and their implementing service methods must document how they work.

For public tool registrations:
- include a short responsibility comment
- include a `Uses:` note describing the Proxmox endpoint family or operation family
- include a `Fallback:` note when SSH, CLI, guest-agent, or file access is involved
- keep each registration in the domain folder that matches the resource family it exposes

For public-facing service or domain-service methods:
- document the REST endpoint family they use
- document guest-agent calls if used
- document CLI family if used
- document SSH/file fallback if used
- explain why fallback exists when REST does not cleanly cover the behavior

Private helpers do not need the full provenance format unless they are non-obvious or high-risk.

This keeps the framework broadly useful across future domains such as users, clustering, HA, networking, and storage instead of baking in narrow operator recipes.

## Mutation Workflow Pattern

New mutating modules should follow the same pattern:

1. Preflight
   - resolve defaults
   - validate node/storage/snippet requirements
   - verify coherent inputs before mutation

2. Execute
   - prefer the documented Proxmox REST API whenever it covers the workflow cleanly
   - treat SSH-backed CLI, shell, and file transports as fallback-only paths
   - only drop to fallback transports for validated gaps such as snippet file placement
   - keep transport choice internal to the module

3. Reconcile
   - support replace/retry for managed artifacts
   - clean up partial state where feasible

4. Validate
   - confirm the expected Proxmox-side config exists after mutation
   - optionally wait for guest agent or other readiness signals when the workflow needs it

5. Audit
   - record a typed workflow action
   - do not rely only on lower-level transport audit records

## Guidance For Future Modules

Future domains such as users, VM provisioning, clustering, HA, storage, and networking should follow the same structure:
- domain-first public tools
- generic typed workflows first, convenience wrappers second
- REST-first implementations, SSH fallback only where the API does not cleanly cover the workflow
- validated-only release rule
- explicit comments at module boundaries
- README and maintainer docs updated in the same change
