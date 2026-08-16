# tglow Windows installer (PowerShell)
# Usage: irm https://tglow.phatnt.com/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo = "phatnt199/tglow"
$ReleasesUrl = "https://github.com/$Repo/releases"
$DownloadBase = "$ReleasesUrl/latest/download"

function Write-Ok ($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn ($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err ($msg) { Write-Host "`n  ✗ $msg`n" -ForegroundColor Red; exit 1 }
function Write-Info ($msg) { Write-Host "  $msg" }

Write-Host "`ntglow installer (Windows)`n" -ForegroundColor White

# ── Architecture Check ────────────────────────────────────────────────────────
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($Arch -ne [System.Runtime.InteropServices.Architecture]::X64) {
    Write-Err "Unsupported Windows architecture: $Arch (only x64 supported)"
}
$Artifact = "tglow-windows-x64.exe"

# ── Directories ───────────────────────────────────────────────────────────────
$InstallDir = if ($env:TGLOW_INSTALL_DIR) { $env:TGLOW_INSTALL_DIR } else { "$env:LOCALAPPDATA\tglow" }
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

Write-Info "Platform : $Artifact"
Write-Info "Install  : $InstallDir\tglow.exe`n"

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    # ── Download Checksum ─────────────────────────────────────────────────────
    Write-Info "Downloading checksum…"
    $ShaFile = "$TempDir\tglow.sha256"
    Invoke-WebRequest -Uri "$DownloadBase/tglow.sha256" -OutFile $ShaFile -UseBasicParsing
    Write-Ok "Got tglow.sha256"

    # ── Download Binary ───────────────────────────────────────────────────────
    Write-Info "Downloading $Artifact…"
    $BinaryFile = "$TempDir\$Artifact"
    Invoke-WebRequest -Uri "$DownloadBase/$Artifact" -OutFile $BinaryFile -UseBasicParsing
    Write-Ok "Downloaded $Artifact"

    # ── Verify Checksum ───────────────────────────────────────────────────────
    Write-Info "Verifying checksum…"
    $ExpectedHash = $null
    Get-Content $ShaFile | ForEach-Object {
        if ($_ -match "^\s*([a-fA-F0-9]{64})\s+.*$Artifact$") {
            $ExpectedHash = $Matches[1].ToLower()
        }
    }
    if (-not $ExpectedHash) {
        Write-Err "No checksum found for $Artifact in tglow.sha256"
    }

    $ActualHash = $null
    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
        $ActualHash = (Get-FileHash -Path $BinaryFile -Algorithm SHA256).Hash.ToLower()
    } elseif (Get-Command certutil.exe -ErrorAction SilentlyContinue -or (Get-Command certutil -ErrorAction SilentlyContinue)) {
        $CertUtilOut = certutil -hashfile "$BinaryFile" SHA256
        $MatchedLine = $CertUtilOut | Select-String -Pattern '^[a-fA-F0-9]{64}$'
        if ($MatchedLine) {
            $ActualHash = $MatchedLine.ToString().Trim().ToLower()
        }
    }

    if (-not $ActualHash) {
        Write-Err "No sha256 tool found (Get-FileHash or certutil required) — cannot verify checksum"
    }

    if ($ActualHash -ne $ExpectedHash) {
        Remove-Item -Path $BinaryFile -Force -ErrorAction SilentlyContinue
        Write-Err "Checksum mismatch! Expected $ExpectedHash, got $ActualHash. The download may be corrupt."
    }
    Write-Ok "Checksum verified"

    # ── Atomic Install ────────────────────────────────────────────────────────
    $TargetExe = "$InstallDir\tglow.exe"
    $TempExe = "$InstallDir\.tglow.tmp.$PID.exe"
    Copy-Item -Path $BinaryFile -Destination $TempExe -Force
    Move-Item -Path $TempExe -Destination $TargetExe -Force
    Write-Ok "Installed tglow → $TargetExe"

    # ── PATH Configuration ───────────────────────────────────────────────────
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $Paths = @()
    if ($UserPath) {
        $Paths = $UserPath.Split(';') | Where-Object { $_ -and $_.Trim() -ne '' }
    }
    if ($Paths -notcontains $InstallDir) {
        $NewPath = ($Paths + $InstallDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
        $env:Path = "$env:Path;$InstallDir"
        Write-Ok "Added $InstallDir to User PATH"
    }

    # ── Config Setup ──────────────────────────────────────────────────────────
    if ($env:TGLOW_NO_CONFIG -ne '1') {
        $ConfigDir = "$HOME\.config\tglow"
        $ConfigFile = "$ConfigDir\config.toml"

        if (Test-Path $ConfigFile) {
            Write-Ok "Config already exists at $ConfigFile — skipping"
        } else {
            $IsInteractive = $true
            try {
                if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
                    $IsInteractive = $false
                }
            } catch {
                $IsInteractive = $true
            }

            if (-not $IsInteractive) {
                Write-Info "No interactive terminal available — skipping config creation."
                Write-Info "You can configure tglow later by creating $ConfigFile"
            } else {
                Write-Host "`nTelegram API credentials" -ForegroundColor White
                Write-Info "tglow ships no API keys. You need your own api_id and api_hash"
                Write-Info "from https://my.telegram.org → Log in → API development tools"
                Write-Info "(Takes about a minute — the app name and description can be anything.)`n"

                $ApiId = ""
                while ($true) {
                    try {
                        $ApiId = (Read-Host "  api_id (number)").Trim()
                    } catch {
                        Write-Warn "Failed to read api_id — skipping config creation"
                        break
                    }
                    if ($ApiId -match '^\d+$') {
                        break
                    }
                    Write-Warn "api_id must be a number — try again"
                }

                $ApiHash = ""
                if ($ApiId -match '^\d+$') {
                    while ($true) {
                        try {
                            $ApiHash = (Read-Host "  api_hash (string)").Trim()
                        } catch {
                            Write-Warn "Failed to read api_hash — skipping config creation"
                            break
                        }
                        if ($ApiHash -ne '') {
                            break
                        }
                        Write-Warn "api_hash cannot be empty — try again"
                    }
                }

                if ($ApiId -match '^\d+$' -and $ApiHash -ne '') {
                    if (-not (Test-Path $ConfigDir)) {
                        New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
                    }

                    $ConfigContent = @"
api_id   = $ApiId
api_hash = "$ApiHash"
palette  = "sage"

# mouse  = true      # set to false to disable mouse capture
# update_check = true
"@
                    Set-Content -Path $ConfigFile -Value $ConfigContent -Encoding UTF8
                    Write-Ok "Config written to $ConfigFile"
                }
            }
        }
    }

    Write-Host "`nDone!" -ForegroundColor White
    Write-Host " Type " -NoNewline
    Write-Host "tglow" -ForegroundColor Green -NoNewline
    Write-Host " to start.`n"
} finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
