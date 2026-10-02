[CmdletBinding()]
param(
    [Alias("d")]
    [switch]$DebugMode,

    [Alias("o")]
    [switch]$Overview,

    [Alias("h")]
    [switch]$History,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TaskArgs
)

# Directory where the caller ran the command
$callerDir = (Get-Location).ProviderPath

# Directory where agent.ps1 and code-agent source reside
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Ensure dependencies exist
if (-not (Test-Path "$scriptDir\node_modules")) {
    Write-Host "[Installing dependencies in $scriptDir...]" -ForegroundColor Yellow
    Push-Location $scriptDir
    try {
        npm install
    }
    finally {
        Pop-Location
    }
}

# Detect debug mode from -d, -DebugMode, -Debug common parameter, or from TaskArgs
$isDebug = $DebugMode.IsPresent -or $PSBoundParameters.ContainsKey("Debug") -or ($TaskArgs -contains "-d") -or ($TaskArgs -contains "--debug")

# Filter out flags from TaskArgs so they are not treated as part of the task prompt
$filteredTaskArgs = @($TaskArgs | Where-Object { 
    $_ -ne "-d" -and $_ -ne "--debug" -and 
    $_ -ne "-o" -and $_ -ne "--overview" -and 
    $_ -ne "-h" -and $_ -ne "--history" 
})

# Locate tsx CLI directly to avoid npx.cmd batch-file argument truncation on Windows
$tsxCli = Join-Path $scriptDir "node_modules/tsx/dist/cli.mjs"
$hasLocalTsx = Test-Path $tsxCli

# Run the agent using node directly or tsx, passing the caller's directory as workspace
Push-Location $scriptDir
try {
    $cliScript = "src/cli.ts"
    $baseArgs = @("--workspace", $callerDir)
    if ($isDebug) {
        $baseArgs += "--debug"
    }

    if ($Overview.IsPresent -or ($TaskArgs -contains "-o") -or ($TaskArgs -contains "--overview")) {
        $baseArgs += "--overview"
    } elseif ($History.IsPresent -or ($TaskArgs -contains "-h") -or ($TaskArgs -contains "--history")) {
        $baseArgs += "--history"
    } elseif ($filteredTaskArgs -and $filteredTaskArgs.Count -gt 0) {
        $task = if ($filteredTaskArgs.Count -eq 1) { $filteredTaskArgs[0] } else { $filteredTaskArgs -join "`n" }
        $baseArgs += $task
    }

    if ($hasLocalTsx) {
        node $tsxCli $cliScript @baseArgs
    } else {
        npx tsx $cliScript @baseArgs
    }
}
finally {
    Pop-Location
}
