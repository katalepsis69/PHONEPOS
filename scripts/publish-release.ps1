param(
    [string]$Version,
    [string]$Changelog,
    [switch]$NonInteractive,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

$packageJson = Join-Path $rootDir "package.json"
if (-not (Test-Path $packageJson)) {
    Write-Error "package.json not found at $packageJson"
}

$repo = "katalepsis69/PHONEPOS"

# 0. Authenticate FIRST. Version selection needs the published-release list
# (an aborted run must reuse its staged version, not skip ahead), and every
# run that used to die at auth left the tree already version-bumped.
$token = $env:GITHUB_TOKEN

if ([string]::IsNullOrWhiteSpace($token)) {
    $tempCredIn = Join-Path $env:TEMP "git_cred_in.txt"
    $tempCredOut = Join-Path $env:TEMP "git_cred_out.txt"
    $credOutput = $null
    try {
        [System.IO.File]::WriteAllText($tempCredIn, "protocol=https`nhost=github.com`nusername=katalepsis69`n`n", [System.Text.Encoding]::ASCII)
        $proc = Start-Process git -ArgumentList "credential fill" -NoNewWindow -PassThru -RedirectStandardInput $tempCredIn -RedirectStandardOutput $tempCredOut
        # Bounded: WaitForExit() with no timeout can hang a manual release forever.
        if (-not $proc.WaitForExit(30000)) {
            $proc.Kill()
            throw "git credential fill did not answer within 30s"
        }
        $credOutput = Get-Content $tempCredOut -Raw
    } catch {
        Write-Warning "Could not query Git Credential Manager: $_"
    } finally {
        # Always: a killed or throwing run used to leave a repo-write PAT at
        # rest in %TEMP% (git_cred_out.txt holds the password in plaintext).
        Remove-Item $tempCredIn, $tempCredOut -Force -ErrorAction SilentlyContinue
    }
    if ($credOutput -match "password=(.+)") {
        $token = $matches[1].Trim()
    }
}

if ([string]::IsNullOrWhiteSpace($token) -and -not $NonInteractive -and -not $DryRun -and [Environment]::UserInteractive) {
    Write-Host ""
    Write-Host "GitHub Personal Access Token not detected from Git Credential Manager." -ForegroundColor Yellow
    $promptToken = Read-Host "Enter GitHub Personal Access Token (or press Enter to cancel)"
    if (-not [string]::IsNullOrWhiteSpace($promptToken)) {
        $token = $promptToken.Trim()
    }
}

$headers = @{
    Authorization = "Bearer $token"
    "User-Agent"  = "TechPartsPOS-Publisher"
    Accept        = "application/vnd.github+json"
}

# GET /releases, normalized. Windows PowerShell 5.1's Invoke-RestMethod has been
# observed returning the release LIST as ONE transposed object (tag_name and
# draft each holding N values) instead of N objects. Every tag then failed the
# version parse, the published floor silently became 0.0.0, and the reuse rule
# fired on an already-published version. Raw text + ConvertFrom-Json plus a
# shape guard makes the list deterministic.
function Get-GithubReleases {
    $raw = Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers $headers -UseBasicParsing -ErrorAction Stop
    $list = @($raw.Content | ConvertFrom-Json)
    if ($list.Count -eq 1 -and $list[0].tag_name -is [array]) {
        $flat = for ($i = 0; $i -lt $list[0].tag_name.Count; $i++) {
            [pscustomobject]@{ tag_name = [string]$list[0].tag_name[$i]; draft = [bool]$list[0].draft[$i] }
        }
        return ,$flat
    }
    return ,$list
}

# 1. Version selection, IDEMPOTENT. The rule that permanently kills the
# version-skip bug: if package.json already sits ABOVE the highest PUBLISHED
# release, that version was staged by an earlier run that died before anything
# shipped (failed test, build, or upload). Reuse it. Only a version that
# actually shipped counts as spent; local tags and drafts do not.
function Convert-ToVersionObject([string]$v) {
    if ([string]::IsNullOrWhiteSpace($v)) { return [version]"0.0.0" }
    $clean = $v.TrimStart('v', 'V').Split('-')[0]
    $parts = $clean.Split('.')
    while ($parts.Length -lt 3) { $parts += "0" }
    try {
        return [version]($parts[0..2] -join '.')
    } catch {
        return [version]"0.0.0"
    }
}

$pkgVer = ""
try {
    $pkgContent = Get-Content $packageJson -Raw | ConvertFrom-Json
    $pkgVer = $pkgContent.version
} catch {}

# Highest PUBLISHED release on GitHub. Without a token (DryRun without auth)
# the local tag list is the best available approximation and is labeled as such.
$publishedMax = [version]"0.0.0"
$releaseList = $null
if (-not [string]::IsNullOrWhiteSpace($token)) {
    try {
        $releaseList = Get-GithubReleases
        foreach ($r in $releaseList) {
            if ($r.draft) { continue }
            $v = Convert-ToVersionObject $r.tag_name
            if ($v -gt $publishedMax) { $publishedMax = $v }
        }
    } catch {
        Write-Warning "Could not list GitHub releases ($($_.Exception.Message)); falling back to local tags."
        $releaseList = $null
    }
}
if (-not $releaseList) {
    try {
        $tagOutput = git tag --sort=-v:refname 2>$null
        if ($tagOutput) { $publishedMax = Convert-ToVersionObject ($tagOutput | Select-Object -First 1) }
    } catch {}
}

$latestTag = ""
try {
    $tagOutput = git tag --sort=-v:refname 2>$null
    if ($tagOutput) { $latestTag = ($tagOutput | Select-Object -First 1) }
} catch {}

$vPkg = Convert-ToVersionObject $pkgVer

function Get-NextVersion([string]$current, [string]$bump) {
    $clean = $current.TrimStart('v', 'V')
    $parts = $clean.Split('.')
    [int]$major = if ($parts.Length -gt 0) { [int]$parts[0] } else { 1 }
    [int]$minor = if ($parts.Length -gt 1) { [int]$parts[1] } else { 0 }
    [int]$patch = if ($parts.Length -gt 2) { [int]$parts[2] } else { 0 }

    switch ($bump.ToLowerInvariant()) {
        "major" { return "$($major + 1).0" }
        "minor" {
            if ($parts.Length -le 2) { return "$major.$($minor + 1)" }
            return "$major.$($minor + 1).0"
        }
        "patch" {
            # A two-part base has no patch component yet: the first patch of
            # that line is x.y.1, not a disguised minor bump.
            if ($parts.Length -le 2) { return "$major.$minor.1" }
            return "$major.$minor.$($patch + 1)"
        }
        default {
            if ($bump -match '^\d+(\.\d+)*$') { return $bump.TrimStart('v', 'V') }
            if ($parts.Length -le 2) { return "$major.$($minor + 1)" }
            return "$major.$minor.$($patch + 1)"
        }
    }
}

if ($vPkg -gt $publishedMax) {
    $cleanVer = $pkgVer
    Write-Host "Reusing staged version $cleanVer (nothing was ever published under it; an earlier run stopped before shipping)." -ForegroundColor Yellow
} else {
    $baseVer = if ($vPkg -ge $publishedMax) { $pkgVer } else { $publishedMax.ToString() }
    $cleanVer = Get-NextVersion $baseVer "minor"
}

$tag = "v$cleanVer"

# Interactive prompt if running manually without parameters
if ([string]::IsNullOrWhiteSpace($Version) -and -not $NonInteractive -and -not $DryRun -and [Environment]::UserInteractive) {
    $entry = Read-Host "Publish version (Enter = $cleanVer, or type custom like $cleanVer)"
    if (-not [string]::IsNullOrWhiteSpace($entry)) {
        $cleanVer = Get-NextVersion $cleanVer $entry.Trim()
        $tag = "v$cleanVer"
    }

    if ([string]::IsNullOrWhiteSpace($Changelog)) {
        $noteEntry = Read-Host "Optional custom release note (or press Enter to auto-generate)"
        if (-not [string]::IsNullOrWhiteSpace($noteEntry)) {
            $Changelog = $noteEntry.Trim()
        }
    }
}

# Plain-English release notes generator for TechParts POS
function Get-DefaultReleaseNotes([string]$relTag) {
    $tagStr = if ($relTag.StartsWith('v')) { $relTag } else { "v$relTag" }
    return @"
# What is New in TechParts POS ($tagStr)

Here is a summary of features and improvements in this release, written for shop owners and cashiers.

### Highlights in this update:
- Simplified Excel and CSV parts import with automatic markup calculation from cost.
- Added friendly bilingual micro-hints (English and Tagalog) throughout counter and screens.
- Added fast counter shortcuts for checkout, customer search, price tiers, and claim stubs.
- System stability, thermal receipt printing, and automated daily backup improvements.

---

### 1. Simple Spreadsheet Import (Excel & CSV)
Import your phone parts catalog in seconds without having to manually match columns.

### 2. Helpful Tips Across Counter & Screens (Bilingual)
Friendly explanations across the workstation so you and your staff always know what every button and feature does.

### 3. Fast Counter & Thermal Receipt Printing
Reliable 58mm and 80mm ESC/POS receipt generation, claim stubs, and automated cash drawer kick.

### 4. 100% Offline with Automatic Daily Backups
Zero Internet required with automated local database backups.

### 5. Repair Counter Keyboard Shortcuts (For Fast Checkout)
- F1: Switch to Repair Counter (POS)
- F2: Switch to Customer Credit ("Utang") Ledger
- F3: Switch to Inventory
- F4: Switch to Warranty & Returns
- /: Jump directly to parts search and barcode box
- Alt + 1: Cash payment | Alt + 2: GCash | Alt + 3: Utang | Alt + 4: Bank Transfer
- F9: Complete Sale and Print Receipt

---

### How to Update
1. Open Settings > Data and click Check for updates, or download TechPartsPOS-$tagStr.zip.
"@
}

function Get-PlainChangelog([string]$versionTag) {
    $genScript = Join-Path $rootDir "scripts\generate-changelog.js"
    if (Test-Path $genScript) {
        try {
            $cmdArgs = @($genScript, "--version", $versionTag)
            if (-not [string]::IsNullOrWhiteSpace($Changelog)) {
                $cmdArgs += @("--note", $Changelog)
            }
            & node $cmdArgs | Out-Null
        } catch {}
    }

    $relNotes = Join-Path $rootDir "RELEASE_NOTES.md"
    if (Test-Path $relNotes) {
        return [System.IO.File]::ReadAllText($relNotes, [System.Text.Encoding]::UTF8)
    }

    return Get-DefaultReleaseNotes $versionTag
}

$releaseNotesPath = Join-Path $rootDir "RELEASE_NOTES.md"

# A real run cannot create the release without a token: fail before the
# version rewrite and the build, not 10 minutes in at the first API call.
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($token)) {
    Write-Error "No GitHub token found. Set GITHUB_TOKEN or authenticate Git, then re-run."
}

