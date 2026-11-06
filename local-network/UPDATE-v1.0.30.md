# LESBAD Local Network Edition v1.0.30 — Balanced BYE Placement

On new singles and doubles knockout draws, BYEs are now distributed evenly across the left/right halves, quarters and deeper branches instead of being placed consecutively at the start.

- 24 players in a 32-slot knockout: eight BYEs appear in fixtures 1, 9, 5, 13, 3, 11, 7, and 15 (in visual bracket order). That means one BYE in each pair of first-round fixtures.
- Seed By Ranking: strongest protected seeds are spread across the bracket and receive first priority for BYEs.
- Unseeded draws: participants are still randomized; BYE fixtures are balanced across the draw.
- Match numbering and subsequent winner pairings remain unchanged. A BYE continues to advance its player/team automatically.
- No database schema changes. Existing scored tournaments and generated draws are deliberately NOT reordered, because doing so could invalidate previously recorded results, rankings and finalist paths.

## Update an existing LESBAD LAN installation

1. Stop the server and make a safe backup of the entire local-data folder.
2. Download and extract LESBAD-LAN-Server-v1.0.30.zip.
3. Copy only the backend, frontend and local-network application folders over those in the existing install.
4. Do NOT delete or replace local-data, .venv or the existing SQLite database.
5. Restart local-network/start-server.bat, keeping the same configured port (e.g. 8765).
6. Create a NEW test tournament/draw with 24 participants and confirm BYEs are distributed across the 16 Round-of-32 match slots.
7. If using the portable Windows client, update to LESBAD-LAN-Desktop-v1.0.30.exe. The tablet uses the updated server browser interface automatically.

Existing tournaments that have already started should be finished using their established bracket. A safer migration or manual reseeding strategy would require explicit approval and validation of all current match results.
