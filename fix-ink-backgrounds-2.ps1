# ============================================================================
# fix-ink-backgrounds-2.ps1
# Catches every remaining use of C.ink as a BACKGROUND, including the false
# branch of a ternary — which the first pass missed.
#
#   background: hi ? C.navy : C.ink      <-- this is what was left over
#   background: C.ink
#   backgroundColor: C.ink
#
# C.ink is near-white now, so any of those paints a white card. The text on it
# is usually also light, hence the unreadable Scheduler KPI cards and the
# "Refresh from Monday.com" button.
#
# The regex stops at a comma or brace, so `color: C.ink` later in the same
# style object is NOT touched — that one is correct.
#
# Run:  powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\fix-ink-backgrounds-2.ps1
# Undo: git checkout -- .
# ============================================================================

$src = 'C:\Dev\updates-paramount\paramount-dashboard\src'
Set-Location $src

$changed = 0
foreach ($f in (Get-ChildItem -Path $src -Recurse -Include *.jsx)) {
    $t = Get-Content $f.FullName -Raw
    $orig = $t

    # any C.ink appearing inside a background / backgroundColor value
    while ($t -match '(background(Color)?[^,}\r\n]*?)C\.ink\b') {
        $t = $t -replace '(background(Color)?[^,}\r\n]*?)C\.ink\b', '$1C.surface2'
    }

    if ($t -ne $orig) {
        Set-Content -Path $f.FullName -Value $t -NoNewline
        Write-Host ("updated " + $f.Name)
        $changed++
    }
}

Write-Host ""
Write-Host ("Files changed: " + $changed)
Write-Host "Remaining C.ink in a background position (want none):"
$left = Get-ChildItem -Path $src -Recurse -Include *.jsx |
        Select-String -Pattern "background(Color)?[^,}\r\n]*C\.ink\b"
if ($left) { $left | ForEach-Object { "  $($_.Filename):$($_.LineNumber)  $($_.Line.Trim())" } }
else { Write-Host "  none" }