if ($DryRun) {
    # A dry run validates the build end-to-end and mutates NOTHING: no version
    # rewrite, no changelog, no commit, no tag, no network writes. The exe it
    # builds therefore carries the CURRENT package.json version, not $tag.
    $previewNotes = if (Test-Path $releaseNotesPath) {
        [System.IO.File]::ReadAllText($releaseNotesPath, [System.Text.Encoding]::UTF8)
    } else {
        Get-DefaultReleaseNotes $tag
    }
    Write-Host ""
    Write-Host "[DRY RUN] Would release as $tag (current version files stay untouched)." -ForegroundColor Cyan
    Write-Host "[DRY RUN] Release notes preview:" -ForegroundColor Cyan
    Write-Host "----------------------------------------------------------"
    Write-Host $previewNotes
    Write-Host "----------------------------------------------------------"
} else {
    $releaseNotes = Get-PlainChangelog $tag

    if (-not $NonInteractive -and [Environment]::UserInteractive) {
        Write-Host ""
        Write-Host "Drafted Changelog ($tag):" -ForegroundColor Cyan
        Write-Host "----------------------------------------------------------"
        Write-Host $releaseNotes
        Write-Host "----------------------------------------------------------"
        $choice = Read-Host "Press [E] to edit in Notepad, [Enter] to publish, or [C] to cancel"

        if ($choice -match '^[eE]') {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "techparts_release_notes_$tag.md"
            [System.IO.File]::WriteAllText($tempFile, $releaseNotes, [System.Text.Encoding]::UTF8)
            Write-Host "Opening Notepad. Save and close file when done." -ForegroundColor Cyan
            Start-Process notepad.exe -ArgumentList "`"$tempFile`"" -Wait
            if (Test-Path $tempFile) {
                $edited = [System.IO.File]::ReadAllText($tempFile, [System.Text.Encoding]::UTF8).Trim()
                if (-not [string]::IsNullOrWhiteSpace($edited)) {
                    $releaseNotes = $edited
                    $changelogPath = Join-Path $rootDir "CHANGELOG.md"
                    if (Test-Path $changelogPath) {
                        $bulletsMatch = [regex]::Match($edited, "(?s)### Highlights in this update:\s*(.*?)(?=\r?\n\r?\n---|\r?\n\r?\n###|$)")
                        if ($bulletsMatch.Success) {
                            $bulletsText = $bulletsMatch.Groups[1].Value.Trim()
                            $today = (Get-Date).ToString("yyyy-MM-dd")
                            $newEntry = "## [$tag] - $today`r`n`r`n### Highlights & Changes`r`n$bulletsText`r`n"
                            $clContent = [System.IO.File]::ReadAllText($changelogPath, [System.Text.Encoding]::UTF8)
                            $secRegex = "(?s)##\s*\[" + [regex]::Escape($tag) + "\].*?(?=\r?\n##\s*\[|$)"
                            if ($clContent -match $secRegex) {
                                $clContent = [regex]::Replace($clContent, $secRegex, $newEntry.Trim() + "`r`n`r`n")
                                [System.IO.File]::WriteAllText($changelogPath, $clContent, [System.Text.Encoding]::UTF8)
                            }
                        }
                    }
                }
                Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            }
            Write-Host "Changelog updated." -ForegroundColor Green
        } elseif ($choice -match '^[cC]') {
            Write-Host "Publish cancelled. Nothing was pushed or released." -ForegroundColor Yellow
            exit 0
        }
    }

    # Automatically sync the active release notes to RELEASE_NOTES.md
    $normalizedNotes = $releaseNotes -replace "(?<!`r)`n", "`r`n"
    [System.IO.File]::WriteAllText($releaseNotesPath, $normalizedNotes, [System.Text.Encoding]::UTF8)

    Write-Host "Publishing version $tag..." -ForegroundColor Cyan

    # 2. Update version in package.json, src/updater.js, the installer, the
    # lockfile and the README zip name. These must land BEFORE the build: the
    # exe bakes CURRENT_VERSION (updater.js) and the installer name in.
    $pkgContent = Get-Content $packageJson -Raw
    $pkgContent = $pkgContent -replace '"version":\s*"[^"]+"', "`"version`": `"$cleanVer`""
    [System.IO.File]::WriteAllText($packageJson, $pkgContent)

    $updaterPath = Join-Path $rootDir "src\updater.js"
    if (Test-Path $updaterPath) {
        $updaterTxt = Get-Content $updaterPath -Raw
        $updaterTxt = $updaterTxt -replace "const CURRENT_VERSION = '[^']+';", "const CURRENT_VERSION = '$cleanVer';"
        [System.IO.File]::WriteAllText($updaterPath, $updaterTxt)
    }

    # The installer's version drives its output filename and the Add/Remove entry,
    # and was the one version site this script never rewrote (still 1.0.0 while the
    # app said 1.1).
    $issPath = Join-Path $rootDir "installer\TechPartsPOS.iss"
    if (Test-Path $issPath) {
        $issTxt = Get-Content $issPath -Raw
        $issTxt = $issTxt -replace '#define MyAppVersion "[^"]+"', "#define MyAppVersion `"$cleanVer`""
        [System.IO.File]::WriteAllText($issPath, $issTxt)
    }

    # package-lock.json carries the version in two places (the root object and the
    # "" package entry) and drifted from package.json on every release. Rewritten
    # with an anchored regex, not ConvertFrom-Json: Windows PowerShell 5.1 refuses
    # the empty "" property name the lockfile's packages map uses, and a blind
    # '"version"' replace would clobber every dependency's version. Both root
    # entries sit directly under "name": "<package>", which no dependency does.
    $lockPath = Join-Path $rootDir "package-lock.json"
    if (Test-Path $lockPath) {
        $pkgName = (Get-Content $packageJson -Raw | ConvertFrom-Json).name
        $lockTxt = Get-Content $lockPath -Raw
        $lockPattern = '("name":\s*"' + [regex]::Escape($pkgName) + '",\s*[\r\n]+\s*)"version":\s*"[^"]+"'
        $lockTxt = [regex]::Replace($lockTxt, $lockPattern, "`$1`"version`": `"$cleanVer`"")
        [System.IO.File]::WriteAllText($lockPath, $lockTxt)
    }

    # The README names the downloadable zip, and a hand-maintained name rots on the
    # next release. Same treatment as the .iss: rewrite it here.
    $readmePath = Join-Path $rootDir "README.md"
    if (Test-Path $readmePath) {
        $readmeTxt = Get-Content $readmePath -Raw
        $readmeTxt = [regex]::Replace($readmeTxt, 'TechPartsPOS-v[0-9][0-9.]*\.zip', "TechPartsPOS-$tag.zip")
        [System.IO.File]::WriteAllText($readmePath, $readmeTxt)
    }
}

# 3. Test suite & build, BEFORE any git mutation. The old order committed
# first, so a failed build still left a "Release vX" commit on main.
Write-Host "[1/4] Running test suite & building TechPartsPOS.exe..." -ForegroundColor Yellow
& npm test
if ($LASTEXITCODE -ne 0) {
    Write-Error "Test suite failed. Release aborted. (Version files were not touched.)"
}

& npm run build:exe
if ($LASTEXITCODE -ne 0) {
    Write-Error "build:exe failed. Release aborted. (Version files were not touched.)"
}

$exePath = Join-Path $rootDir "release\customer\TechPartsPOS.exe"
if (-not (Test-Path $exePath)) {
    Write-Error "TechPartsPOS.exe was not produced at $exePath"
}
$exeSize = (Get-Item $exePath).Length
Write-Host "Executable built: $exePath ($exeSize bytes)" -ForegroundColor Green

if ($DryRun) {
    Write-Host ""
    Write-Host "[DRY RUN] Tests, build, and verify all succeeded. Nothing was committed, tagged, pushed, or published." -ForegroundColor Green
    Write-Host "[DRY RUN] A real run would release as $tag. Run: publish-release.bat" -ForegroundColor Cyan
    exit 0
}

# 4. Package standalone zip for fresh users
Write-Host "[2/4] Packaging release zip..." -ForegroundColor Yellow
$publishDir = Join-Path $rootDir "publish"
if (-not (Test-Path $publishDir)) {
    New-Item -ItemType Directory -Path $publishDir -Force | Out-Null
}

$zipPath = Join-Path $publishDir "TechPartsPOS-$tag.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$tempPackageDir = Join-Path $env:TEMP "TechPartsPOS_pack_$tag"
if (Test-Path $tempPackageDir) { Remove-Item $tempPackageDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempPackageDir | Out-Null

Copy-Item $exePath -Destination $tempPackageDir
Copy-Item (Join-Path $rootDir "README.md") -Destination $tempPackageDir

Compress-Archive -Path "$tempPackageDir\*" -DestinationPath $zipPath -Force
Remove-Item $tempPackageDir -Recurse -Force
Write-Host "Release zip created: $zipPath" -ForegroundColor Green

# 4b. Publish the executable checksum that the in-app updater verifies before it
# installs anything. src/updater.js looks for it in the same release as
# "<exe>.sha256", derived from the download URL, so the name has to stay exactly this.
$exeShaPath = Join-Path $publishDir "TechPartsPOS.exe.sha256"
if (Test-Path $exeShaPath) { Remove-Item $exeShaPath -Force }
$exeHash = (Get-FileHash -Algorithm SHA256 -Path $exePath).Hash.ToLower()
Set-Content -Path $exeShaPath -Value "$exeHash  TechPartsPOS.exe" -Encoding ascii -NoNewline
Write-Host "Checksum written: $exeShaPath ($exeHash)" -ForegroundColor Green

# 5. Commit the ENTIRE tree as the release commit. Since 2026-11-07 the full
# source is tracked; the old 4-doc-files-only commit shipped tags that pointed
# at code missing the very changes the exe was built from. release/, publish/,
# dist/, *.exe and *.db are all gitignored, so -A stages exactly the source.
$pending = & git status --porcelain
if ($LASTEXITCODE -ne 0) {
    throw "git status failed; is this a git checkout?"
}
if ($pending) {
    Write-Host "Committing all pending changes as the release commit..." -ForegroundColor Yellow
    $commitMsg = "Release $tag"
    if (-not [string]::IsNullOrWhiteSpace($Changelog)) {
        $commitMsg = "Release ${tag}: $Changelog"
    } else {
        $commitMsg = "Release ${tag}: Update release notes and distribution files"
    }
    & git add -A
    & git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        & git commit -m $commitMsg --quiet
        if ($LASTEXITCODE -ne 0) {
            throw "git commit failed; release aborted."
        }
    }
}

# 6. Push Git tag & branch
Write-Host "[3/4] Pushing tag $tag to GitHub ($repo)..." -ForegroundColor Yellow
& git push origin main
if ($LASTEXITCODE -ne 0) {
    & git push -u origin main
    if ($LASTEXITCODE -ne 0) {
        throw "git push origin main failed. Fix remote and re-run. (Version files are already committed; a re-run will reuse $tag.)"
    }
}

# Refuse a version that already has a PUBLISHED release BEFORE moving the tag:
# a force-push onto a new commit used to leave a shipped release pointing at
# code that never built its assets. Drafts are fine (they resume below).
$pre = @(Get-GithubReleases) | Where-Object { $_.tag_name -eq $tag -and -not $_.draft } | Select-Object -First 1
if ($pre) {
    throw "Release $tag is already PUBLISHED. Bump the version, or delete the release, before re-running."
}
& git tag -f $tag
& git push -f origin $tag
if ($LASTEXITCODE -ne 0) {
    throw "git push tag $tag failed. Fix remote and re-run."
}

# 7. Create or update GitHub Release. The release stays a DRAFT until every
# asset is uploaded: a failure after the tag was force-pushed used to leave a
# published, partial release (no exe, or no .sha256) sitting at the /releases/latest
# endpoint, and every shop's update check then advertised an update that could
# never install (the updater fails closed on a missing checksum).
Write-Host "Publishing release with confirmed notes ($($releaseNotes.Length) chars)..." -ForegroundColor Cyan

$releasePayload = @{
    tag_name         = $tag
    target_commitish = "main"
    name             = "TechParts POS $tag"
    body             = [string]$releaseNotes
    draft            = $true
    prerelease       = $false
} | ConvertTo-Json

$releaseUrl = "https://api.github.com/repos/$repo/releases"
$releaseObj = $null

try {
    $releaseObj = Invoke-RestMethod -Uri $releaseUrl -Method Post -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($releasePayload)) -ContentType "application/json; charset=utf-8"
} catch {
    $postErr = $_.Exception.Message
    $detail = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { "" }
    Write-Host "POST release response: $postErr $detail" -ForegroundColor Yellow
    Write-Host "Checking for existing release $tag..." -ForegroundColor Cyan
    # releases/tags/<tag> serves PUBLISHED releases only, so a re-run after a
    # failed upload could not find the draft it left behind and died, stranding
    # the version until the draft was deleted by hand. The list endpoint
    # includes drafts.
    $existing = @(Get-GithubReleases) |
        Where-Object { $_.tag_name -eq $tag } | Select-Object -First 1
    if (-not $existing) {
        throw "Release $tag could not be created ($postErr $detail) and no release with that tag exists. Check the token's repo permissions."
    }
    if (-not $existing.draft) {
        throw "Release $tag is already PUBLISHED. Bump the version, or delete the release, before re-running."
    }
    $patchPayload = @{
        tag_name = $tag
        name     = "TechParts POS $tag"
        body     = [string]$releaseNotes
        draft    = $true
    } | ConvertTo-Json
    $releaseObj = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/$($existing.id)" -Method Patch -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($patchPayload)) -ContentType "application/json; charset=utf-8"
}

# Helper to upload asset
function Upload-ReleaseAsset([object]$rel, [string]$filePath, [string]$contentType) {
    $fileName = [System.IO.Path]::GetFileName($filePath)
    if ($rel.assets) {
        foreach ($a in $rel.assets) {
            if ($a.name -eq $fileName) {
                Write-Host "Replacing existing asset $fileName..." -ForegroundColor Cyan
                Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/assets/$($a.id)" -Method Delete -Headers $headers
            }
        }
    }

    $uploadUrl = $rel.upload_url -replace '\{\?name,label\}', "?name=$fileName"
    Write-Host "Uploading $fileName..." -ForegroundColor Yellow
    $uploadResp = Invoke-RestMethod -Uri $uploadUrl -Method Post -Headers @{
        Authorization  = "Bearer $token"
        "User-Agent"   = "TechPartsPOS-Publisher"
        "Content-Type" = $contentType
    } -InFile $filePath
    return $uploadResp
}

# Upload raw exe (for in-app 1-click updater)
$exeUpload = Upload-ReleaseAsset $releaseObj $exePath "application/octet-stream"

# Upload zip (for fresh downloads)
$zipUpload = Upload-ReleaseAsset $releaseObj $zipPath "application/zip"

# Upload the exe checksum (the updater refuses any download it cannot verify)
$shaUpload = Upload-ReleaseAsset $releaseObj $exeShaPath "text/plain"

# Every asset is up: publish the release. Only now does it become the "latest"
# release that shops' update checks see.
$publishPayload = @{ draft = $false } | ConvertTo-Json
$releaseObj = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/$($releaseObj.id)" -Method Patch -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($publishPayload)) -ContentType "application/json; charset=utf-8"
Write-Host "Release $tag published (was a draft until all assets landed)." -ForegroundColor Green

Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host " Release $tag is live on GitHub!        " -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host "Release Page: $($releaseObj.html_url)"
Write-Host "Executable:   $($exeUpload.browser_download_url)"
Write-Host "Zip Archive:  $($zipUpload.browser_download_url)"
Write-Host ""
