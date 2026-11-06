# LESBAD LAN v1.0.31 — Adaptive BYE Spacing

New draws spread BYEs by dividing the total number of first-round matches by the number of BYEs. Rather than always giving the first visible match a BYE, the system places each BYE near the end of a similarly sized group of fixtures.

Example allocations (match numbers are 1-based):

- **Round of 64**, 56 entrants and 8 BYEs: 32 first-round fixtures → BYEs in matches **4, 8, 12, 16, 20, 24, 28, 32**.
- **Round of 32**, 24 entrants and 8 BYEs: 16 first-round fixtures → BYEs in matches **2, 4, 6, 8, 10, 12, 14, 16**.
- **Round of 32**, 28 entrants and 4 BYEs: 16 first-round fixtures → BYEs in matches **4, 8, 12, 16**.
- For counts without a whole-number interval, gaps differ by at most one first-round match.

Rank-seeded draws still give top-ranked entrants priority for BYEs, placing protected seeds across halves/quarters of the bracket. Unseeded player selection is still randomized by the API. BYE winners continue to advance automatically; match numbering and future-round pathways remain the same.

**Important:** Existing generated draws and scored tournaments will NOT be reshuffled. This change affects **newly generated** Singles/Doubles draws only. Do not re-create an active tournament to force a layout change.

## Updating an existing LAN installation

1. Stop LESBAD and back up the entire `local-data` folder (including the SQLite database, configuration and backups).
2. Download the `LESBAD-LAN-Server-v1.0.31.zip` from the GitHub Release.
3. Copy its `backend`, `frontend`, and `local-network` folders over the matching folders in your **existing installation**.
4. Do not replace or delete `local-data`, `.venv` or your SQLite database. Your configured port, such as 8765, will remain in use.
5. Start `local-network\start-server.bat`, sign in, and generate a fresh **test** draw to verify the BYE positions.
6. Update the optional desktop client to `LESBAD-LAN-Desktop-v1.0.31.exe`; the tablet uses the new server-hosted web UI automatically.

These changes do not migrate or synchronize the separate Railway database.
