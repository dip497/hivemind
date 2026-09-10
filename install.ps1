<#
.SYNOPSIS
  hivemind installer / upgrader — Windows x64.

.DESCRIPTION
  DEFAULT: downloads prebuilt binaries from the latest GitHub Release. Needs
  only PowerShell 5.1+ (ships with Windows) and an agent CLI such as `claude`
  on PATH. No node / pnpm / bun required.

    irm https://raw.githubusercontent.com/dip497/hivemind/main/install.ps1 | iex

  WITH -Dev: clones the source repo and builds locally. Needs git, node >= 22,
  pnpm >= 10, bun >= 1.1.

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/dip497/hivemind/main/install.ps1))) -Dev

  Re-running UPGRADES in place. Installed users then manage the app with the
  `hivemind` launcher:

    hivemind upgrade            # re-run this installer (latest release)
    hivemind uninstall          # remove app + launcher + Start Menu shortcut
    hivemind uninstall -Purge   # also delete settings/sessions

  STATUS: Windows support is NOT yet validated on real hardware — the build is
  produced and asserted in CI, but no one has launched it. Report what breaks:
  https://github.com/dip497/hivemind/issues

.PARAMETER Dev
  Build from source instead of downloading a release.

.PARAMETER Version
  Pin a release tag (e.g. v1.17.0). Default: latest.
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [string]$Version = $env:HIVEMIND_VERSION,
  [string]$Repo = $(if ($env:HIVEMIND_REPO) { $env:HIVEMIND_REPO } else { "dip497/hivemind" })
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Say  ($m) { Write-Host "> $m" -ForegroundColor Blue }
function Ok   ($m) { Write-Host "+ $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

# %LOCALAPPDATA%\hivemind — per-user, no elevation, and the same root the app's
# CLI lookup checks first (see hiveBinCandidates in apps/desktop/src/main/platform.ts).
$AppDir = if ($env:HIVEMIND_APP_DIR) { $env:HIVEMIND_APP_DIR } else { Join-Path $env:LOCALAPPDATA "hivemind" }
$BinDir = Join-Path $AppDir "bin"
$VersionFile = Join-Path $AppDir ".installed-version"

if ([Environment]::Is64BitOperatingSystem -eq $false) { Die "hivemind needs 64-bit Windows." }

# ---------------------------------------------------------------- launcher ---
# A .cmd shim rather than a shortcut: it has to work from PowerShell, cmd and
# the Run box, forward argv (`hivemind C:\path\to\repo`), and carry the
# upgrade/uninstall verbs the docs promise. `start ""` detaches so launching
# from a terminal doesn't pin the console open.
function Write-Launcher {
  $launcher = Join-Path $BinDir "hivemind.cmd"
  $appExe = Join-Path $AppDir "app\hivemind.exe"
  @"
@echo off
setlocal
if /i "%~1"=="upgrade" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/$Repo/main/install.ps1 | iex"
  exit /b %ERRORLEVEL%
)
if /i "%~1"=="uninstall" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($BinDir -replace '"','""')\hivemind-uninstall.ps1" %2
  exit /b %ERRORLEVEL%
)
start "" "$appExe" %*
"@ | Set-Content -Path $launcher -Encoding ASCII
  Ok "launcher $launcher"
}

