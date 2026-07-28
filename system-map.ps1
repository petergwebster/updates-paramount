# ============================================================================
# system-map.ps1  --  READ ONLY. Generates SYSTEM-MAP.md from the code itself.
# ============================================================================
# Run:  powershell -ExecutionPolicy Bypass -File C:\Dev\updates-paramount\system-map.ps1
# Writes: C:\Dev\updates-paramount\SYSTEM-MAP.md
#
# WHY THIS EXISTS (28 July 2026)
# Three times in two sessions the correct answer to "how do we get X in?" was
# "it is already in, and has been for days":
#   - a derivation was built around a LIFT field the source already provided
#   - an upload zone was proposed for a ShareFile feed that already ran daily
#   - the month-end decks were treated as something to be handed over, while
#     sitting readable in the local mirror the whole time
#
# None of that was missing information. It was all recorded. The failure was
# reasoning locally from whichever file was open instead of globally from what
# the system already has, and never paying the cost of checking because nothing
# answered "what exists?" in one read.
#
# So this is that one read. It is GENERATED, never hand-maintained, because a
# hand-maintained inventory drifts, and a drifted inventory is worse than none:
# it is confidently wrong, which is the exact failure mode this codebase keeps
# producing.
#
# It covers CODE and the LOCAL MIRROR. The database half is deliberately absent
# because this script holds no credentials; Claude reads that via the Supabase
# connector and the two together are the full picture.
#
# STYLE NOTE: every regex and every line containing a backtick is SINGLE quoted
# and concatenated. v1 mixed backtick-escaped quotes inside a double-quoted
# string, PowerShell lost the string boundary, and the parse errors surfaced
# 60 lines away from the actual mistake.
# ============================================================================

$repo   = 'C:\Dev\updates-paramount'
$src    = Join-Path $repo 'paramount-dashboard\src'
$fns    = Join-Path $repo 'paramount-dashboard\netlify\functions'
$mirror = 'C:\Dev\TriadBridge\pulled'
$out    = Join-Path $repo 'SYSTEM-MAP.md'

$L = New-Object System.Collections.Generic.List[string]
function W([string]$s) { [void]$L.Add($s) }

$TICK = [char]96   # backtick, for markdown inline code

W '# SYSTEM MAP'
W ''
W ('Generated ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') + ' by system-map.ps1. Do not edit by hand.')
W ''
W 'Read this BEFORE proposing any new intake, parser, table, upload path or data'
W 'source. If the thing you are about to build appears below, it already exists.'
W ''

# ---------------------------------------------------------------- functions --
W '## Inbound feeds (Netlify functions)'
W ''
if (Test-Path $fns) {
  foreach ($f in (Get-ChildItem $fns -Filter *.js -File | Sort-Object Name)) {
    $t = [System.IO.File]::ReadAllText($f.FullName)

    $sched = 'not scheduled'
    # LINE BY LINE, SKIPPING COMMENTS. A file-wide regex reported lift-wip-run.js
    # as hourly on the first run: the word appears in its header comment, which
    # explains that it is the MANUAL companion to the hourly sync. A map that
    # invents a schedule is worse than no map, because the whole point of this
    # file is that it can be trusted without re-checking the source.
    foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
      $ls = $line.TrimStart()
      if ($ls.StartsWith('//') -or $ls.StartsWith('*') -or $ls.StartsWith('/*')) { continue }
      if ($ls -match 'schedule\s*:\s*''([^'']+)''')   { $sched = 'cron ' + $Matches[1] + '  (in-code config export)'; break }
      if ($ls -match 'schedule\(\s*''([^'']+)''')     { $sched = 'cron ' + $Matches[1] + '  (schedule() wrapper)';   break }
    }

    $parsers = @()
    foreach ($m in [regex]::Matches($t, 'import\s*\{\s*([A-Za-z0-9_,\s]+)\}\s*from\s*''[^'']*lib/([A-Za-z0-9_]+)')) {
      $parsers += ($m.Groups[2].Value)
    }
    foreach ($m in [regex]::Matches($t, 'require\(\s*''[^'']*lib/([A-Za-z0-9_]+)')) {
      $parsers += $m.Groups[1].Value
    }

    $paths = @()
    foreach ($m in [regex]::Matches($t, '(?m)^const\s+([A-Z0-9_]*PATH)\s*=\s*\[([^\]]*)\]')) {
      $v = ($m.Groups[2].Value -replace '\s+', ' ').Trim()
      $paths += ($m.Groups[1].Value + ' = [' + $v + ']')
    }

    $tables = @()
    foreach ($m in [regex]::Matches($t, 'sb\(\s*[''"]([a-z0-9_]+)'))     { $tables += $m.Groups[1].Value }
    foreach ($m in [regex]::Matches($t, '\.from\(\s*[''"]([a-z0-9_]+)')) { $tables += $m.Groups[1].Value }
    $tables = @($tables | Sort-Object -Unique)

    W ('### ' + $f.Name)
    W ''
    W ('- schedule: ' + $sched)
    if ($paths.Count)   { W ('- source paths: ' + ($paths -join ' ; ')) }
    if ($parsers.Count) { W ('- parsers: ' + ((@($parsers | Sort-Object -Unique)) -join ', ')) }
    if ($tables.Count)  { W ('- touches tables: ' + ($tables -join ', ')) }
    W ''
  }
} else { W '_functions directory not found_'; W '' }

