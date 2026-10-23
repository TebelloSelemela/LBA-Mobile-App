# LESBAD LAN Edition — Installation Guide

This is a **separate LAN-only pilot branch**, not the Railway production application.

## Downloads

- **LESBAD-LAN-Server-v1.0.27.zip** is installed only on **Desktop 1**.
- **LESBAD-LAN-Desktop-v1.0.27.exe** is a portable desktop client (Desktop 1 or 2).
- The organization tablet uses Chrome/Edge at Desktop 1's Wi-Fi IP address.

## Set up Desktop 1

1. Install Python 3.12 or 3.13 with the `py` launcher.
2. Extract the server ZIP to `C:\LESBAD-LAN`. This is a permanent location, not Downloads.
3. **Before starting:** If migrating your current player/tournament records,
   export a consistent SQLite backup from Railway first. Stop any
   Railway-side writes during the final migration; do not copy an open .db file
   without its SQLite backup operation.
4. If you have the backup, open Command Prompt in `C:\LESBAD-LAN` and run:
   `py -3 local-network\import_existing_db.py "C:\Backups\lba_rankings.db"`
   The importer checks schema/integrity and **will not overwrite** an existing
   local database. For a new/empty pilot, skip this step.
5. Double-click `local-network\start-server.bat`.
   First launch installs dependencies (requires temporary internet) and prompts
   you for a strong initial admin password. For an imported database, the
   original users' passwords remain valid.
6. Check http://127.0.0.1:5050/api/health for `"ok": true`. Open
   http://127.0.0.1:5050 for the app.
7. In Windows Settings set the office Wi-Fi network profile to **Private**.
   Then run PowerShell as Administrator:
   `powershell -ExecutionPolicy Bypass -File "C:\LESBAD-LAN\local-network\allow-private-wifi.ps1"`
   That enables TCP 5050 **only on Private networks from LocalSubnet**.
8. Run `ipconfig` in CMD to find Desktop 1's IPv4 address. Make a
   DHCP address reservation in the router. E.g. `192.168.1.50` is an
   EXAMPLE only.
9. Keep Desktop 1 awake, plugged in, and the server window open when in use.

## Desktop 2

On the same Wi-Fi, open the optional LAN Desktop EXE; enter
`http://<Desktop-1-IP>:5050`. It checks the LESBAD API before saving the
address. **Ctrl+Shift+L** changes it later. Or simply use the browser URL.

## Tablet

Connect to that same staff Wi-Fi, open `http://<Desktop-1-IP>:5050`
in the tablet browser, and bookmark it. The tablet does not run Windows EXE.

## Backups and data safety

- **Only Desktop 1** writes `local-data\lesbad.sqlite3`. Desktop 2 and tablet
  talk to the Flask API. Do not open the SQLite file over a network share.
- WAL mode and 15-second SQLite busy timeout assist concurrent LAN requests.
- Server performs consistent online SQLite backups at startup and every
  **six hours**; retains **30 latest verified snapshots** in
  `local-data\backups`.
- Run `local-network\backup-now.bat` for a manual snapshot.
- Copy backups to an encrypted off-machine drive, too. Backups on Desktop 1
  alone are not safe against disk failure.
- `local-data\config.json` contains initial password material; never send
  it by email or put it in a public repository; restrict NTFS access.
- Retain the live Railway service until the existing database has been
  safely transferred and every workflow has been tested.

## Offline/operational limits

- Initial Python installation and dependencies need internet.
- Player registration, scoring, rankings, draws, exports and audit views
  run on the Wi-Fi LAN after local setup.
- Email verification and password reset require configured email delivery;
  they cannot send mail with no internet.
- Refresh the other devices' screens to display new results. This pilot does
  not add WebSocket streaming or automatic cloud synchronization.
- Desktop 1 going offline prevents the other two devices from accessing data.
- Never open port 5050 publicly or enable router port forwarding.
- LAN HTTP does NOT encrypt application traffic end-to-end. Use dedicated
  WPA2/WPA3 staff Wi-Fi, no guest access/AP isolation, and arrange locally
  trusted HTTPS certificates before full deployment of sensitive records.

## Acceptance checks

1. Register a test player on Desktop 1, refresh Desktop 2 and verify it appears.
2. Attempt duplicate DOB/name registration and confirm it is rejected.
3. Sign into the tablet and confirm the same players appear.
4. Create a test tournament, capture a result from Desktop 2, refresh the
   other clients and verify updated rounds and podium.
5. Confirm PDF/Excel exports and Audit Logs.
6. Make a backup and check its integrity.
7. Disable **internet only** (leave Wi-Fi active), repeat a non-email test.
8. Shut down Desktop 1; verify the clients cannot write independently.
9. Restore Desktop 1 and verify records persist.

**The LAN and Railway databases do not synchronize automatically.**
