# Proxmox Integration Reference

This folder is the repo-local implementation map for Proxmox VE used by `Proxmox-MCP`.

## What is included
- Official upstream docs checkout: [vendor/pve-docs](../../vendor/pve-docs)
- API programming notes: [docs/proxmox/api-programming-guide.md](./api-programming-guide.md)
- Command and feature map: [docs/proxmox/command-map.md](./command-map.md)
- Generated API topology summary: [docs/proxmox/api-summary.json](./api-summary.json)

## Official upstream material we pulled
- The official `pve-docs` repository includes the admin guide, CLI manpages, generated command synopses, and API viewer assets.
- The upstream checkout also contains `api-viewer/apidata.js`, which is the machine-readable schema behind the public API viewer.

## What matters for this MCP project
- Proxmox is strong as a management API.
- Proxmox is partial as a guest operations API.
- Proxmox is not, by itself, a universal remote shell substrate across nodes, VMs, containers, and nested workloads.

## High-value files in the upstream mirror
- [vendor/pve-docs/pve-admin-guide.adoc](../../vendor/pve-docs/pve-admin-guide.adoc)
- [vendor/pve-docs/pvesh.adoc](../../vendor/pve-docs/pvesh.adoc)
- [vendor/pve-docs/pveum.adoc](../../vendor/pve-docs/pveum.adoc)
- [vendor/pve-docs/qm.adoc](../../vendor/pve-docs/qm.adoc)
- [vendor/pve-docs/pct.adoc](../../vendor/pve-docs/pct.adoc)
- [vendor/pve-docs/pvenode.adoc](../../vendor/pve-docs/pvenode.adoc)
- [vendor/pve-docs/pvesm.adoc](../../vendor/pve-docs/pvesm.adoc)
- [vendor/pve-docs/pvecm.adoc](../../vendor/pve-docs/pvecm.adoc)
- [vendor/pve-docs/vzdump.adoc](../../vendor/pve-docs/vzdump.adoc)
- [vendor/pve-docs/api-viewer/apidata.js](../../vendor/pve-docs/api-viewer/apidata.js)

## Practical conclusion
For this repo, treat Proxmox as:
- The source of truth for cluster inventory and lifecycle control
- A direct exec/file channel for QEMU VMs only when guest agent support exists
- A console-proxy provider for nodes and LXC guests
- An incomplete replacement for SSH or a custom installed connector
