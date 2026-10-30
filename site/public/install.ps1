<#
.SYNOPSIS
  hivemind installer / upgrader — Windows x64.

.DESCRIPTION
  DEFAULT: downloads prebuilt binaries from the latest GitHub Release. Needs
  only PowerShell 5.1+ (ships with Windows) and an agent CLI such as `claude`
  on PATH. No node / pnpm / bun required.

    irm https://raw.githubusercontent.com/dip497/hivemind/main/install.ps1 | iex

  NIGHTLY: pass -Channel nightly to install the newest pre-release built from main.

  WITH -Dev: clones the source repo and builds locally. Needs git, node >= 22,
  pnpm >= 12, bun >= 1.1.

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/dip497/hivemind/main/install.ps1))) -Dev

  Re-running UPGRADES, also while the app is open: the new version starts at
  its next restart. Installed users then manage the app with the
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
  Install exactly this release tag, an older one too (a rollback): e.g. v2026.10.0 or
  nightly-20261003-123. Default: the newest of the channel.

.PARAMETER Channel
  stable or nightly. Default: stable on first install; upgrades keep the installed channel.
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [string]$Version = $env:HIVEMIND_VERSION,
  [string]$Channel = $env:HIVEMIND_CHANNEL,
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
if (-not $Channel) {
  $installed = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { "" }
  $Channel = if ($installed -match '^nightly-') { "nightly" } else { "stable" }
}
if ($Channel -notin @("stable", "nightly")) { Die "channel must be stable or nightly" }

if ([Environment]::Is64BitOperatingSystem -eq $false) { Die "hivemind needs 64-bit Windows." }

# ---------------------------------------------------------------- launcher ---
# A .cmd shim rather than a shortcut: it has to work from PowerShell, cmd and
# the Run box, forward argv (`hivemind C:\path\to\repo`), and carry the
# upgrade/uninstall verbs the docs promise. `start ""` detaches so launching
# from a terminal doesn't pin the console open.
function Write-Launcher {
  $launcher = Join-Path $BinDir "hivemind.cmd"
  $appExe = Join-Path $AppHome "hivemind.exe"
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
Get-ChildItem -Path "$AppDir" -Directory | Where-Object { `$_.Name -eq "app" -or `$_.Name -like "app-*" } | Remove-Item -Recurse -Force
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
Remove-Item -Force "$(Join-Path $BinDir 'hive-net.exe')"
Remove-Item -Force "$(Join-Path $BinDir '*.old.*')"
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
  # Fallback only: WScript.Shell cannot set an AppUserModelID, so the app rewrites this same .lnk (AUMID-bearing) on first launch.
  $lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "hivemind.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $AppHome "hivemind.exe"
  $s.WorkingDirectory = $AppHome
  $s.Description = "Infinite canvas for Claude Code & AI coding agents"
  $s.Save()
  Ok "Start Menu shortcut"
}

# Only a WINDOWED process counts as "the app is open": the pty daemon runs as hivemind.exe too,
# detached, and outlives the window.
function Test-AppRunning {
  [bool](Get-Process -Name hivemind -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
}

# Unpack the release zip into a folder of its own, app-<version>, beside the open app's: Windows
# will not overwrite or delete a running exe, so each version keeps its own folder, the launcher
# and the Start Menu shortcut start the newest, and an old one goes once nothing runs from it.
function Install-App ($zip, $name) {
  $dest = Join-Path $AppDir $name
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
  $script:AppHome = $dest
  Remove-UnusedApps
}

# Every app folder but the current one, the one installed before it (to go back to) and any a
# process runs from.
function Remove-UnusedApps {
  $keep = @($AppHome)
  if (Test-Path $VersionFile) { $keep += Join-Path $AppDir "app-$((Get-Content $VersionFile -Raw).Trim().TrimStart('v'))" }
  $running = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ })
  Get-ChildItem -Path $AppDir -Directory | Where-Object { ($_.Name -eq "app" -or $_.Name -like "app-*") -and $keep -notcontains $_.FullName } | ForEach-Object {
    $dir = $_.FullName + [IO.Path]::DirectorySeparatorChar
    if (-not ($running | Where-Object { $_.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })) {
      Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    }
  }
}

