$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$vendorPath = Join-Path $repoRoot "vendor\pve-docs"
$upstream = "https://git.proxmox.com/git/pve-docs.git"

if (Test-Path (Join-Path $vendorPath ".git")) {
  git -C $vendorPath pull --ff-only
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $vendorPath) | Out-Null
  git clone --depth 1 $upstream $vendorPath
}

node (Join-Path $repoRoot "scripts\extract-proxmox-api-summary.mjs")
