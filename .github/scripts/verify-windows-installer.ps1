param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$installer = Get-Item -LiteralPath $InstallerPath
$installDir = Join-Path $env:RUNNER_TEMP "OpenLimiterInstalled"
$install = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=$installDir") -WindowStyle Hidden -PassThru
if (-not $install.WaitForExit(120000)) {
  & "$env:SystemRoot/System32/taskkill.exe" /PID $install.Id /T /F | Out-Null
  throw "The Windows installer exceeded its two minute limit"
}
if ($install.ExitCode -ne 0) {
  throw "The Windows installer exited with code $($install.ExitCode)"
}

function Find-OpenLimiterApplication {
  $searchRoots = @(
    $installDir,
    (Join-Path $env:LOCALAPPDATA "OpenLimiter"),
    (Join-Path $env:LOCALAPPDATA "Programs/OpenLimiter"),
    (Join-Path $env:ProgramFiles "OpenLimiter")
  )
  if (${env:ProgramFiles(x86)}) {
    $searchRoots += Join-Path ${env:ProgramFiles(x86)} "OpenLimiter"
  }

  foreach ($root in $searchRoots) {
    if (Test-Path -LiteralPath $root) {
      $found = Get-ChildItem -LiteralPath $root -Recurse -Filter "OpenLimiter.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) {
        return $found
      }
    }
  }

  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($entry in Get-ItemProperty -Path $uninstallRoots -ErrorAction SilentlyContinue) {
    if ($entry.DisplayName -notlike "OpenLimiter*") {
      continue
    }
    if ($entry.DisplayIcon) {
      $iconPath = ($entry.DisplayIcon -replace ',[0-9]+$', '').Trim('"')
      if (Test-Path -LiteralPath $iconPath) {
        return (Get-Item -LiteralPath $iconPath)
      }
    }
    if ($entry.InstallLocation) {
      $installedPath = Join-Path $entry.InstallLocation "OpenLimiter.exe"
      if (Test-Path -LiteralPath $installedPath) {
        return (Get-Item -LiteralPath $installedPath)
      }
    }
  }
}

$application = $null
for ($attempt = 0; $attempt -lt 10 -and -not $application; $attempt++) {
  $application = Find-OpenLimiterApplication
  if (-not $application) {
    Start-Sleep -Seconds 1
  }
}
if (-not $application) {
  throw "The installed Windows application was not found"
}

$launched = Start-Process -FilePath $application.FullName -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 10
if ($launched.HasExited) {
  throw "The installed Windows application exited during its launch smoke test"
}
Stop-Process -Id $launched.Id -Force
Write-Output "Verified Windows install and launch: $($application.FullName)"
