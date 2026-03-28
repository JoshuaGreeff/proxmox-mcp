# Proxmox Boot And Bootstrap Notes

This document tracks the validated behavior behind the VM boot/bootstrap diagnostics tool.

It exists because VM first-boot failures often span several layers at once:
- Proxmox VM shape
- guest bootstrap stack
- cloud-init or tiny-cloud data slots
- package-manager side effects
- guest-agent installation timing

## Current Validated Findings

### Debian 12 generic cloud image

Validated shape:
- bootstrap stack: `cloud-init`
- bootstrap data mode: `vendor`
- machine: default BIOS/PCI path used by the current Debian template

Observed result:
- cloud-init enters the boot graph
- guest-agent install runs
- guest-agent becomes reachable after first boot

### Ubuntu 24.04 minimal cloud image

Validated bad combination:
- bootstrap stack: `cloud-init`
- bootstrap data mode: `vendor`
- machine: `q35`
- firmware: `OVMF`

Observed result:
- the VM boots
- cloud-init is installed in the image
- guest-agent remains unavailable
- offline journal inspection shows no cloud-init service activity at all

Validated workaround:
- `machine=pc`
- `bios=seabios`

Observed result after changing only the VM shape on a disposable clone:
- guest-agent comes up
- the first-boot bootstrap path succeeds

Validated follow-up for AI workloads:
- bootstrap the clone first on the working generic shape
- after bootstrap is complete, switch the workload VM to:
  - `machine=q35`
  - `bios=ovmf`
  - EFI disk attached
  - GPU passthrough in PCIe form, passing the whole multifunction device together

Observed result:
- the guest keeps a healthy `cloud-init`/guest-agent state
- the NVIDIA driver initializes successfully
- `nvidia-smi` works in the guest
- Docker with the NVIDIA runtime can see the GPU

Maintainer note:
- the generic Ubuntu template and the final AI workload VM do not need to use the same VM shape
- for the current lab, the reliable pattern is:
  - generic base template: `pc` + `seabios`
  - post-bootstrap AI VM: `q35` + `ovmf` + PCIe passthrough

### Alpine 3.23 cloud image

Observed guest bootstrap stack:
- `tiny-cloud`, not `cloud-init`

Validated bad combinations:
- relying on `vendor` bootstrap semantics
- enabling package upgrades on the current 128 MB base disk

Observed result:
- tiny-cloud runs and detects `nocloud`
- user-data style handlers execute
- package upgrade attempts can fail with `No space left on device`
- guest-agent does not become available

Implications:
- Alpine should not be treated as “cloud-init with different package names”
- tiny-cloud needs its own validated data-slot strategy
- minimal Alpine templates need either a larger disk or package-upgrade disabled by default

## Tooling Intent

The MCP server exposes one boot-oriented diagnostics tool:

- `proxmox_vm_boot_diagnose`
  Diagnose a real VM/clone that already failed to bootstrap.

This tool is allowed to aggregate several low-level signals because boot failures often require evidence from multiple layers.

The server does not include a built-in recommendation engine for distro quirks. Agents are expected to combine:
- `proxmox_vm_boot_diagnose`
- upstream distro and Proxmox documentation
- bounded manual validation when needed

## AI VM Lab Notes

Current validated host facts for the lab AI workload VM:
- host CPU: AMD Ryzen Threadripper PRO 5965WX
- host NUMA nodes: `1`
- GPU passthrough workload validated on VM `100`

Implications for this lab:
- NUMA pinning is not useful on the current host because there is only one NUMA node
- disabling ballooning on the AI VM is appropriate once the final workload memory size is known
- hugepages were not enabled for the validated VM because the host currently has no reserved hugetlb pages

Current validated AI VM memory guidance for this host:
- keep fixed memory for the workload VM
- set `balloon: 0`
- do not add NUMA placement rules unless the host topology changes
- only enable `hugepages` after the host is explicitly configured to provide them

## Maintainer Rules

- Add new distro/bootstrap findings only after reproducing them in the lab.
- Keep validated quirks explicit in docs and tests, not in hidden mutation logic.
- Do not silently force machine, firmware, or data-slot choices in diagnostics code.
- When a finding changes, update:
  - `src/tools/boot/README.md`
  - this document
  - the schema-derived module inventory
