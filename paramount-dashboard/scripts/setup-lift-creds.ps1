# setup-lift-creds.ps1 -- one-time credential capture for the LIFT REST API probe.
# Prompts hidden (password never shows on screen, never lands in shell history)
# and writes paramount-dashboard\.env.liftapi (gitignored).
# Run:  powershell -ExecutionPolicy Bypass -File paramount-dashboard\scripts\setup-lift-creds.ps1

$envPath = Join-Path $PSScriptRoot "..\.env.liftapi"

Write-Host "LIFT API credential setup -- values write to .env.liftapi (gitignored)" -ForegroundColor Cyan

$user = Read-Host "LIFT username (the P Webster API account)"
$secure = Read-Host "LIFT password" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$pass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$company = Read-Host "COMPANY_ID (press Enter for 1162)"
if ([string]::IsNullOrWhiteSpace($company)) { $company = "1162" }

$base = Read-Host "API base (press Enter for QA1 sandbox)"
if ([string]::IsNullOrWhiteSpace($base)) { $base = "https://bny-qa1.lifterp.com/ords/api/liftqa1/erp" }

$content = @(
  "LIFT_API_BASE=$base"
  "LIFT_USER=$user"
  "LIFT_PASS=$pass"
  "LIFT_COMPANY_ID=$company"
) -join "`n"

Set-Content -Path $envPath -Value $content -Encoding UTF8
Write-Host ""
Write-Host "Written to $envPath" -ForegroundColor Green
Write-Host "Base URL: $base"
Write-Host "Now run:  node paramount-dashboard\scripts\lift-api-probe.mjs" -ForegroundColor Cyan
