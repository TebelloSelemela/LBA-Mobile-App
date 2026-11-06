# LESBAD LAN v1.0.29 — Bracket Export and Zoom Improvements

## Changes

- Fit mode shows the full bracket (scaled to viewport); 100% shows unscaled readable cards and allows horizontal and vertical scrolling.
- Zoom + and - step to exact 10% boundaries (for example, 60%, 70%, 80%, 90%, 100%).
- Manual zoom and slider positions are retained when the bracket viewport is resized.
- Expand button opens the draw in an enlarged overlay; Escape or Exit closes it.
- Exported event and executive PDFs have cleaner competitor rows and winner highlights, with scores separated from names.
- Printable Match Results pages list each actual match, winner and full game scores by round, including third-place results.
- Ranking, draw generation, scores, players, audit, database schema and imports are unchanged.

## Updating an existing LAN installation

1. Stop the server. Back up the entire local-data directory and database first.
2. Download LESBAD-LAN-Server-v1.0.29.zip and extract it.
3. Copy the extracted backend, frontend and local-network folders over those in the *existing* LESBAD installation.
4. DO NOT replace or delete local-data, config.json, lesbad.sqlite3 or .venv.
5. Run local-network/start-server.bat. Your configured port (e.g. 8765) remains unchanged.
6. Open your existing address in a browser and export a completed tournament's bracket PDF.
7. If using a Windows desktop app, replace it with LESBAD-LAN-Desktop-v1.0.29.exe; press Ctrl+Shift+L to set your LAN server address if required.

Fit and 100% serve different purposes. A full 32-player bracket cannot physically display at native 100% and still fit into a typical desktop monitor; scrolling is expected at 100%.

Existing Railway and other LAN records are not automatically synchronized.
