param(
  [string]$Server = 'smtp.capgroup.com',
  [int]$Port = 25,
  [string]$From,
  [string]$To
)

function Read-Response($reader) {
  $lines = @()
  while ($true) {
    try {
      $line = $reader.ReadLine()
    } catch {
      Write-Host "  [no response within timeout]" -ForegroundColor Yellow
      break
    }
    if ($null -eq $line) { Write-Host "  [connection closed by server]" -ForegroundColor Yellow; break }
    $lines += $line
    Write-Host "  $line"
    if ($line.Length -lt 4 -or $line[3] -eq ' ') { break }
  }
  return $lines
}

try {
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect($Server, $Port)
} catch {
  Write-Host "TCP connect FAILED: $($_.Exception.Message)" -ForegroundColor Red
  return
}

$stream = $client.GetStream()
$stream.ReadTimeout = 30000
$reader = New-Object System.IO.StreamReader($stream)
$writer = New-Object System.IO.StreamWriter($stream)
$writer.AutoFlush = $true

Write-Host "== Banner =="       -ForegroundColor Cyan
Read-Response $reader

Write-Host "== EHLO =="         -ForegroundColor Cyan
$writer.WriteLine("EHLO $($env:COMPUTERNAME)")
Read-Response $reader

if ($From -and $To) {
  Write-Host "== MAIL FROM =="  -ForegroundColor Cyan
  $writer.WriteLine("MAIL FROM:<$From>")
  Read-Response $reader

  Write-Host "== RCPT TO =="    -ForegroundColor Cyan
  $writer.WriteLine("RCPT TO:<$To>")
  Read-Response $reader

  Write-Host "== DATA =="       -ForegroundColor Cyan
  $writer.WriteLine("DATA")
  Read-Response $reader

  $writer.WriteLine("From: $From")
  $writer.WriteLine("To: $To")
  $writer.WriteLine("Subject: SMTP relay test $(Get-Date -Format s)")
  $writer.WriteLine("")
  $writer.WriteLine("This is a test message from $($env:COMPUTERNAME) via $Server`:$Port.")
  $writer.WriteLine(".")
  Write-Host "== end-of-DATA response ==" -ForegroundColor Cyan
  Read-Response $reader
}

$writer.WriteLine("QUIT")
Read-Response $reader
$client.Close()
Write-Host "Done." -ForegroundColor Green
