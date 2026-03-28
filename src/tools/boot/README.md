# Boot Tools

This folder contains VM boot/bootstrap diagnostics.

Current tools:
- `proxmox_vm_boot_diagnose`

Why this folder exists:
- these tools are VM-scoped, but they are intentionally more aggregating than the normal CRUD-style QEMU tools
- diagnosing first-boot failures often requires evidence from:
  - VM config and status
  - guest-agent probes
  - cloud-init or tiny-cloud artifacts
  - node-side offline inspection of the guest disk
- distro-specific interpretation should stay with the agent and maintainer docs, not a built-in recommendation engine

Transport preference:
- REST first for VM status/config and guest-agent probes
- approved CLI for cloud-init dump
- node-terminal fallback only for bounded read-only offline diagnostics

Validation boundary:
- keep these tools focused on diagnosis and evidence gathering
- do not turn them into mutating provisioning workflows
- add new distro findings only after reproducing the behavior in the lab
