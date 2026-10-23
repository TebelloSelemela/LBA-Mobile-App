# Run once as Administrator on Desktop 1.
# Restrict TCP 5050 to private-network peers on the local subnet.
# Never port-forward this API to the public internet.
$ErrorActionPreference = "Stop"
if (-not (Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq "Private" })) {
    Write-Host "First set LESBAD Wi-Fi to Private in Windows Network settings."
    exit 1
}
$existing = Get-NetFirewallRule -DisplayName "LESBAD Local API (Private Wi-Fi)" -ErrorAction SilentlyContinue
if (-not $existing) {
    New-NetFirewallRule -DisplayName "LESBAD Local API (Private Wi-Fi)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5050 -Profile Private -RemoteAddress LocalSubnet | Out-Null
    Write-Host "LAN-only firewall rule installed."
} else {
    Write-Host "LAN-only firewall rule already exists."
}