# ------------------------------------------------------------- collect code --
$allCode = @()
if (Test-Path $src) { $allCode += Get-ChildItem $src -Recurse -Include *.js,*.jsx -File }
if (Test-Path $fns) { $allCode += Get-ChildItem $fns -Filter *.js -File }

$textOf = @{}
foreach ($c in $allCode) { $textOf[$c.FullName] = [System.IO.File]::ReadAllText($c.FullName) }

# ------------------------------------------------------------------ parsers --
W '## Libraries in src/lib, and what imports them'
W ''
$libDir = Join-Path $src 'lib'
if (Test-Path $libDir) {
  # RECURSE. v1 listed src/lib/*.js only and silently missed src/lib/parsers/,
  # which holds five more. An inventory that quietly omits a directory is the
  # precise failure this file exists to prevent, so it walks the tree.
  foreach ($p in (Get-ChildItem $libDir -Filter *.js -File -Recurse | Sort-Object FullName)) {
    $rel  = $p.FullName.Substring($libDir.Length).TrimStart('\')
    $base = [System.IO.Path]::GetFileNameWithoutExtension($p.Name)
    $pat  = '/' + [regex]::Escape($base) + '(\.js)?[''"]'
    $users = @()
    foreach ($c in $allCode) {
      if ($c.FullName -eq $p.FullName) { continue }
      if ($textOf[$c.FullName] -match $pat) { $users += $c.Name }
    }
    if ($users.Count) { W ('- ' + $rel + '  <-  ' + ((@($users | Sort-Object -Unique)) -join ', ')) }
    else              { W ('- ' + $rel + '  <-  **NOTHING IMPORTS THIS**') }
  }
} else { W '_lib directory not found_' }
W ''

# --------------------------------------------------------------- components --
W '## Components nothing renders (dead code candidates)'
W ''
W 'LIMIT: this detects files that are NEVER IMPORTED. It does NOT detect a file'
W 'that is imported and whose exports are then unused - ProductionTab.jsx is the'
W 'known case, imported by App.jsx with all four of its exports unreferenced.'
W 'Absence from this list is not proof a component is live.'
W ''
$orphans = 0
$compDir = Join-Path $src 'components'
if (Test-Path $compDir) {
  foreach ($c in (Get-ChildItem $compDir -Filter *.jsx -File | Sort-Object Name)) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($c.Name)
    $tag  = '<' + [regex]::Escape($base) + '[\s/>]'
    $imp  = 'from\s*[''"][^''"]*/' + [regex]::Escape($base) + '[''"]'
    $used = $false
    foreach ($o in $allCode) {
      if ($o.FullName -eq $c.FullName) { continue }
      $ot = $textOf[$o.FullName]
      if ($ot -match $tag -or $ot -match $imp) { $used = $true; break }
    }
    if (-not $used) { W ('- ' + $c.Name); $orphans++ }
  }
}
if ($orphans -eq 0) { W '_none_' }
W ''

