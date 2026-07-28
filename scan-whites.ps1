# ============================================================================
# scan-whites.ps1  --  READ ONLY. Finds every remaining light-on-dark hazard.
# ============================================================================
# Run:  powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\scan-whites.ps1
# Writes: C:\Dev\updates-paramount\white-scan.txt   (nothing else is touched)
#
# Five classes, all of which have actually bitten this repo:
#   1  hardcoded white background in a .module.css
#   2  inline background '#fff' / 'white' in JSX (CSS variables cannot reach)
#   3  a light hex assigned to a VARIABLE first, so no background: search finds it
#   4  C.ink used as a BACKGROUND (it is near-white now; text only)
#   5  var(--x, #lightfallback) where --x may never be defined
# ============================================================================

$root = "C:\Dev\updates-paramount\paramount-dashboard\src"
$out  = "C:\Dev\updates-paramount\white-scan.txt"
$lines = New-Object System.Collections.Generic.List[string]

function Add-Section($title) {
  $lines.Add("")
  $lines.Add("=" * 78)
  $lines.Add($title)
  $lines.Add("=" * 78)
}

function Scan($title, $include, $pattern) {
  Add-Section $title
  $hits = 0
  Get-ChildItem -Path $root -Recurse -Include $include -File | ForEach-Object {
    $f = $_
    $n = 0
    foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
      $n++
      if ($line -match $pattern) {
        $rel = $f.FullName.Replace($root, "src")
        $txt = $line.Trim()
        if ($txt.Length -gt 150) { $txt = $txt.Substring(0,150) + " ..." }
        $lines.Add(("{0}:{1}  {2}" -f $rel, $n, $txt))
        $hits++
      }
    }
  }
  $lines.Add("")
  $lines.Add("-- $hits hit(s)")
}

$lines.Add("WHITE / CONTRAST SCAN")
$lines.Add("generated $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
$lines.Add("root: $root")

Scan "CLASS 1 - white background in stylesheets" @("*.css") `
     'background(-color)?\s*:\s*(#fff\b|#ffffff\b|white\b|rgb\(\s*255\s*,\s*255\s*,\s*255)'

Scan "CLASS 2 - inline white background in JSX" @("*.jsx","*.js") `
     "background(Color)?\s*:\s*'(#fff|#ffffff|white)'"

Scan "CLASS 3 - light hex assigned to a variable (the invisible one)" @("*.jsx","*.js") `
     "(const|let|var)\s+\w*[Bb]g\w*\s*=.*('#fff'|'#ffffff'|'white')"

Scan "CLASS 4 - C.ink used as a BACKGROUND (text-only token)" @("*.jsx","*.js") `
     'background(Color)?\s*:\s*[^,;]*C\.ink\b'

Scan "CLASS 5 - var(--x, #lightfallback) - confirm --x is defined in tokens.css" @("*.css","*.jsx","*.js") `
     'var\(\s*--[a-z0-9-]+\s*,\s*#[EeFfDdCc][0-9A-Fa-f]{5}'

# --- duplicate global form-control rules ------------------------------------
# The login-screen bug was a SECOND input rule further down index.css quietly
# re-declaring background: white. If this count is ever above 1, read them all
# and check which one wins.
Add-Section "GLOBAL FORM-CONTROL RULES in index.css (expect exactly 2, both dark)"
$idx = Join-Path $root "index.css"
$n = 0
foreach ($line in [System.IO.File]::ReadAllLines($idx)) {
  $n++
  if ($line -match '^\s*(input|select|textarea)[^{]*\{') { $lines.Add(("index.css:{0}  {1}" -f $n, $line.Trim())) }
}

Add-Section "TOKENS DEFINED IN tokens.css (cross-check against CLASS 5)"
$tok = Join-Path $root "styles\tokens.css"
foreach ($line in [System.IO.File]::ReadAllLines($tok)) {
  if ($line -match '^\s*(--[a-z0-9-]+)\s*:') { $lines.Add($Matches[1]) }
}

[System.IO.File]::WriteAllLines($out, $lines)
Write-Host ""
Write-Host "Done. Wrote $out"
Write-Host ""
Get-Content $out | Select-Object -First 60
