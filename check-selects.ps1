# ============================================================================
# check-selects.ps1  --  READ ONLY. Extracts every Supabase .from().select()
# in the app so the columns can be checked against the live schema.
# ============================================================================
# Run:  powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\check-selects.ps1
# Writes: C:\Dev\updates-paramount\select-audit.txt   -> paste it to Claude
#
# WHY THIS EXISTS (27 July 2026)
# Two screens were silently blank because they selected a column that does not
# exist:
#   OpsHome      sched_daily_ops_lines.work_date   (real column: day_of_week)
#   FinanceHome  financial_aging.kind              (real column: aging_type)
#
# PostgREST rejects the ENTIRE select when one column is wrong. `data` comes
# back null, the array becomes empty, and every total downstream reads zero —
# with no error on screen, no empty-state, and no way to tell "nothing happened
# yet" from "the query failed". Ops Home reported "Nothing recorded this week"
# on a week with 1,568 recorded yards.
#
# This is the worst failure mode we have: it is invisible, it is confident, and
# it looks exactly like a quiet week. Nothing in the code can catch it, because
# the column name is a string. It has to be checked against the database.
#
# ALSO REPORTED: .limit(n) over 1000. PostgREST caps responses at 1,000 rows
# SERVER-side, so .limit(5000) is not a fix — it returns exactly 1,000 and
# every sum reads short. Paginate with .range() instead.
# ============================================================================

$root = "C:\Dev\updates-paramount\paramount-dashboard\src"
$out  = "C:\Dev\updates-paramount\select-audit.txt"
$lines = New-Object System.Collections.Generic.List[string]

$lines.Add("SUPABASE SELECT AUDIT")
$lines.Add("generated $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
$lines.Add("")
$lines.Add("Cross-check each table/column pair against information_schema.columns.")
$lines.Add("")

# .from('table')  ... .select('cols')  — tolerant of newlines and chaining
$rx = [regex]"\.from\(\s*['""]([A-Za-z0-9_]+)['""]\s*\)\s*(?:\r|\n|\s)*\.select\(\s*['""]([^'""]*)['""]"

$pairs = @{}

Get-ChildItem -Path $root -Recurse -Include *.jsx,*.js -File | ForEach-Object {
  $f = $_
  $text = [System.IO.File]::ReadAllText($f.FullName)
  $rel  = $f.FullName.Replace($root, "src")
  foreach ($m in $rx.Matches($text)) {
    $tbl  = $m.Groups[1].Value
    $cols = $m.Groups[2].Value
    $line = ($text.Substring(0, $m.Index) -split "`n").Count
    $lines.Add(("{0}:{1}  {2}  <-  {3}" -f $rel, $line, $tbl, $cols))
    foreach ($c in ($cols -split ',')) {
      $c = $c.Trim()
      # skip *, embedded resources like other_table(...), and aliases
      if ($c -eq '' -or $c -eq '*' -or $c -match '[(:]') { continue }
      $pairs["$tbl|$c"] = $true
    }
  }
}

$lines.Add("")
$lines.Add("=" * 78)
$lines.Add("DISTINCT table/column PAIRS  (this is the list to verify)")
$lines.Add("=" * 78)
foreach ($k in ($pairs.Keys | Sort-Object)) {
  $p = $k -split '\|'
  $lines.Add(("  ('{0}','{1}')," -f $p[0], $p[1]))
}

$lines.Add("")
$lines.Add("=" * 78)
$lines.Add("ROW-CAP RISK  -  .limit(n) where n > 1000, or a bare fetch of many rows")
$lines.Add("=" * 78)
$capHits = 0
Get-ChildItem -Path $root -Recurse -Include *.jsx,*.js -File | ForEach-Object {
  $f = $_; $n = 0
  foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
    $n++
    if ($line -match '\.limit\(\s*(\d+)\s*\)') {
      if ([int]$Matches[1] -gt 1000) {
        $rel = $f.FullName.Replace($root, "src")
        $lines.Add(("  {0}:{1}  {2}" -f $rel, $n, $line.Trim()))
        $capHits++
      }
    }
  }
}
if ($capHits -eq 0) { $lines.Add("  -- none") }

[System.IO.File]::WriteAllLines($out, $lines)
Write-Host ""
Write-Host "Wrote $out"
Write-Host "Send the DISTINCT PAIRS block to Claude to verify against the schema."
