[CmdletBinding()]
param(
  [string]$VMName = "pve-t2",
  [string]$IsoPath = "",
  [string]$VmRoot = "C:\HyperV\Proxmox-MCP",
  [string]$SwitchName,
  [int]$VcpuCount = 4,
  [int]$StartupMemoryGB = 8,
  [int]$MinimumMemoryGB = 4,
  [int]$MaximumMemoryGB = 16,
  [int]$DiskSizeGB = 96,
  [switch]$StartVm
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

function Resolve-SwitchName {
  param([string]$PreferredName)

  if ($PreferredName) {
    $switch = Get-VMSwitch -Name $PreferredName -ErrorAction Stop
    return $switch.Name
  }

  $defaultSwitch = Get-VMSwitch | Where-Object { $_.Name -eq "Default Switch" } | Select-Object -First 1
  if ($defaultSwitch) {
    return $defaultSwitch.Name
  }

  $externalSwitch = Get-VMSwitch | Where-Object { $_.SwitchType -eq "External" } | Select-Object -First 1
  if ($externalSwitch) {
    return $externalSwitch.Name
  }

  throw "No Hyper-V switch found. Create one first or pass -SwitchName."
}

Assert-Admin

if (-not (Test-Path $IsoPath)) {
  throw "Pass -IsoPath to a valid Proxmox VE ISO."
}

$resolvedSwitchName = Resolve-SwitchName -PreferredName $SwitchName
$vmPath = Join-Path $VmRoot $VMName
$vhdPath = Join-Path $vmPath "$VMName.vhdx"
$startupMemoryBytes = $StartupMemoryGB * 1GB
$minimumMemoryBytes = $MinimumMemoryGB * 1GB
$maximumMemoryBytes = $MaximumMemoryGB * 1GB
$diskSizeBytes = $DiskSizeGB * 1GB

New-Item -ItemType Directory -Force -Path $vmPath | Out-Null

if (Get-VM -Name $VMName -ErrorAction SilentlyContinue) {
  throw "VM '$VMName' already exists."
}

New-VM `
  -Name $VMName `
  -Generation 2 `
  -MemoryStartupBytes $startupMemoryBytes `
  -NewVHDPath $vhdPath `
  -NewVHDSizeBytes $diskSizeBytes `
  -Path $vmPath `
  -SwitchName $resolvedSwitchName | Out-Null

Set-VMMemory `
  -VMName $VMName `
  -DynamicMemoryEnabled $true `
  -MinimumBytes $minimumMemoryBytes `
  -StartupBytes $startupMemoryBytes `
  -MaximumBytes $maximumMemoryBytes

Set-VMProcessor -VMName $VMName -Count $VcpuCount -ExposeVirtualizationExtensions $true
Set-VMNetworkAdapter -VMName $VMName -MacAddressSpoofing On
Set-VMFirmware -VMName $VMName -EnableSecureBoot Off

Add-VMDvdDrive -VMName $VMName -Path $IsoPath | Out-Null
$dvd = Get-VMDvdDrive -VMName $VMName
Set-VMFirmware -VMName $VMName -FirstBootDevice $dvd

Write-Host "Created VM '$VMName'"
Write-Host "Switch: $resolvedSwitchName"
Write-Host "Disk: $vhdPath"
Write-Host "ISO: $IsoPath"
Write-Host "Nested virtualization: enabled"
Write-Host "MAC spoofing: enabled"

if ($StartVm) {
  Start-VM -Name $VMName | Out-Null
  Write-Host "VM started."
} else {
  Write-Host "VM not started. Use Start-VM -Name '$VMName' when ready."
}
