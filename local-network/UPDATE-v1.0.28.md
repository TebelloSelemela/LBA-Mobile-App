# LESBAD Local Network Edition v1.0.28 — Startup Repair

This update fixes the UNIQUE users.email conflict without deleting or resetting any users.

## Updating an existing LAN server
1. Close the server command window.
2. Make a separate backup copy of the entire local-data folder (including config.json, lesbad.sqlite3 and any -wal / -shm files).
3. Extract the new LAN Server ZIP and copy its backend, frontend and local-network folders over those in the existing LESBAD installation. Do NOT delete local-data or .venv.
4. Double-click local-network/start-server.bat.
5. If your first run already created an administrator, sign in using that existing username and password. The seed password in config.json is NOT used to reset an existing account.
6. To see available local usernames and roles without exposing passwords, run this in Command Prompt from the LESBAD installation folder:
   .venv\Scripts\python.exe local-network\show-local-users.py
7. If you changed the port to 8765 previously, that configuration is preserved. Check http://127.0.0.1:8765/api/health and use the same port in the Windows client.

Your existing local-data folder remains untouched by the update ZIP. Do not delete it to solve a startup problem.
Port 5050 is the default only for fresh installations. Office firewall rules must match the configured port.
Never expose the local server port to the public internet.
