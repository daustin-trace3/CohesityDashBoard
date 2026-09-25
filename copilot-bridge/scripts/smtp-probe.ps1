param([string]$Server='smtp.capgroup.com',[int[]]$Ports=@(25,587,465,2525))
foreach ($p in $Ports) {
  Write-Host "--- $Server`:$p ---" -ForegroundColor Cyan
  $client = New-Object System.Net.Sockets.TcpClient
  $iar = $client.BeginConnect($Server,$p,$null,$null)
  if (-not $iar.AsyncWaitHandle.WaitOne(4000)) { Write-Host "  TCP connect: TIMEOUT" -ForegroundColor Yellow; $client.Close(); continue }
  try { $client.EndConnect($iar) } catch { Write-Host "  TCP connect: REFUSED ($($_.Exception.Message))" -ForegroundColor Yellow; continue }
  Write-Host "  TCP connect: OK"
  $stream = $client.GetStream()
  $stream.ReadTimeout = 8000
  $buf = New-Object byte[] 1024
  try {
    $n = $stream.Read($buf,0,$buf.Length)
    if ($n -gt 0) {
      $text = [Text.Encoding]::ASCII.GetString($buf,0,$n)
      Write-Host ("  BANNER ({0} bytes): {1}" -f $n, $text.Trim())
    } else {
      Write-Host "  Stream closed with no data" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  No banner within 8s (read timeout)" -ForegroundColor Yellow
  }
  $client.Close()
}
