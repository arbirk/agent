# CLM-compatible runner for Code Agent
# Designed to run in PowerShell Constrained Language Mode (CLM) without .NET reflection or external dependencies.
param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$Token,
    [switch]$d,
    [switch]$DebugMode,
    [switch]$o,
    [switch]$Overview,
    [switch]$History,
    [switch]$Help,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Task
)

$isHelp = $Help -or ($Task -contains "-h") -or ($Task -contains "--help") -or ($Task -contains "-?")

# Prompt for Bearer token unless token was provided via flag/pipeline or help flag is present
if (-not $isHelp) {
    if ($PSBoundParameters.ContainsKey('Token')) {
        $env:LLM_API_KEY = if ($Token) { $Token.Trim() } else { "" }
    } else {
        $enteredToken = Read-Host "Bearer token (press Enter to leave empty)"
        if ($enteredToken -and $enteredToken.Trim()) {
            $env:LLM_API_KEY = $enteredToken.Trim()
        } else {
            $env:LLM_API_KEY = ""
        }
    }
}

$callerDir = (Get-Location).Path
$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$cliPath = Join-Path $scriptDir "src\cli.js"

$cliArgs = @("--workspace", $callerDir)

if ($d -or $DebugMode) {
    $cliArgs += "-d"
}

if ($isHelp) {
    $cliArgs += "--help"
} elseif ($Overview -or $o -or ($Task -contains "-o") -or ($Task -contains "--overview")) {
    $cliArgs += "-o"
} elseif ($History -or ($Task -contains "--history")) {
    $cliArgs += "--history"
} elseif ($Task -and $Task.Count -gt 0) {
    $cliArgs += ($Task -join " ")
}

& node $cliPath @cliArgs
exit $LASTEXITCODE
