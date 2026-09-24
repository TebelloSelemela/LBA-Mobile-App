# LBA Admin App

A local administration system for Lesotho Badminton Association ranking records and random tournament draws.

## New features in this version

- Add latest obtained points to an existing player total.
  - Example: if a player has 120 points and you add 20, the database stores 140.
- Generate tournament draws only from players selected as attending.
  - The app no longer forces the draw to use every active player.
- Backend runs on port 5050 by default to avoid Windows port 5000 conflicts.
- Export generated tournament draws as a printable PDF draw sheet.

## Login

Username: `admin`
Password: `admin123`

## Start backend

```cmd
cd C:\Users\Selemela\Documents\lba-admin-app\backend
..\venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Backend health check:

```text
http://127.0.0.1:5050/api/health
```

## Start frontend

Open another Command Prompt:

```cmd
cd C:\Users\Selemela\Documents\lba-admin-app\frontend
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Important database location

```text
lba-admin-app/database/lba_rankings.db
```

Back up this file regularly because it contains the association records.

## Export draw PDF

Go to **Draws**, select or generate a draw, then click **Export Draw PDF**. The backend creates a printable PDF with draw title, category, draw type, created date, match numbers, sides, and a winner/score column.
