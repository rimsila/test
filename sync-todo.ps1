param(
    [string]$Source = $PSScriptRoot,
    [string]$Remote = "gdrive:todo",
    [switch]$DryRun,
    [switch]$Mirror
)

$ErrorActionPreference = "Stop"
$FilterFile = Join-Path $PSScriptRoot "rclone-exclude.txt"

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    throw "rclone is not installed or is not available in PATH."
}

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Source folder does not exist: $Source"
}

if (-not (Test-Path -LiteralPath $FilterFile -PathType Leaf)) {
    throw "Filter file does not exist: $FilterFile"
}

$ResolvedSource = (Resolve-Path -LiteralPath $Source).Path
$Mode = if ($Mirror) { "sync" } else { "copy" }
$Arguments = @(
    $Mode,
    $ResolvedSource,
    $Remote,
    "--exclude-from", $FilterFile,
    "--create-empty-src-dirs",
    "--progress",
    "--verbose"
)

if ($DryRun) {
    $Arguments += "--dry-run"
}

Write-Host "Running: rclone $($Arguments -join ' ')"
& rclone @Arguments

if ($LASTEXITCODE -ne 0) {
    throw "rclone failed with exit code $LASTEXITCODE"
}
