# Run the backend suite in Linux, including on Windows hosts that block psycopg DLLs.
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $repoRoot
try {
    & docker compose up -d --wait postgres
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the local PostgreSQL service.' }
    $postgresContainer = & docker compose ps -q postgres
    if ($LASTEXITCODE -ne 0 -or -not $postgresContainer) { throw 'PostgreSQL container not found.' }
    $details = & docker inspect $postgresContainer | ConvertFrom-Json
    $network = $details[0].NetworkSettings.Networks.PSObject.Properties.Name | Select-Object -First 1
    $dockerArguments = @(
        'run', '--rm', '--network', $network,
        '--mount', "type=bind,source=$repoRoot,target=/workspace,readonly",
        '--mount', 'type=volume,source=adaptai-pg-test-venv,target=/venv',
        '--mount', 'type=volume,source=adaptai-pg-uv-cache,target=/uv-cache',
        '-w', '/workspace',
        '-e', 'UV_PROJECT_ENVIRONMENT=/venv', '-e', 'UV_CACHE_DIR=/uv-cache',
        '-e', 'UV_LINK_MODE=copy',
        '-e', 'ADAPTAI_TEST_DATABASE_URL=postgresql://adaptai:adaptai@postgres:5432/adaptai',
        'ghcr.io/astral-sh/uv:python3.12-bookworm-slim',
        'uv', 'run', '--locked', 'python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'
    )
    & docker @dockerArguments
    $testExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $testExitCode
