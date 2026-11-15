/** Windows 语音工作进程：只读 stdin 的 JSON，在内存中处理 WAV，永不打开麦克风或扬声器。 */
export const WINDOWS_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Speech
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -eq 'synthesize') {
    $speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
    try {
      $selected = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $request.voice } | Select-Object -First 1
      if ($null -eq $selected) { throw 'no-voice' }
      $speaker.SelectVoice($selected.VoiceInfo.Name)
      $speaker.Rate = [Math]::Max(-5, [Math]::Min(10, [int]($request.rate / 10)))
      $wave = [IO.MemoryStream]::new()
      try {
        $speaker.SetOutputToWaveStream($wave)
        $speaker.Speak([string]$request.text)
        $speaker.SetOutputToNull()
        @{audio=[Convert]::ToBase64String($wave.ToArray())} | ConvertTo-Json -Compress
      } finally { $wave.Dispose() }
    } finally { $speaker.Dispose() }
  } elseif ($request.operation -eq 'transcribe') {
    $selected = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
    if ($null -eq $selected) { throw 'no-recognizer' }
    $listener = [System.Speech.Recognition.SpeechRecognitionEngine]::new($selected)
    $wave = [IO.MemoryStream]::new([byte[]][Convert]::FromBase64String($request.audio), $false)
    try {
      $listener.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
      $listener.SetInputToWaveStream($wave)
      $phrases = [Collections.Generic.List[string]]::new()
      while ($true) {
        try { $phrase = $listener.Recognize() }
        catch { if ($wave.Position -ge $wave.Length) { break }; throw }
        if ($null -eq $phrase) { break }
        if (-not [string]::IsNullOrWhiteSpace($phrase.Text)) { $phrases.Add($phrase.Text) }
      }
      @{text=($phrases -join '，')} | ConvertTo-Json -Compress
    } finally { $listener.Dispose(); $wave.Dispose() }
  } else { throw 'unsupported-operation' }
} catch {
  $category = 'failed'
  if ($_.Exception.Message -eq 'no-recognizer') { $category = 'no-recognizer' }
  if ($_.Exception.Message -eq 'no-voice') { $category = 'no-voice' }
  @{error=$category} | ConvertTo-Json -Compress
  exit 1
}
`;
