# register-daily-triggers.ps1 — makes Peter's machine the PRIMARY clock for
# the daily jobs, with the Netlify crons demoted to backup. Run ONCE (or again
# any time — -Force re-registers cleanly):
#
#   powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\register-daily-triggers.ps1
#
# Why: the Netlify scheduler on this site has now failed three different ways
# (toml block never registers, ESM config export never fired, and on 8/1 a
# registered CJS daily tick silently skipped), while Task Scheduler has run
# the 7:30 render walk flawlessly. Every endpoint is idempotent, so both
# clocks firing is harmless; either one alone is enough.
#
# -StartWhenAvailable means a trigger missed while the laptop slept fires as
# soon as it wakes — a late run beats a skipped one.

$defs = @(
  @{ Name = 'Paramount Nightly Audit'; Time = '01:05';
     Url  = 'https://updates-paramount.netlify.app/.netlify/functions/audit-run' },
  @{ Name = 'Paramount Daily Digest';  Time = '06:35';
     Url  = 'https://updates-paramount.netlify.app/.netlify/functions/digest-run' },
  @{ Name = 'Paramount Finance Sync';  Time = '09:05';
     Url  = 'https://updates-paramount.netlify.app/.netlify/functions/sharefile-run' }
)

foreach ($d in $defs) {
  $args     = ('-s -m 300 -X POST "{0}" -H "Content-Type: application/json" -d "{{}}"' -f $d.Url)
  $action   = New-ScheduledTaskAction -Execute 'curl.exe' -Argument $args
  $trigger  = New-ScheduledTaskTrigger -Daily -At $d.Time
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $d.Name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host ("registered: {0}  daily at {1}  ->  {2}" -f $d.Name, $d.Time, $d.Url)
}

Write-Host ""
Write-Host "Done. Verify with:  Get-ScheduledTask -TaskName 'Paramount*' | Format-Table TaskName, State"
Write-Host "Test one now with:  Start-ScheduledTask -TaskName 'Paramount Daily Digest'"
