# Renders TTS utterances with the Windows OneCore voices (WinRT), which include
# en-IN voices that System.Speech cannot see. Windows PowerShell 5.1.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1 -JobFile jobs.json
# jobs.json: [{ "text": "...", "voice": "Microsoft Heera", "out": "C:\\abs\\path.wav" }]
param([Parameter(Mandatory = $true)][string]$JobFile)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  return $task.Result
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$jobs = Get-Content -Raw -Encoding UTF8 $JobFile | ConvertFrom-Json

foreach ($job in $jobs) {
  $voice = $voices | Where-Object { $_.DisplayName -eq $job.voice } | Select-Object -First 1
  if (-not $voice) {
    throw "Voice '$($job.voice)' is not installed. Available: $(($voices | ForEach-Object { $_.DisplayName }) -join ', ')"
  }
  $synth.Voice = $voice
  $stream = Await ($synth.SynthesizeTextToStreamAsync($job.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes($job.out, $bytes)
  $reader.Dispose()
  $stream.Dispose()
}
Write-Output "rendered $($jobs.Count) utterances"
