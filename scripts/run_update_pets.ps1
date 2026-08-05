<#
PowerShell helper to run the update_pets.js script.
Prompts for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY securely.
Usage: .\scripts\run_update_pets.ps1
#>

Write-Host "This helper will run scripts/update_pets.js. It will prompt for credentials."

$SUPABASE_URL = Read-Host -Prompt 'Supabase URL (e.g. https://projectid.supabase.co)'
if ([string]::IsNullOrWhiteSpace($SUPABASE_URL)) { Write-Error 'Supabase URL is required'; exit 1 }

$secureKey = Read-Host -Prompt 'Service role key (input hidden)' -AsSecureString
if (-not $secureKey) { Write-Error 'Service role key is required'; exit 1 }

# Convert secure string to plain for this process only
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try { $SUPABASE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

$dryRunAnswer = Read-Host -Prompt 'Run in dry-run mode? (Y/n)'
$dryRun = $true
if ($dryRunAnswer -and $dryRunAnswer.ToLower().StartsWith('n')) { $dryRun = $false }

# Set environment variables only for this session
$env:SUPABASE_URL = $SUPABASE_URL
$env:SUPABASE_SERVICE_ROLE_KEY = $SUPABASE_KEY

if ($dryRun) {
  Write-Host 'Running dry-run...'
  node .\scripts\update_pets.js --dry-run
} else {
  Write-Host 'Applying updates (this will modify production data)!'
  $confirm = Read-Host -Prompt 'Type YES to proceed'
  if ($confirm -ne 'YES') { Write-Host 'Aborted by user.'; exit 0 }
  node .\scripts\update_pets.js
}

# Clear environment variables and sensitive variables from memory
Remove-Variable -Name SUPABASE_KEY -ErrorAction SilentlyContinue
Remove-Variable -Name secureKey -ErrorAction SilentlyContinue
Remove-Variable -Name ptr -ErrorAction SilentlyContinue
Remove-Variable -Name SUPABASE_URL -ErrorAction SilentlyContinue
Remove-Variable -Name dryRun -ErrorAction SilentlyContinue
$env:SUPABASE_URL = $null
$env:SUPABASE_SERVICE_ROLE_KEY = $null

Write-Host 'Finished. Report is saved under artifacts/ if any changes were proposed or applied.'
