$ng="C:\Users\Administrator\ngrok\ngrok.exe"
$cfg="C:\Users\Administrator\AppData\Local\ngrok\ngrok.yml"
$log="C:\Users\Administrator\ngrok\ngrok.log"
# avoid duplicate instances
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $ng -ArgumentList @("start","--all","--config",$cfg,"--log",$log,"--log-format","logfmt") -WindowStyle Hidden
Start-Sleep -Seconds 1
Write-Output "STARTED_PID="
(Get-Process ngrok -ErrorAction SilentlyContinue | Select-Object -First 1).Id
