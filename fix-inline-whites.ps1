# ============================================================================
# fix-inline-whites.ps1
# Replaces inline `background: '#fff'` (and 'white' / '#ffffff') in JSX with
# var(--surface), so inline-styled components follow the theme like everything
# else. React resolves CSS variables in inline styles, so no imports change.
#
# ONLY touches values inside a `background:` declaration. `color: '#fff'` on
# coloured pills and buttons is correct and is left alone.
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File fix-inline-whites.ps1
# Everything is git-tracked, so `git checkout -- .` undoes it all.
# ============================================================================

$src = 'C:\Dev\updates-paramount\paramount-dashboard\src'
Set-Location $src

$changed = 0
$files = Get-ChildItem -Path $src -Recurse -Include *.jsx

foreach ($f in $files) {
    $t = Get-Content $f.FullName -Raw
    $orig = $t

    # background: '#fff'  ->  background: 'var(--surface)'
    $t = $t -replace "(background\s*:\s*[^,}\r\n]*?)'#fff'",    '$1''var(--surface)'''
    $t = $t -replace "(background\s*:\s*[^,}\r\n]*?)'#FFF'",    '$1''var(--surface)'''
    $t = $t -replace "(background\s*:\s*[^,}\r\n]*?)'#ffffff'", '$1''var(--surface)'''
    $t = $t -replace "(background\s*:\s*[^,}\r\n]*?)'#FFFFFF'", '$1''var(--surface)'''
    $t = $t -replace "(background\s*:\s*[^,}\r\n]*?)'white'",   '$1''var(--surface)'''

    # ProductionTab carries its own light palette inline
    $t = $t -replace "'#FAF7F2'", "'var(--ink-5)'"
    $t = $t -replace "'#E8DDD0'", "'var(--border)'"

    if ($t -ne $orig) {
        Set-Content -Path $f.FullName -Value $t -NoNewline
        Write-Host ("updated " + $f.Name)
        $changed++
    }
}

Write-Host ""
Write-Host ("Files changed: " + $changed)

$remaining = (Get-ChildItem -Path $src -Recurse -Include *.jsx |
              Select-String -Pattern "background[^,}\r\n]*'#fff'").Count
$applied   = (Get-ChildItem -Path $src -Recurse -Include *.jsx |
              Select-String -Pattern "var\(--surface\)").Count

Write-Host ("Remaining inline white backgrounds: " + $remaining + "   (want 0)")
Write-Host ("var(--surface) references now:      " + $applied)
