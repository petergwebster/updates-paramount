# ============================================================================
# find-refs.ps1  --  READ ONLY. Repo-wide "is this actually used?" check.
# ============================================================================
# Run:  powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\find-refs.ps1
#
# Asserting a file is dead from three greps is how you delete something that
# turns out to be load-bearing. This checks the whole tree.
# ============================================================================

$root = "C:\Dev\updates-paramount\paramount-dashboard\src"

$terms = @(
  'ProductionTab',
  'FacilityDetail',
  'OperatorScorecard',
  'useProductionData',
  'generateLiveOpsPDF',
  'BNYTab',
  'PassaicTab',
  'ConsolidatedProductionSummary',
  'VITE_GOOGLE_SHEETS_API_KEY'
)

foreach ($t in $terms) {
  Write-Host ""
  Write-Host ("=" * 70)
  Write-Host $t
  Write-Host ("=" * 70)
  $found = $false
  Get-ChildItem -Path $root -Recurse -Include *.jsx,*.js,*.css -File | ForEach-Object {
    $f = $_
    $n = 0
    foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
      $n++
      if ($line -match [regex]::Escape($t)) {
        $rel = $f.FullName.Replace($root, "src")
        $txt = $line.Trim()
        if ($txt.Length -gt 120) { $txt = $txt.Substring(0,120) + " ..." }
        Write-Host ("  {0}:{1}  {2}" -f $rel, $n, $txt)
        $found = $true
      }
    }
  }
  if (-not $found) { Write-Host "  -- no references" }
}

Write-Host ""
Write-Host "Done."
