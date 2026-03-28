# Escape Tools

This folder contains generic completeness tools, MCP resources, prompts, and job controls.

Current tools:
- `proxmox_api_call`
- `proxmox_cli_run`
- `proxmox_shell_run`
- `proxmox_file_read`
- `proxmox_file_write`
- `job_get`
- `job_wait`
- `job_cancel`
- `job_logs`
- `proxmox_bootstrap_node_access`
- `proxmox_capabilities`

Current resources:
- `proxmox://artifacts/{artifactId}`
- `proxmox://inventory/{cluster}`
- `proxmox://jobs/{jobId}/logs`

Transport preference:
- `proxmox_api_call` is the REST completeness guarantee
- `proxmox_cli_run` is the approved Proxmox CLI completeness guarantee
- shell and file access stay explicit and high risk

Validation boundary:
- these tools exist to cover validated gaps and completeness
- do not treat them as a substitute for adding generic typed domain primitives when a reusable Proxmox action is missing
