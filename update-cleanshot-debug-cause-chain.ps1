<#
.SYNOPSIS
    Patches backend/app/services/scan.py to log the underlying httpx error
    chain (cause_chain) for failed providers, then optionally rebuilds and
    redeploys the Cloud Run worker.

.DESCRIPTION
    The OpenAI/Anthropic SDK errors come through as
    "APIConnectionError: Connection error." with no detail. This patch
    walks the exception's __cause__ / __context__ chain and includes
    the underlying error types and messages in the job result, exposing
    the actual root cause (DNS / TCP RST / TLS / etc).

.PARAMETER Deploy
    If set, runs docker compose build, docker tag/push, and
    gcloud beta run worker-pools update after applying the patch.

.PARAMETER ImageTag
    Image tag to push under. Defaults to "debug-cause".
#>

[CmdletBinding()]
param(
    [switch]$Deploy,
    [string]$ImageTag = "debug-cause"
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Locate scan.py
# ---------------------------------------------------------------------------
$candidates = @(
    "backend\app\services\scan.py",
    "app\services\scan.py"
)
$scanPath = $null
foreach ($c in $candidates) {
    if (Test-Path $c) { $scanPath = (Resolve-Path $c).Path; break }
}
if (-not $scanPath) {
    throw "Could not find scan.py. Run from repo root or backend/ dir."
}
Write-Host "Found scan.py at: $scanPath" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Decode OLD/NEW from base64 (avoids PS quoting hazards)
# ---------------------------------------------------------------------------
$oldB64 = "ICAgIGZvciBwcm92aWRlciwgcmVzdWx0IGluIHppcChwcm92aWRlcl9vcmRlciwgcmF3KToKICAgICAgICBpZiBpc2luc3RhbmNlKHJlc3VsdCwgQmFzZUV4Y2VwdGlvbik6CiAgICAgICAgICAgIGVycl9tc2cgPSBmInt0eXBlKHJlc3VsdCkuX19uYW1lX199OiB7cmVzdWx0fSIKICAgICAgICAgICAgd2FybmluZ3MuYXBwZW5kKGYie3Byb3ZpZGVyfSBmYWlsZWQ6IHtlcnJfbXNnfSIpCiAgICAgICAgICAgIGluZGl2aWR1YWxbcHJvdmlkZXJdID0geyJlcnJvciI6IGVycl9tc2d9CiAgICAgICAgICAgIGxvZ2dlci53YXJuaW5nKCJQcm92aWRlciBmYWlsZWQiLCBwcm92aWRlcj1wcm92aWRlciwgZXJyb3I9ZXJyX21zZykK"
$newB64 = "ICAgIGZvciBwcm92aWRlciwgcmVzdWx0IGluIHppcChwcm92aWRlcl9vcmRlciwgcmF3KToKICAgICAgICBpZiBpc2luc3RhbmNlKHJlc3VsdCwgQmFzZUV4Y2VwdGlvbik6CiAgICAgICAgICAgIGVycl9tc2cgPSBmInt0eXBlKHJlc3VsdCkuX19uYW1lX199OiB7cmVzdWx0fSIKICAgICAgICAgICAgY2F1c2VfY2hhaW4gPSBbXQogICAgICAgICAgICBjdXIgPSByZXN1bHQuX19jYXVzZV9fIG9yIHJlc3VsdC5fX2NvbnRleHRfXwogICAgICAgICAgICB3aGlsZSBjdXIgaXMgbm90IE5vbmUgYW5kIGxlbihjYXVzZV9jaGFpbikgPCA1OgogICAgICAgICAgICAgICAgY2F1c2VfY2hhaW4uYXBwZW5kKGYie3R5cGUoY3VyKS5fX25hbWVfX306IHtjdXJ9IikKICAgICAgICAgICAgICAgIGN1ciA9IGN1ci5fX2NhdXNlX18gb3IgY3VyLl9fY29udGV4dF9fCiAgICAgICAgICAgIHdhcm5pbmdzLmFwcGVuZChmIntwcm92aWRlcn0gZmFpbGVkOiB7ZXJyX21zZ30iKQogICAgICAgICAgICBpbmRpdmlkdWFsW3Byb3ZpZGVyXSA9IHsiZXJyb3IiOiBlcnJfbXNnLCAiY2F1c2VfY2hhaW4iOiBjYXVzZV9jaGFpbn0KICAgICAgICAgICAgbG9nZ2VyLndhcm5pbmcoCiAgICAgICAgICAgICAgICAiUHJvdmlkZXIgZmFpbGVkIiwKICAgICAgICAgICAgICAgIHByb3ZpZGVyPXByb3ZpZGVyLAogICAgICAgICAgICAgICAgZXJyb3I9ZXJyX21zZywKICAgICAgICAgICAgICAgIGNhdXNlX2NoYWluPWNhdXNlX2NoYWluLAogICAgICAgICAgICApCg=="
$old = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($oldB64))
$new = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($newB64))

