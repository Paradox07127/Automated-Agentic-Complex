# Fetches the speech runtime ac-helper.exe loads (ops_voice.cpp) into <Out>\third_party\, checks its sha256 before use,
# unpacks it afresh and puts its two DLLs beside ac-helper.exe in <Out>. Nothing of it is committed. build.bat calls it.
#
# sherpa-onnx v2.0.2, the Windows x64 shared-library release with a static CRT and without TTS:
#   https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-v2.0.2-win-x64-shared-MT-Release-no-tts.tar.bz2
#   sha256 6a71d5ef016e544026d6505486d9fa42177ad989238adc6e4bd2eebfb6947416
# Used: include\sherpa-onnx\c-api\c-api.h, lib\sherpa-onnx-c-api.dll (sherpa-onnx, Apache-2.0) and lib\onnxruntime.dll
# (ONNX Runtime, MIT), as NOTICE lists them.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$name = 'sherpa-onnx-v2.0.2-win-x64-shared-MT-Release-no-tts'
$url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/$name.tar.bz2"
$sha256 = '6a71d5ef016e544026d6505486d9fa42177ad989238adc6e4bd2eebfb6947416'

$dir = Join-Path $Out 'third_party'
$archive = Join-Path $dir "$name.tar.bz2"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    $part = "$archive.part"
    & curl.exe --fail --silent --show-error --location --retry 3 --output $part $url
    if ($LASTEXITCODE -ne 0) { throw "third_party.ps1: downloading $url failed ($LASTEXITCODE)" }
    Move-Item -LiteralPath $part -Destination $archive -Force
}
$got = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
if ($got -ne $sha256) {
    Remove-Item -LiteralPath $archive -Force
    throw "third_party.ps1: $name.tar.bz2 has sha256 $got, not $sha256; removed"
}
$unpacked = Join-Path $dir $name
if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
& tar.exe -xjf $archive -C $dir
if ($LASTEXITCODE -ne 0) { throw "third_party.ps1: unpacking $archive failed ($LASTEXITCODE)" }
foreach ($dll in 'sherpa-onnx-c-api.dll', 'onnxruntime.dll') {
    Copy-Item -LiteralPath (Join-Path $unpacked "lib\$dll") -Destination (Join-Path $Out $dll) -Force
}
