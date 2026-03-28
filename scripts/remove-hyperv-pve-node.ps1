[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$VMName = "pve-t2",
  [string]$VmRoot = "C:\HyperV\Proxmox-MCP",
  [switch]$KeepDisks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session."
  }
}

Assert-Admin

$vm = Get-VM -Name $VMName -ErrorAction SilentlyContinue
if (-not $vm) {
  throw "VM '$VMName' was not found."
}

if ($vm.State -ne "Off") {
  Stop-VM -Name $VMName -TurnOff -Force | Out-Null
}

$vmPath = Join-Path $VmRoot $VMName
$diskPaths = @(Get-VMHardDiskDrive -VMName $VMName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path)

Remove-VM -Name $VMName -Force

if (-not $KeepDisks) {
  foreach ($diskPath in $diskPaths) {
    if ($diskPath -and (Test-Path $diskPath)) {
      Remove-Item -Force $diskPath
    }
  }

  if (Test-Path $vmPath) {
    Remove-Item -Recurse -Force $vmPath
  }
}

Write-Host "Removed VM '$VMName'"
