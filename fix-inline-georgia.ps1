# ============================================================================
# fix-inline-georgia.ps1
# Points inline `fontFamily: 'Georgia,serif'` in JSX at var(--font-display),
# so the display face follows the token like the stylesheets now do.
#
# WHY: the CSS-module sweep couldn't reach these — they're set in JSX style
# objects. They're why headings and figures still render serif after the
# token was switched to sans.
#
# NOTE: this also converts the Claude narrative bubbles in the schedulers,
# which used Georgia deliberately to read as prose. If you want those back,
# set fontFamily: 'Georgia,serif' on just those two lines afterward.
#
# Run:  powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\fix-inline-georgia.ps1
# Undo: git checkout -- .
# ============================================================================

$src = 'C:\Dev\updates-paramount\paramount-dashboard\src'
Set-Location $src

$changed = 0
foreach ($f in (Get-ChildItem -Path $src -Recurse -Include *.jsx)) {
    $t = Get-Content $f.FullName -Raw
    $orig = $t

    $t = $t -replace "'Georgia,\s*'?'?serif'",              "'var(--font-display)'"
    $t = $t -replace "'Georgia,\s*serif'",                  "'var(--font-display)'"
    $t = $t -replace '"Georgia,\s*serif"',                  "'var(--font-display)'"
    $t = $t -replace '"Georgia, ''Times New Roman'', serif"', "'var(--font-display)'"
    $t = $t -replace "'Georgia'",                           "'var(--font-display)'"

    if ($t -ne $orig) {
        Set-Content -Path $f.FullName -Value $t -NoNewline
        Write-Host ("updated " + $f.Name)
        $changed++
    }
}

Write-Host ""
Write-Host ("Files changed: " + $changed)
$left = (Get-ChildItem -Path $src -Recurse -Include *.jsx | Select-String -Pattern "Georgia").Count
Write-Host ("Georgia references left in JSX: " + $left + "   (want 0)")
