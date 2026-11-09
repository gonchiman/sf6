param(
  [Parameter(Mandatory)]
  [ValidateSet('prepare', 'save-data', 'save-result')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$branch = 'codex/legend-analysis-history'
$ref = "refs/heads/$branch"
$historyPath = Join-Path $env:GITHUB_WORKSPACE '.local/legend-analysis-daily/history'

if ($Action -eq 'prepare') {
  New-Item -ItemType Directory -Path $historyPath -Force | Out-Null
  Set-Location -LiteralPath $historyPath
  git init --initial-branch=$branch
  if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize Legend history' }
  git remote add origin https://github.com/gonchiman/sf6.git
  if ($LASTEXITCODE -ne 0) { throw 'Unable to set Legend history remote' }
  $existingRef = git ls-remote --heads origin $ref
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Legend history' }
  if ($existingRef) {
    git fetch --depth=1 origin $ref
    if ($LASTEXITCODE -ne 0) { throw 'Unable to load Legend history' }
    git reset --hard FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Unable to restore Legend history' }
  }
  exit 0
}

Set-Location -LiteralPath $historyPath
if ((git branch --show-current) -ne $branch) { throw 'Unexpected Legend history branch' }
git config user.name 'github-actions[bot]'
if ($LASTEXITCODE -ne 0) { throw 'Unable to configure Legend history author' }
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
if ($LASTEXITCODE -ne 0) { throw 'Unable to configure Legend history author' }
if ($Action -eq 'save-data') {
  git add -- public
  $message = 'Save daily Legend analysis'
} else {
  git add -- collection-history/legend-runs.json
  $message = 'Save Legend collection result'
}
if ($LASTEXITCODE -ne 0) { throw 'Unable to stage Legend history' }
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { exit 0 }
if ($LASTEXITCODE -ne 1) { throw 'Unable to compare Legend history' }
git commit -m $message
if ($LASTEXITCODE -ne 0) { throw 'Unable to commit Legend history' }
$credential = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("x-access-token:$env:GH_TOKEN"))
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
$env:GIT_CONFIG_VALUE_0 = "AUTHORIZATION: basic $credential"
try {
  git push origin "HEAD:$ref"
  if ($LASTEXITCODE -ne 0) { throw 'Unable to save Legend history' }
} finally {
  Remove-Item Env:GIT_CONFIG_COUNT, Env:GIT_CONFIG_KEY_0, Env:GIT_CONFIG_VALUE_0
  $credential = $null
}
