# ============================================================================
# fix-ink-backgrounds.ps1
# C.ink is the TEXT colour. Several components also used it as an ACTIVE-STATE
# BACKGROUND, which worked when ink was near-black. Now that it is near-white,
# those become unreadable light chips with light text — the selected site pill,
# the "Screen Print" / "Contract" section headers, active filter chips.
#
# Active states become the teal accent (C.navy) with white text, matching the
# destination toggle. Section headers become C.surface2, a lifted neutral.
#
# Run:  powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\fix-ink-backgrounds.ps1
# Undo: git checkout -- .
# ============================================================================

$src = 'C:\Dev\updates-paramount\paramount-dashboard\src'
Set-Location $src

$changed = 0
foreach ($f in (Get-ChildItem -Path $src -Recurse -Include *.jsx)) {
    $t = Get-Content $f.FullName -Raw
    $orig = $t

    # active ? C.ink : X   ->  active ? C.navy : X      (ternary active states)
    $t = $t -replace '(\?\s*)C\.ink(\s*:)', '$1C.navy$2'

    # background: C.ink    ->  background: C.surface2   (section headers, bars)
    $t = $t -replace '(background\s*:\s*)C\.ink\b',      '$1C.surface2'
    $t = $t -replace '(backgroundColor\s*:\s*)C\.ink\b', '$1C.surface2'

    # Text sitting on those chips was C.cream (dark) — now needs to be light.
    $t = $t -replace '(color\s*:\s*)active\s*\?\s*C\.cream(\s*:)', '$1active ? ''#fff''$2'

    if ($t -ne $orig) {
        Set-Content -Path $f.FullName -Value $t -NoNewline
        Write-Host ("updated " + $f.Name)
        $changed++
    }
}

Write-Host ""
Write-Host ("Files changed: " + $changed)
Write-Host "Remaining C.ink used as a background (should be 0):"
Get-ChildItem -Path $src -Recurse -Include *.jsx |
  Select-String -Pattern "background[^,}\r\n]*C\.ink\b" |
  ForEach-Object { "  $($_.Filename):$($_.LineNumber)  $($_.Line.Trim())" }
