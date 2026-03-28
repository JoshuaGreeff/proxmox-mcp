# Proxmox Command And Feature Map

This map is derived from the official `pve-docs` checkout and is organized around command families relevant to an MCP integration.

## Core API and identity
- `pvesh`: shell interface to the Proxmox API
  - Source: [vendor/pve-docs/pvesh.adoc](../../vendor/pve-docs/pvesh.adoc)
- `pveum`: users, groups, roles, ACLs, API tokens, realms, TFA
  - Source: [vendor/pve-docs/pveum.adoc](../../vendor/pve-docs/pveum.adoc)

## Node and cluster control
- `pvenode`: node management
  - Source: [vendor/pve-docs/pvenode.adoc](../../vendor/pve-docs/pvenode.adoc)
- `pvecm`: cluster manager
  - Source: [vendor/pve-docs/pvecm.adoc](../../vendor/pve-docs/pvecm.adoc)
- `ha-manager`, `pve-ha-crm`, `pve-ha-lrm`: high availability
  - Sources:
  - [vendor/pve-docs/ha-manager.adoc](../../vendor/pve-docs/ha-manager.adoc)
  - [vendor/pve-docs/pve-ha-crm.adoc](../../vendor/pve-docs/pve-ha-crm.adoc)
  - [vendor/pve-docs/pve-ha-lrm.adoc](../../vendor/pve-docs/pve-ha-lrm.adoc)

## Virtual machines
- `qm`: QEMU/KVM VM management
  - Source: [vendor/pve-docs/qm.adoc](../../vendor/pve-docs/qm.adoc)
- `qmrestore`: VM restore
  - Source: [vendor/pve-docs/qmrestore.adoc](../../vendor/pve-docs/qmrestore.adoc)
- `qm.conf`: VM config options
  - Source: [vendor/pve-docs/qm.conf.adoc](../../vendor/pve-docs/qm.conf.adoc)
- `qm-cloud-init`: cloud-init integration
  - Source: [vendor/pve-docs/qm-cloud-init.adoc](../../vendor/pve-docs/qm-cloud-init.adoc)
- `qm-pci-passthrough`: PCI passthrough
  - Source: [vendor/pve-docs/qm-pci-passthrough.adoc](../../vendor/pve-docs/qm-pci-passthrough.adoc)

## Linux containers
- `pct`: LXC container management
  - Source: [vendor/pve-docs/pct.adoc](../../vendor/pve-docs/pct.adoc)
- `pct.conf`: container config options
  - Source: [vendor/pve-docs/pct.conf.adoc](../../vendor/pve-docs/pct.conf.adoc)

## Storage and backup
- `pvesm`: storage manager
  - Source: [vendor/pve-docs/pvesm.adoc](../../vendor/pve-docs/pvesm.adoc)
- `vzdump`: backup tool
  - Source: [vendor/pve-docs/vzdump.adoc](../../vendor/pve-docs/vzdump.adoc)
- `pvesr`: storage replication
  - Source: [vendor/pve-docs/pvesr.adoc](../../vendor/pve-docs/pvesr.adoc)
- `pveam`: appliance/template manager
  - Source: [vendor/pve-docs/pveam.adoc](../../vendor/pve-docs/pveam.adoc)

## Network, firewall, SDN
- `pve-firewall`: firewall management
  - Source: [vendor/pve-docs/pve-firewall.adoc](../../vendor/pve-docs/pve-firewall.adoc)
- `pvesdn`: software-defined networking
  - Source: [vendor/pve-docs/pvesdn.adoc](../../vendor/pve-docs/pvesdn.adoc)
- `pve-network`: network architecture and configuration
  - Source: [vendor/pve-docs/pve-network.adoc](../../vendor/pve-docs/pve-network.adoc)

## Ceph and hyper-converged features
- `pveceph`: Ceph management
  - Source: [vendor/pve-docs/pveceph.adoc](../../vendor/pve-docs/pveceph.adoc)
- Hyper-converged guidance
  - Source: [vendor/pve-docs/hyper-converged-infrastructure.adoc](../../vendor/pve-docs/hyper-converged-infrastructure.adoc)

## System and service internals
- `pvedaemon`, `pveproxy`, `pvestatd`, `pvescheduler`, `qmeventd`, `spiceproxy`
  - Sources:
  - [vendor/pve-docs/pvedaemon.adoc](../../vendor/pve-docs/pvedaemon.adoc)
  - [vendor/pve-docs/pveproxy.adoc](../../vendor/pve-docs/pveproxy.adoc)
  - [vendor/pve-docs/pvestatd.adoc](../../vendor/pve-docs/pvestatd.adoc)
  - [vendor/pve-docs/pvescheduler.adoc](../../vendor/pve-docs/pvescheduler.adoc)
  - [vendor/pve-docs/qmeventd.adoc](../../vendor/pve-docs/qmeventd.adoc)
  - [vendor/pve-docs/spiceproxy.adoc](../../vendor/pve-docs/spiceproxy.adoc)

## Feature areas not to collapse into one "exec" abstraction
- Cluster and datacenter config
- Node operations
- VM lifecycle
- LXC lifecycle
- Guest console access
- VM guest-agent exec
- VM guest-agent file IO
- Backup and restore
- Storage replication
- Networking and firewall
- Identity, ACL, token, and realm administration

These are separate capability families in Proxmox and should stay separate in the MCP tool design.
