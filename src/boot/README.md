# Boot And Bootstrap Internals

This folder contains the internal logic behind VM boot/bootstrap diagnosis.

Why it exists:
- normal typed MCP tools stay close to Proxmox resource APIs
- VM boot failures often require a bounded aggregate of several signals
- distro-specific bootstrap stacks behave differently:
  - Ubuntu and Debian typically use `cloud-init`
  - Alpine cloud images currently use `tiny-cloud`

Contents:
- `types.ts`
  Shared result types used by the boot/bootstrap tool surface.
- `diagnostics.ts`
  Node-side offline inspection helpers used by VM boot diagnosis when guest-agent access is unavailable.

Maintainer rules:
- keep this folder focused on evidence gathering, not built-in recommendation policy
- do not silently force template settings or distro-specific workflows here
- if a new distro/bootstrap combination is validated, document it in:
  - `docs/proxmox/boot-and-bootstrap.md`
  - the relevant MCP tool docs
