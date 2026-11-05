# Watches a Windows printer queue and prints one JSON object per line to stdout:
#   {"ev":"added","id":12,"doc":"...","status":"Spooling","t":"..."}   job first seen in the queue
#   {"ev":"status","id":12,"doc":"...","status":"Printing","t":"..."}  its status changed
#   {"ev":"done","id":12,"doc":"...","t":"..."}                        job left the queue (finished printing)
#   {"ev":"hb","t":"..."}                                              heartbeat every ~5 s
#   {"ev":"error","msg":"..."}                                         Get-PrintJob failed (printer missing, etc.)
# Used by fortune/fortune-main.js. Read-only: never touches the queue.
#
# Usage: job-watcher.ps1 -Printer "<queue name>" [-IntervalMs 250]

param(
    [Parameter(Mandatory=$true)][string]$Printer,
    [int]$IntervalMs = 250
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Emit($obj) {
    $obj['t'] = (Get-Date).ToString('o')
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

$known = @{}      # id -> @{ doc; status }
$lastBeat = Get-Date '2000-01-01'
$lastError = ''

while ($true) {
    try {
        $jobs = @(Get-PrintJob -PrinterName $Printer)
        $lastError = ''
        $seen = @{}
        foreach ($j in $jobs) {
            $id = [int]$j.Id
            $seen[$id] = $true
            $status = [string]$j.JobStatus
            if (-not $known.ContainsKey($id)) {
                $known[$id] = @{ doc = [string]$j.DocumentName; status = $status }
                Emit @{ ev = 'added'; id = $id; doc = [string]$j.DocumentName; status = $status }
            } elseif ($known[$id].status -ne $status) {
                $known[$id].status = $status
                Emit @{ ev = 'status'; id = $id; doc = $known[$id].doc; status = $status }
            }
        }
        foreach ($id in @($known.Keys)) {
            if (-not $seen.ContainsKey($id)) {
                Emit @{ ev = 'done'; id = [int]$id; doc = $known[$id].doc }
                $known.Remove($id)
            }
        }
    } catch {
        $msg = $_.Exception.Message
        if ($msg -ne $lastError) { Emit @{ ev = 'error'; msg = $msg }; $lastError = $msg }
    }
    if (((Get-Date) - $lastBeat).TotalSeconds -ge 5) {
        Emit @{ ev = 'hb' }
        $lastBeat = Get-Date
    }
    Start-Sleep -Milliseconds $IntervalMs
}