# ---------------------------------------------------------------------------
# Read, patch, write
# ---------------------------------------------------------------------------
$content = [System.IO.File]::ReadAllText($scanPath)

if ($content.Contains("cause_chain")) {
    Write-Host "[INFO] scan.py already contains cause_chain - skipping patch" -ForegroundColor Yellow
} elseif ($content.Contains($old)) {
    $patched = $content.Replace($old, $new)
    [System.IO.File]::WriteAllText($scanPath, $patched)
    Write-Host "[OK] Patched scan.py" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Could not find the expected error-handling block." -ForegroundColor Red
    Write-Host "Apply manually: see the chat for the str_replace pattern." -ForegroundColor Red
    throw "Patch target not found"
}

if (-not $Deploy) {
    Write-Host ""
    Write-Host "Patch applied. To rebuild and redeploy run:" -ForegroundColor Cyan
    Write-Host "  .\update-cleanshot-debug-cause-chain.ps1 -Deploy" -ForegroundColor White
    return
}

# ---------------------------------------------------------------------------
# Deploy: docker compose build -> tag -> push -> gcloud update
# ---------------------------------------------------------------------------
$backendDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $scanPath))
Write-Host ""
Write-Host "Building from: $backendDir" -ForegroundColor Cyan

Push-Location $backendDir
try {
    Write-Host ""
    Write-Host "[1/3] docker compose build" -ForegroundColor Cyan
    docker compose build
    if ($LASTEXITCODE -ne 0) { throw "docker compose build failed (exit $LASTEXITCODE)" }

    Write-Host ""
    Write-Host "[2/3] docker tag + push" -ForegroundColor Cyan
    $image = "us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/worker-image:$ImageTag"

    $localImage = $null
    foreach ($candidate in @("backend-worker:latest", "backend_worker:latest")) {
        $found = docker images --format "{{.Repository}}:{{.Tag}}" | Select-String -SimpleMatch $candidate
        if ($found) { $localImage = $candidate; break }
    }
    if (-not $localImage) {
        Write-Host "Could not locate built image. Available images:" -ForegroundColor Yellow
        docker images
        throw "Built image not found"
    }
    Write-Host "Local image: $localImage" -ForegroundColor Gray
    docker tag $localImage $image
    if ($LASTEXITCODE -ne 0) { throw "docker tag failed" }
    docker push $image
    if ($LASTEXITCODE -ne 0) { throw "docker push failed" }

    Write-Host ""
    Write-Host "[3/3] gcloud beta run worker-pools update" -ForegroundColor Cyan
    & gcloud beta run worker-pools update forklift-worker-image `
        --region=us-central1 `
        --image=$image
    if ($LASTEXITCODE -ne 0) { throw "gcloud update failed" }

    Write-Host ""
    Write-Host "[OK] Worker redeployed with cause_chain logging" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Wait ~30 seconds for new revision to receive traffic"
    Write-Host "  2. Run a scan from the frontend"
    Write-Host "  3. curl the resulting job_id"
    Write-Host "  4. Look at .individual.openai.cause_chain and .individual.anthropic.cause_chain"
} finally {
    Pop-Location
}
