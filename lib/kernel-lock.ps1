param([string]$Name, [int]$OwnerPid, [string]$Control)
$ErrorActionPreference = 'Stop'
$mutex = $null
$held = $false
try {
    $owner = Get-Process -Id $OwnerPid -ErrorAction Stop
    $started = $owner.StartTime.ToUniversalTime().Ticks
    $mutex = [System.Threading.Mutex]::new($false, $Name)
    try { $held = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $held = $true }
    [System.IO.File]::WriteAllText("$Control.result", $(if ($held) { 'ready' } else { 'busy' }))
    while (-not [System.IO.File]::Exists("$Control.release")) {
        $current = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
        if (-not $current -or $current.StartTime.ToUniversalTime().Ticks -ne $started) { break }
        Start-Sleep -Milliseconds 100
    }
} catch {
    [System.IO.File]::WriteAllText("$Control.result", "error: $($_.Exception.Message)")
} finally {
    if ($held -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
    foreach ($suffix in @('.release', '.result')) {
        $file = "$Control$suffix"
        if ([System.IO.File]::Exists($file)) { [System.IO.File]::Delete($file) }
    }
}