# ------------------------------------------------------------------- mirror --
W '## ShareFile mirror (C:\Dev\TriadBridge\pulled)'
W ''
W 'Full recursive mirror of S:\Shared Folders, refreshed by sf_pull.py.'
W 'If a file is missing here, re-run that script. Never chase the S: drive'
W 'letter - the Filesystem connector cannot resolve a session-mapped drive.'
W ''
W 'LAST SYNCED is the LOCAL download time, not ShareFile''s modified date, so it'
W 'says when sf_pull last wrote the file and NOT how current the data is. The'
W 'give-away on the first run: Parmount Monthly Results listed May as newest'
W 'while June sat in the same folder. For true source dates read'
W 'pulled\_sync_manifest.json, which sf_pull v2 keeps per file.'
W ''
W '| folder | files | newest file | last synced | feeds a table? |'
W '| --- | --- | --- | --- | --- |'
if (Test-Path $mirror) {
  # WHICH FOLDERS ACTUALLY REACH THE DATABASE. Being mirrored and being
  # ingested are different things, and conflating them is how "it's all
  # automated" and "payroll stops at 14 June" were both true at once. The
  # mirror is complete; only the folders named in a *_PATH constant inside a
  # Netlify function end up in a table.
  $ingested = @()
  $leaf = @()
  if (Test-Path $fns) {
    foreach ($f in (Get-ChildItem $fns -Filter *.js -File)) {
      $ft = [System.IO.File]::ReadAllText($f.FullName)
      foreach ($m in [regex]::Matches($ft, '(?m)^const\s+[A-Z0-9_]*PATH\s*=\s*\[([^\]]*)\]')) {
        $segs = @()
        foreach ($seg in [regex]::Matches($m.Groups[1].Value, '''([^'']+)''')) { $segs += $seg.Groups[1].Value }
        if ($segs.Count) { $ingested += $segs; $leaf += $segs[$segs.Count - 1] }
      }
    }
  }
  foreach ($d in (Get-ChildItem $mirror -Directory | Sort-Object Name)) {
    $files = @(Get-ChildItem $d.FullName -File -Recurse -ErrorAction SilentlyContinue)
    # "partial" matters. DASH WORK is the PARENT of the ingested Purchases
    # folder and also holds Payroll and People, which feed nothing. Marking the
    # parent "yes" would answer the payroll question wrongly - and that is the
    # single question this column exists to answer correctly.
    $fed = 'no - mirrored only'
    if ($leaf -contains $d.Name)         { $fed = 'yes' }
    elseif ($ingested -contains $d.Name) { $fed = 'partial - one subfolder only' }
    if ($files.Count -eq 0) { W ('| ' + $d.Name + ' | 0 | - | - | ' + $fed + ' |'); continue }
    $n  = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $nm = $n.Name
    if ($nm.Length -gt 46) { $nm = $nm.Substring(0,46) + '...' }
    W ('| ' + $d.Name + ' | ' + $files.Count + ' | ' + $nm + ' | ' + $n.LastWriteTime.ToString('yyyy-MM-dd') + ' | ' + $fed + ' |')
  }
} else { W '| _mirror not found_ | | | | |' }
W ''

# -------------------------------------------------------------------- notes --
W '## Facts that keep getting re-discovered'
W ''
W '- ShareFile is the source of record for every finance and reporting input,'
W '  and it is ALREADY AUTOMATED. sharefile-sync.js runs daily and ingests'
W "  Jen's weekly GP file, Abigail's Vena monthly close, and both inventory"
W '  workbooks. There is no manual upload step left to build.'
W '- The month-end decks are in the mirror and readable. June also exists as a'
W '  2.3 MB PDF, so the old 48 MB copy limit no longer applies.'
W '- LIFT exposes TWELVE reporting endpoints; lift-wip-sync.js uses two.'
W '  orders.csv has 45 columns and roughly 20 are mapped. Probe before assuming'
W '  a field is unavailable.'
W '- C:\Dev\TriadBridge is shared plumbing for this project and Triad both.'
W '  ARCHITECTURE.md there is the canonical cross-project file.'
W '- A wrong column name in a .select() is rejected WHOLE by PostgREST: the'
W '  screen renders zero, silently. Run check-selects.ps1 after touching data'
W '  loading. Four instances of this shipped before anyone noticed.'
W ''

[System.IO.File]::WriteAllLines($out, $L)
Write-Host ''
Write-Host ('Wrote ' + $out + '  (' + $L.Count + ' lines)')
Write-Host ''
Get-Content $out | Select-Object -First 45