function Write-Uninstaller {
  $script = Join-Path $BinDir "hivemind-uninstall.ps1"
  @"
param([switch]`$Purge)
`$ErrorActionPreference = "SilentlyContinue"
Write-Host "hivemind: uninstalling..."
Get-Process -Name hivemind | Stop-Process -Force
Start-Sleep -Milliseconds 300
Remove-Item -Recurse -Force "$AppDir\app"
Remove-Item -Force "$(Join-Path ([Environment]::GetFolderPath('Programs')) 'hivemind.lnk')"
if (`$Purge) {
  # Two homes on Windows: Electron's userData, and the XDG-style registry the
  # CLI and app share (hive-core resolves ~/.config when XDG_CONFIG_HOME is unset).
  Remove-Item -Recurse -Force "`$env:APPDATA\hivemind"
  Remove-Item -Recurse -Force "`$(Join-Path `$HOME '.config\hivemind')"
  Write-Host "hivemind: removed user data"
} else {
  Write-Host "hivemind: kept user data - pass -Purge to remove it too"
}
Remove-Item -Force "$(Join-Path $BinDir 'hive.exe')"
Remove-Item -Force "$(Join-Path $BinDir 'hivemind.cmd')"
Write-Host "hivemind: uninstalled."
"@ | Set-Content -Path $script -Encoding UTF8
}

function Add-ToUserPath {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($current -and ($current -split ";" | Where-Object { $_ -eq $BinDir })) {
    Ok "$BinDir already on PATH"
    return
  }
  $joined = if ([string]::IsNullOrEmpty($current)) { $BinDir } else { "$current;$BinDir" }
  [Environment]::SetEnvironmentVariable("Path", $joined, "User")
  $env:Path = "$env:Path;$BinDir"
  Ok "added $BinDir to your PATH (new terminals pick it up)"
}

function Add-StartMenuShortcut {
  $lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "hivemind.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $AppDir "app\hivemind.exe"
  $s.WorkingDirectory = Join-Path $AppDir "app"
  $s.Description = "Infinite canvas for Claude Code & AI coding agents"
  $s.Save()
  Ok "Start Menu shortcut"
}

function Test-AppRunning {
  [bool](Get-Process -Name hivemind -ErrorAction SilentlyContinue)
}

# Unpack the release zip.
#
# NO staged-upgrade path, matching macOS and unlike Linux. Two reasons, either
# sufficient: Windows holds a lock on a running .exe, so the swap cannot happen
# at all while the app is up; and the Start Menu shortcut launches the bundle
# directly, so a staged dir would sit unapplied while the user kept starting the
# old build. The caller refuses to touch a running install instead.
function Install-App ($zip) {
  $dest = Join-Path $AppDir "app"
  $staging = Join-Path $AppDir "unpack"
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $staging -Force
  # electron-builder's zip has the app at the root; tolerate a single wrapper dir.
  $root = $staging
  $entries = @(Get-ChildItem -Path $staging)
  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $root = $entries[0].FullName }
  if (-not (Test-Path (Join-Path $root "hivemind.exe"))) { Die "no hivemind.exe inside $zip" }

  Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
  Move-Item $root $dest
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- prebuilt ---
function Install-Prebuilt {
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

  $tag = $Version
  if (-not $tag) {
    Say "resolving latest release of $Repo"
    try {
      $tag = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
    } catch { Die "could not reach the GitHub API - check your network" }
  }
  if (-not $tag) { Die "no published releases for $Repo. Use -Dev to build from source." }
  Say "target version: $tag"

  if ((Test-Path $VersionFile) -and ((Get-Content $VersionFile -Raw).Trim() -eq $tag)) {
    if (Test-Path (Join-Path $AppDir "app\hivemind.exe")) {
      Write-Launcher; Write-Uninstaller; Add-StartMenuShortcut; Add-ToUserPath
      Ok "launcher up to date"
    }
    Ok "already on $tag - nothing to do"
    return
  }

  if (Test-AppRunning) {
    Warn "hivemind is running - the app was NOT upgraded (Windows locks a running .exe)."
    Warn "Quit hivemind, then re-run ``hivemind upgrade``. Your canvas + sessions are untouched."
    return
  }

  $bare = $tag.TrimStart("v")
  $cliUrl = "https://github.com/$Repo/releases/download/$tag/hive-windows-x64.exe"
  $appUrl = "https://github.com/$Repo/releases/download/$tag/hivemind-$bare-x64-win.zip"
  $tmpCli = Join-Path $AppDir "hive.$PID.new"
  $tmpApp = Join-Path $AppDir "app.$PID.zip"

  try {
    Say "downloading hive CLI"
    # A PID-unique temp then Move-Item, for the same reason install.sh does it:
    # a direct write over a running .exe fails, and a fixed temp name races a
    # concurrent upgrade.
    Invoke-WebRequest -Uri $cliUrl -OutFile $tmpCli -UseBasicParsing
    Move-Item -Force $tmpCli (Join-Path $BinDir "hive.exe")
    Ok "installed $(Join-Path $BinDir 'hive.exe')"

    Say "downloading desktop app"
    Invoke-WebRequest -Uri $appUrl -OutFile $tmpApp -UseBasicParsing
    Say "unpacking"
    Install-App $tmpApp
    Write-Launcher; Write-Uninstaller; Add-StartMenuShortcut; Add-ToUserPath
    # Stamped only after the app actually landed — a failed download throws, so
    # the `hivemind upgrade` we tell the user to re-run isn't a no-op (the bug
    # install.sh had).
    Set-Content -Path $VersionFile -Value $tag
    Ok "installed $tag"
  } catch {
    Die "install failed: $($_.Exception.Message)"
  } finally {
    Remove-Item -Force $tmpCli, $tmpApp -ErrorAction SilentlyContinue
  }
}

# --------------------------------------------------------------------- dev ---
function Install-Dev {
  foreach ($c in @("git", "node", "pnpm", "bun")) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Die "$c missing - install it first (node >= 22, pnpm >= 10, bun >= 1.1)" }
  }
  $src = Join-Path $AppDir "src"
  if (Test-Path (Join-Path $src ".git")) {
    Say "updating $src"; git -C $src pull --ff-only
  } else {
    Say "cloning into $src"; git clone --depth 1 "https://github.com/$Repo.git" $src
  }
  Push-Location $src
  try {
    Say "pnpm install";  pnpm install --silent
    Say "building CLI";  pnpm --filter "@hivemind/cli" run build
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Copy-Item (Join-Path $src "apps\cli\dist\hive.exe") (Join-Path $BinDir "hive.exe") -Force
    Say "packaging app"; pnpm --filter "@hivemind/desktop" run dist:win
    $zip = Get-ChildItem (Join-Path $src "apps\desktop\dist-electron") -Filter *.zip | Select-Object -First 1
    if (-not $zip) { Die "no zip produced - check the electron-builder output" }
    Install-App $zip.FullName
    Write-Launcher; Write-Uninstaller; Add-StartMenuShortcut; Add-ToUserPath
    Ok "dev install ready"
  } finally { Pop-Location }
}

# --------------------------------------------------------------------- run ---
Say "mode: $(if ($Dev) { 'dev' } else { 'prebuilt' })"
if ($Dev) { Install-Dev } else { Install-Prebuilt }

if (Get-Command claude -ErrorAction SilentlyContinue) {
  Ok "claude -> $((Get-Command claude).Source)"
} else {
  Warn "claude CLI not found. The app launches without it, but spawning a Claude tile needs it:"
  Warn "  https://docs.claude.com/en/docs/claude-code"
}

Write-Host ""
Ok "hivemind ready."
Write-Host @"

  1. Initialize a workspace in any git repo:
     cd C:\path\to\my-project
     hive init --prefix MYP

  2. Create your first issue:
     hive new "Fix token expiry"

  3. Launch the desktop app:
     hivemind .

  Windows support is new and UNVALIDATED - if something breaks, please file it:
  https://github.com/$Repo/issues
"@