# A running exe (hive-net serving, a hive command) cannot be overwritten or deleted, but it can be
# renamed: it is moved aside for the process still running it, and goes on a later install.
function Replace-Exe ($new, $dest) {
  Get-ChildItem -Path (Split-Path $dest) -Filter "$(Split-Path $dest -Leaf).old.*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  if (Test-Path $dest) {
    try { Remove-Item -Force $dest } catch { Move-Item -Force $dest "$dest.old.$PID" }
  }
  Move-Item -Force $new $dest
}

# ---------------------------------------------------------------- prebuilt ---
# The API SDKs, for programs that drive a workspace: `npm install <AppDir>\sdk\hivemind-api.tgz`
# and `pip install <AppDir>\sdk\python`. A release without them installs the rest.
function Install-Sdk ($tag) {
  $base = "https://github.com/$Repo/releases/download/$tag"
  $dir = Join-Path $AppDir "sdk"
  $tmp = Join-Path $AppDir "sdk.$PID.new"
  try {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Join-Path $tmp "python") | Out-Null
    Invoke-WebRequest -Uri "$base/hivemind-api.tgz" -OutFile (Join-Path $tmp "hivemind-api.tgz") -UseBasicParsing
    Invoke-WebRequest -Uri "$base/hivemind-api-python.tar.gz" -OutFile (Join-Path $tmp "python.tar.gz") -UseBasicParsing
    tar -xzf (Join-Path $tmp "python.tar.gz") -C (Join-Path $tmp "python") --strip-components=1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $tmp "python\pyproject.toml"))) { throw "the Python SDK did not unpack" }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Move-Item -Force (Join-Path $tmp "hivemind-api.tgz") (Join-Path $dir "hivemind-api.tgz")
    Remove-Item -Recurse -Force (Join-Path $dir "python") -ErrorAction SilentlyContinue
    Move-Item -Force (Join-Path $tmp "python") (Join-Path $dir "python")
    Ok "API SDKs in ${dir}: npm install $(Join-Path $dir 'hivemind-api.tgz') - pip install $(Join-Path $dir 'python')"
  } catch {
    Warn "the API SDKs are not in $tag; the rest is installed without them"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Install-Prebuilt {
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

  $tag = $Version
  if (-not $tag) {
    Say "resolving latest $Channel release of $Repo"
    if ($Channel -eq "nightly") {
      try {
        $url = "https://api.github.com/repos/$Repo/releases?per_page=30&nocache=" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $nightly = Invoke-RestMethod $url -Headers @{ "Cache-Control" = "no-cache" } |
          Where-Object { $_.prerelease -and $_.tag_name -match '^nightly-[0-9]{8}-[0-9]+$' } | Select-Object -First 1
        if (-not $nightly) { Die "no nightly release found for $Repo" }
        $tag = $nightly.tag_name
      } catch { Die "could not resolve a nightly release of $Repo - check your network" }
    } else {
      # Where GitHub redirects releases/latest: not the api, so no 60-requests-an-hour limit
      # shared with everyone behind this address.
      try {
        $r = Invoke-WebRequest "https://github.com/$Repo/releases/latest" -MaximumRedirection 5 -UseBasicParsing
        if ($r.BaseResponse.ResponseUri) { $final = $r.BaseResponse.ResponseUri.AbsoluteUri } else { $final = $r.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
        if ($final -match '/releases/tag/(v?[0-9][^/?#]*)') { $tag = $Matches[1] }
      } catch { }
      if (-not $tag) {
        try {
          # A cache answers with the release before this one for its first minute (the api sends
          # max-age=60), so ask for an answer nobody has stored.
          $url = "https://api.github.com/repos/$Repo/releases/latest?nocache=" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
          $tag = (Invoke-RestMethod $url -Headers @{ "Cache-Control" = "no-cache" }).tag_name
        } catch {
          if ($_.Exception.Response.StatusCode.value__ -in 403,429) {
            Die "GitHub is rate-limiting this address (60 api requests an hour, shared). Wait, or install a known version: -Version vX.Y.Z"
          }
          Die "could not resolve the latest release of $Repo - check your network"
        }
      }
    }
  }
  if (-not $tag) { Die "no published releases for $Repo. Use -Dev to build from source." }
  Say "target version: $tag"

  $bare = $tag.TrimStart("v")
  $script:AppHome = Join-Path $AppDir "app-$bare"
  if ((Test-Path $VersionFile) -and ((Get-Content $VersionFile -Raw).Trim() -eq $tag)) {
    if (Test-Path (Join-Path $AppHome "hivemind.exe")) {
      Write-Launcher; Write-Uninstaller; Add-StartMenuShortcut; Add-ToUserPath
      Ok "launcher up to date"
    }
    Ok "already on $tag - nothing to do"
    return
  }

  $cliUrl = "https://github.com/$Repo/releases/download/$tag/hive-windows-x64.exe"
  $netUrl = "https://github.com/$Repo/releases/download/$tag/hive-net-windows-x64.exe"
  $appAsset = if ($tag -match '^nightly-') { "hivemind-windows-x64.zip" } else { "hivemind-$bare-x64-win.zip" }
  $appUrl = "https://github.com/$Repo/releases/download/$tag/$appAsset"
  $tmpCli = Join-Path $AppDir "hive.$PID.new"
  $tmpNet = Join-Path $AppDir "hive-net.$PID.new"
  $tmpApp = Join-Path $AppDir "app.$PID.zip"

  try {
    Say "downloading hive CLI"
    # A PID-unique temp: a fixed name races a concurrent upgrade.
    Invoke-WebRequest -Uri $cliUrl -OutFile $tmpCli -UseBasicParsing
    Replace-Exe $tmpCli (Join-Path $BinDir "hive.exe")
    Ok "installed $(Join-Path $BinDir 'hive.exe')"

    # hive-net, beside hive: this machine's device on the network (R10). Its release build is
    # allowed to fail on its own, so a release without it installs the rest.
    try {
      Invoke-WebRequest -Uri $netUrl -OutFile $tmpNet -UseBasicParsing
      Replace-Exe $tmpNet (Join-Path $BinDir "hive-net.exe")
      Ok "installed $(Join-Path $BinDir 'hive-net.exe')"
    } catch {
      Warn "hive-net is not in $tag; the rest is installed without it"
    }
    Install-Sdk $tag

    if (Test-Path (Join-Path $AppHome "hivemind.exe")) {
      Ok "the app of $tag is here already"
      Remove-UnusedApps
    } else {
      Say "downloading desktop app"
      Invoke-WebRequest -Uri $appUrl -OutFile $tmpApp -UseBasicParsing
      Say "unpacking"
      Install-App $tmpApp "app-$bare"
    }
    Write-Launcher; Write-Uninstaller; Add-StartMenuShortcut; Add-ToUserPath
    # Stamped only once the app is in place: a failed download throws, so a re-run tries again.
    Set-Content -Path $VersionFile -Value $tag
    if (Test-AppRunning) { Ok "downloaded $tag - restart hivemind to finish" } else { Ok "installed $tag" }
  } catch {
    Die "install failed: $($_.Exception.Message)"
  } finally {
    Remove-Item -Force $tmpCli, $tmpNet, $tmpApp -ErrorAction SilentlyContinue
  }
}

# --------------------------------------------------------------------- dev ---
function Install-Dev {
  foreach ($c in @("git", "node", "pnpm", "bun")) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Die "$c missing - install it first (node >= 22, pnpm >= 12, bun >= 1.1)" }
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
    $name = "dev-$(Get-Date -Format yyyyMMddHHmmss)"
    Install-App $zip.FullName "app-$name"
    Write-Launcher; Write-Uninstaller; Add-StartMenuShortcut; Add-ToUserPath
    Set-Content -Path $VersionFile -Value $name
    Ok "dev install ready"
  } finally { Pop-Location }
}

# Test seam, as install.sh has: `$env:HIVEMIND_LIB_ONLY = "1"; . ./install.ps1` stops here with every
# function defined, so the Windows release job drives the real install helpers.
if ($env:HIVEMIND_LIB_ONLY -eq "1") { return }

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
