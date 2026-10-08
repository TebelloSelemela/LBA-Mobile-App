import csv
import io
import os
import secrets
import smtplib
from email.message import EmailMessage
import sqlite3
import re
import hashlib
import json
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from functools import wraps
from werkzeug.security import generate_password_hash, check_password_hash

from flask import Flask, jsonify, request, Response, g
from flask_cors import CORS
from openpyxl import load_workbook, Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, A3, A2, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.pdfgen import canvas as pdfcanvas

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB = BASE_DIR.parent / "database" / "lba_rankings.db"
DB_PATH = Path(os.environ.get("LBA_DB_PATH", DEFAULT_DB))
LOGO_PATH = BASE_DIR.parent / "frontend" / "src" / "assets" / "lba-logo.png"
ADMIN_USERNAME = os.environ.get("LBA_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("LBA_ADMIN_PASSWORD")
if not ADMIN_PASSWORD:
    raise RuntimeError("LBA_ADMIN_PASSWORD must be set in the environment before starting the backend.")
AUTH_TOKEN_DAYS = int(os.environ.get("LBA_AUTH_TOKEN_DAYS", "30"))
SMTP_HOST = os.environ.get("LBA_SMTP_HOST")
SMTP_PORT = int(os.environ.get("LBA_SMTP_PORT", "587"))
SMTP_USERNAME = os.environ.get("LBA_SMTP_USERNAME")
SMTP_PASSWORD = os.environ.get("LBA_SMTP_PASSWORD")
SMTP_FROM = os.environ.get("LBA_SMTP_FROM") or SMTP_USERNAME
PUBLIC_APP_URL = os.environ.get("LBA_PUBLIC_APP_URL", "")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
EMAIL_FROM = os.environ.get("LBA_EMAIL_FROM") or SMTP_FROM or "onboarding@resend.dev"


def create_app():
    app = Flask(__name__)
    CORS(app)
    ensure_database()

    @app.route("/api/health")
    def health():
        return jsonify({"ok": True, "database": str(DB_PATH), "time": now_iso(), "timezone": "Africa/Maseru (SAST, UTC+02:00)"})

    @app.route("/api/auth/login", methods=["POST"])
    def login():
        data = request.get_json(silent=True) or {}
        identifier = (data.get("username") or data.get("email") or "").strip()
        password = data.get("password") or ""
        if not identifier or not password:
            return jsonify({"error": "Username/email and password are required"}), 400

        with db() as con:
            user = con.execute("""
                SELECT * FROM users
                WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)
                LIMIT 1
            """, (identifier, identifier)).fetchone()

            if not user or not user["is_active"] or not check_password_hash(user["password_hash"], password):
                return jsonify({"error": "Invalid username/email or password"}), 401
            if not user["email_verified"]:
                return jsonify({"error": "Please verify your email address before signing in."}), 403

            token = secrets.token_urlsafe(48)
            token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
            now = datetime.utcnow()
            expires = now.timestamp() + (AUTH_TOKEN_DAYS * 86400)
            expires_at = datetime.utcfromtimestamp(expires).replace(microsecond=0).isoformat() + "Z"
            now_text = now.replace(microsecond=0).isoformat() + "Z"

            con.execute("""
                INSERT INTO auth_tokens(user_id, token_hash, created_at, expires_at)
                VALUES(?,?,?,?)
            """, (user["id"], token_hash, now_text, expires_at))
            con.execute("UPDATE users SET last_login=?, updated_at=? WHERE id=?", (now_text, now_text, user["id"]))
            con.commit()

        return jsonify({
            "token": token,
            "user": public_user(user),
            "expires_at": expires_at
        })


    @app.route("/api/auth/register", methods=["POST"])
    def register():
        data = request.get_json(silent=True) or {}
        full_name = (data.get("full_name") or "").strip()
        username = (data.get("username") or "").strip()
        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""

        if not full_name or not username or not email or len(password) < 8:
            return jsonify({"error": "Full name, username, email and a password of at least 8 characters are required"}), 400

        now = now_iso()
        with db() as con:
            exists = con.execute("SELECT id FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)", (username, email)).fetchone()
            if exists:
                return jsonify({"error": "Username or email is already registered"}), 409

            con.execute("""
                INSERT INTO users(username,email,full_name,password_hash,role,is_active,email_verified,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)
            """, (username, email, full_name, generate_password_hash(password), "Viewer", 1, 0, now, now))
            user_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
            raw_token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
            expires = datetime.utcfromtimestamp(datetime.utcnow().timestamp() + 86400).replace(microsecond=0).isoformat() + "Z"
            con.execute("INSERT INTO email_tokens(user_id,token_hash,token_type,expires_at,created_at) VALUES(?,?,?,?,?)",
                        (user_id, token_hash, "verify", expires, now))
            con.commit()

        try:
            send_email(
                email,
                "Verify your LBA Admin account",
                f"Hello {full_name},\n\nYour LBA Admin account has been created. "
                f"Use this verification code/link token to verify your email:\n\n{raw_token}\n\n"
                f"This token expires in 24 hours.\n"
            )
        except Exception:
            # Do not leave an unusable unverified account behind when email delivery fails.
            with db() as con:
                con.execute("DELETE FROM email_tokens WHERE user_id=? AND token_type='verify'", (user_id,))
                con.execute("DELETE FROM users WHERE id=? AND email_verified=0", (user_id,))
                con.commit()
            return jsonify({
                "error": "Account could not be created because the verification email could not be sent. Please try again later."
            }), 503

        return jsonify({"message": "Registration successful. Check your email to verify your account."}), 201


    @app.route("/api/auth/resend-verification", methods=["POST"])
    def resend_verification():
        data = request.get_json(silent=True) or {}
        identifier = (data.get("email") or data.get("username") or "").strip().lower()
        if not identifier:
            return jsonify({"error": "Username or email is required"}), 400

        with db() as con:
            user = con.execute("""
                SELECT * FROM users
                WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)
                LIMIT 1
            """, (identifier, identifier)).fetchone()

            if not user:
                return jsonify({"error": "If that account exists and is not verified, a new verification token has been sent."})

            if user["email_verified"]:
                return jsonify({"message": "This email is already verified. You can sign in now."})

            raw_token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
            now = now_iso()
            expires = datetime.utcfromtimestamp(
                datetime.utcnow().timestamp() + 86400
            ).replace(microsecond=0).isoformat() + "Z"

            con.execute(
                "DELETE FROM email_tokens WHERE user_id=? AND token_type='verify'",
                (user["id"],)
            )
            con.execute(
                "INSERT INTO email_tokens(user_id,token_hash,token_type,expires_at,created_at) VALUES(?,?,?,?,?)",
                (user["id"], token_hash, "verify", expires, now)
            )
            con.commit()

        try:
            send_email(
                user["email"],
                "Your new LBA email verification token",
                f"Hello {user['full_name']},\\n\\n"
                f"Here is your new LBA Admin email verification token:\\n\\n"
                f"{raw_token}\\n\\n"
                f"This token expires in 24 hours. Any previous verification token is no longer valid.\\n"
            )
        except Exception:
            with db() as con:
                con.execute("DELETE FROM email_tokens WHERE token_hash=?", (token_hash,))
                con.commit()
            return jsonify({
                "error": "The verification email could not be sent right now. Please try again later."
            }), 503

        return jsonify({
            "message": "A new verification token has been sent to your registered email address."
        })


    @app.route("/api/auth/verify-email", methods=["POST"])
    def verify_email():
        data = request.get_json(silent=True) or {}
        raw_token = (data.get("token") or "").strip()
        if not raw_token:
            return jsonify({"error": "Verification token is required"}), 400
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        with db() as con:
            row = con.execute("""
                SELECT user_id FROM email_tokens
                WHERE token_hash=? AND token_type='verify' AND expires_at > ?
            """, (token_hash, now_iso())).fetchone()
            if not row:
                return jsonify({"error": "Invalid or expired verification token"}), 400
            con.execute("UPDATE users SET email_verified=1, updated_at=? WHERE id=?", (now_iso(), row["user_id"]))
            con.execute("DELETE FROM email_tokens WHERE token_hash=?", (token_hash,))
            con.commit()
        return jsonify({"message": "Email verified. You can now sign in."})


    @app.route("/api/auth/forgot-password", methods=["POST"])
    def forgot_password():
        data = request.get_json(silent=True) or {}
        email = (data.get("email") or "").strip().lower()
        if not email:
            return jsonify({"error": "Email is required"}), 400
        with db() as con:
            user = con.execute("SELECT * FROM users WHERE LOWER(email)=LOWER(?) AND is_active=1", (email,)).fetchone()
            if user:
                raw_token = secrets.token_urlsafe(32)
                token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
                now = now_iso()
                expires = datetime.utcfromtimestamp(datetime.utcnow().timestamp() + 3600).replace(microsecond=0).isoformat() + "Z"
                con.execute("DELETE FROM email_tokens WHERE user_id=? AND token_type='reset'", (user["id"],))
                con.execute("INSERT INTO email_tokens(user_id,token_hash,token_type,expires_at,created_at) VALUES(?,?,?,?,?)",
                            (user["id"], token_hash, "reset", expires, now))
                con.commit()
                try:
                    send_email(
                        user["email"],
                        "Reset your LBA Admin password",
                        f"Hello {user['full_name']},\n\nA password reset was requested for your LBA Admin account.\n\n"
                        f"Use this reset token in the app:\n\n{raw_token}\n\n"
                        f"The token expires in 1 hour. If you did not request this, ignore this email.\n"
                    )
                except Exception:
                    # Remove the unusable reset token so a failed delivery cannot leave a misleading reset state.
                    con.execute("DELETE FROM email_tokens WHERE token_hash=?", (token_hash,))
                    con.commit()
                    return jsonify({
                        "error": "The password reset email could not be sent right now. Please try again later."
                    }), 503
        return jsonify({"message": "If that email is registered, a password reset message has been sent."})


    @app.route("/api/auth/reset-password", methods=["POST"])
    def reset_password():
        data = request.get_json(silent=True) or {}
        raw_token = (data.get("token") or "").strip()
        password = data.get("password") or ""
        if not raw_token or len(password) < 8:
            return jsonify({"error": "Reset token and a password of at least 8 characters are required"}), 400
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        with db() as con:
            row = con.execute("""
                SELECT user_id FROM email_tokens
                WHERE token_hash=? AND token_type='reset' AND expires_at > ?
            """, (token_hash, now_iso())).fetchone()
            if not row:
                return jsonify({"error": "Invalid or expired reset token"}), 400
            now = now_iso()
            con.execute("UPDATE users SET password_hash=?, email_verified=1, updated_at=? WHERE id=?",
                        (generate_password_hash(password), now, row["user_id"]))
            con.execute("DELETE FROM email_tokens WHERE token_hash=?", (token_hash,))
            con.execute("DELETE FROM auth_tokens WHERE user_id=?", (row["user_id"],))
            con.commit()
        return jsonify({"message": "Password reset successfully. Please sign in again."})


    @app.route("/api/auth/me")
    @require_auth
    def auth_me():
        return jsonify({"user": public_user(g.current_user)})


    @app.route("/api/auth/logout", methods=["POST"])
    @require_auth
    def auth_logout():
        token = bearer_token()
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with db() as con:
            con.execute("DELETE FROM auth_tokens WHERE token_hash=?", (token_hash,))
            con.commit()
        return jsonify({"logged_out": True})

    @app.route("/api/dashboard")
    @require_auth
    def dashboard():
        with db() as con:
            sync_player_age_categories(con)
            total = con.execute("SELECT COUNT(*) FROM players").fetchone()[0]
            active = con.execute("SELECT COUNT(*) FROM players WHERE status='Active'").fetchone()[0]
            categories = con.execute("""SELECT COUNT(DISTINCT category_code) FROM players
                                      WHERE category_code IS NOT NULL AND category_code!=''
                                        AND UPPER(COALESCE(category_code,'')) NOT LIKE '%JUNIOR%'
                                        AND UPPER(COALESCE(age_group,''))!='JUNIOR'""").fetchone()[0]
            top = con.execute("SELECT id, full_name, category_code, club, rank_position, total_points, tournaments_played, age_group FROM players ORDER BY COALESCE(rank_position, 999999), total_points DESC, full_name LIMIT 6").fetchall()
            categories_breakdown = con.execute("""
                SELECT category_code, event_type, age_group, COUNT(*) AS player_count
                FROM players WHERE category_code IS NOT NULL AND category_code!=''
                  AND UPPER(COALESCE(category_code,'')) NOT LIKE '%JUNIOR%'
                  AND UPPER(COALESCE(age_group,''))!='JUNIOR'
                GROUP BY category_code, event_type, age_group
                ORDER BY player_count DESC, category_code
            """).fetchall()
            recent = con.execute("SELECT action, details, created_at FROM audit_logs ORDER BY id DESC LIMIT 6").fetchall()
            draws = con.execute("SELECT COUNT(*) FROM draws").fetchone()[0]

            player_rows = con.execute("""
                SELECT id,full_name,category_code,club,rank_position,total_points,
                       tournaments_played,status,age_group,gender,date_of_birth
                FROM players
                WHERE status='Active'
            """).fetchall()
            player_map = {int(row["id"]): dict(row) for row in player_rows}

            # Rising player = largest positive points gain recorded during the
            # recent 90-day period. ADD_POINTS already stores the before/delta/
            # after values in the audit trail, so no new ranking workflow is
            # required.
            points_gain = {}
            cutoff = datetime.now(ZoneInfo("Africa/Maseru")) - timedelta(days=90)
            point_logs = con.execute("""
                SELECT entity_id,details,created_at
                FROM audit_logs
                WHERE action='ADD_POINTS' AND entity='players'
                ORDER BY id DESC
            """).fetchall()
            for log in point_logs:
                try:
                    created = datetime.fromisoformat(str(log["created_at"]))
                    if created.tzinfo is None:
                        created = created.replace(tzinfo=ZoneInfo("Africa/Maseru"))
                    if created < cutoff:
                        continue
                except Exception:
                    pass
                match = re.search(r"\+\s*(-?\d+(?:\.\d+)?)\s*=", str(log["details"] or ""))
                if not match:
                    continue
                delta = float(match.group(1))
                if delta <= 0:
                    continue
                pid = int(log["entity_id"] or 0)
                if pid in player_map:
                    points_gain[pid] = points_gain.get(pid, 0.0) + delta

            rising = None
            if points_gain:
                rising_id = max(points_gain, key=lambda pid: (points_gain[pid], float(player_map[pid].get("total_points") or 0)))
                rising = dict(player_map[rising_id])
                rising["points_gain_90d"] = round(points_gain[rising_id], 2)

            # In-form player = strongest win rate across recent completed
            # tournament matches. Team wins are credited to both doubles
            # partners because draw_matches preserves player IDs for each side.
            form_stats = {}
            completed_rows = con.execute("""
                SELECT dm.side_a_player_ids,dm.side_b_player_ids,dm.side_a,dm.side_b,
                       dm.winner,dm.result_updated_at,d.event_name,t.name AS tournament_name
                FROM draw_matches dm
                JOIN draws d ON d.id=dm.draw_id
                LEFT JOIN tournaments t ON t.id=d.tournament_id
                WHERE dm.status='Completed' AND dm.winner IS NOT NULL AND dm.side_b!='Bye'
                ORDER BY COALESCE(dm.result_updated_at,d.created_at) DESC, dm.id DESC
                LIMIT 160
            """).fetchall()

            for match_row in completed_rows:
                side_a_ids = [int(x) for x in str(match_row["side_a_player_ids"] or "").split(",") if x.strip().isdigit()]
                side_b_ids = [int(x) for x in str(match_row["side_b_player_ids"] or "").split(",") if x.strip().isdigit()]
                winner = str(match_row["winner"] or "")
                winning_ids = side_a_ids if winner == str(match_row["side_a"] or "") else side_b_ids
                for pid in set(side_a_ids + side_b_ids):
                    if pid not in player_map:
                        continue
                    stat = form_stats.setdefault(pid, {"matches": 0, "wins": 0})
                    stat["matches"] += 1
                    if pid in winning_ids:
                        stat["wins"] += 1

            in_form = None
            eligible = [
                (pid, stat) for pid, stat in form_stats.items()
                if stat["matches"] >= 2
            ]
            if eligible:
                pid, stat = max(
                    eligible,
                    key=lambda item: (
                        item[1]["wins"] / item[1]["matches"],
                        item[1]["wins"],
                        item[1]["matches"],
                        float(player_map[item[0]].get("total_points") or 0),
                    )
                )
                in_form = dict(player_map[pid])
                in_form["recent_wins"] = stat["wins"]
                in_form["recent_matches"] = stat["matches"]
                in_form["win_rate"] = round((stat["wins"] / stat["matches"]) * 100, 1)

            # Prefer exact DOB for the youngest-player insight. Legacy records
            # without DOB keep the older age-group fallback until an admin adds DOB.
            dob_candidates = []
            for p in player_map.values():
                dob_text = str(p.get("date_of_birth") or "").strip()
                if not dob_text:
                    continue
                try:
                    dob_value = parse_date_of_birth(dob_text)
                    item = dict(p)
                    item["age"] = calculate_age(dob_text)
                    item["_dob_value"] = dob_value
                    dob_candidates.append(item)
                except ValueError:
                    continue

            youngest = None
            if dob_candidates:
                youngest = max(
                    dob_candidates,
                    key=lambda p: (
                        p["_dob_value"],
                        -int(p.get("rank_position") or 999999),
                        float(p.get("total_points") or 0),
                    )
                )
                youngest.pop("_dob_value", None)
                youngest["age_basis"] = f"{youngest.get('age')} years old · DOB {youngest.get('date_of_birth')}"
            else:
                def age_group_order(value):
                    text = str(value or "").upper().replace(" ", "")
                    match = re.search(r"U(\d{1,2})", text)
                    if match:
                        return int(match.group(1))
                    if text.startswith("JUNIOR"):
                        return 17
                    if "18+" in text or text == "18":
                        return 18
                    return 999

                age_candidates = [p for p in player_map.values() if age_group_order(p.get("age_group")) < 999]
                if age_candidates:
                    age_candidates.sort(key=lambda p: (
                        age_group_order(p.get("age_group")),
                        int(p.get("rank_position") or 999999),
                        -float(p.get("total_points") or 0),
                        str(p.get("full_name") or ""),
                    ))
                    youngest = dict(age_candidates[0])
                    youngest["age_basis"] = f"{youngest.get('age_group') or 'Youth'} age group · DOB not recorded"

            most_active = None
            if player_rows:
                active_candidate = max(
                    (dict(p) for p in player_rows),
                    key=lambda p: (
                        int(p.get("tournaments_played") or 0),
                        float(p.get("total_points") or 0),
                    )
                )
                if int(active_candidate.get("tournaments_played") or 0) > 0:
                    most_active = active_candidate

            tournament_counts = con.execute("""
                SELECT
                    COUNT(*) AS total_tournaments,
                    SUM(CASE WHEN status='Live' THEN 1 ELSE 0 END) AS live_tournaments,
                    SUM(CASE WHEN status='Completed' THEN 1 ELSE 0 END) AS completed_tournaments
                FROM tournaments
            """).fetchone()
            match_counts = con.execute("""
                SELECT
                    COUNT(*) AS total_matches,
                    SUM(CASE WHEN dm.status='Completed' THEN 1 ELSE 0 END) AS completed_matches,
                    SUM(CASE WHEN dm.status='In Progress' THEN 1 ELSE 0 END) AS live_matches
                FROM draw_matches dm
                JOIN draws d ON d.id=dm.draw_id
                WHERE d.tournament_id IS NOT NULL
            """).fetchone()
            event_count = con.execute("""
                SELECT COUNT(*) FROM (
                    SELECT DISTINCT tournament_id,UPPER(COALESCE(event_name,'MS')) AS event_name
                    FROM draws
                    WHERE tournament_id IS NOT NULL
                )
            """).fetchone()[0]

        return jsonify({
            "totalPlayers": total,
            "activePlayers": active,
            "categories": categories,
            "draws": draws,
            "topPlayer": dict(top[0]) if top else None,
            "topPlayers": [dict(row) for row in top],
            "categoryBreakdown": [dict(row) for row in categories_breakdown],
            "recentActivity": [dict(row) for row in recent],
            "insights": {
                "risingPlayer": rising,
                "inFormPlayer": in_form,
                "youngestPlayer": youngest,
                "mostActivePlayer": most_active,
                "youngestBasis": "Exact DOB where recorded; legacy records use their saved age group until DOB is added."
            },
            "tournamentPulse": {
                "totalTournaments": int(tournament_counts["total_tournaments"] or 0),
                "liveTournaments": int(tournament_counts["live_tournaments"] or 0),
                "completedTournaments": int(tournament_counts["completed_tournaments"] or 0),
                "totalMatches": int(match_counts["total_matches"] or 0),
                "completedMatches": int(match_counts["completed_matches"] or 0),
                "liveMatches": int(match_counts["live_matches"] or 0),
                "events": int(event_count or 0),
            },
        })

    @app.route("/api/doubles/teams", methods=["GET"])
    @require_auth
    def list_doubles_teams():
        event=(request.args.get("event") or "").strip().upper()
        with db() as con:
            args=[]; where="WHERE dt.status='Active'"
            if event:
                where+=" AND UPPER(dt.event_name)=?"
                args.append(event)
            rows=con.execute(f"""SELECT dt.*,pa.full_name AS player_a_name,pb.full_name AS player_b_name,
                                       pa.gender AS player_a_gender,pb.gender AS player_b_gender,
                                       pa.category_code AS player_a_category,pb.category_code AS player_b_category,
                                       pa.age_group AS player_a_age_group,pb.age_group AS player_b_age_group
                                FROM doubles_teams dt
                                JOIN players pa ON pa.id=dt.player_a_id
                                JOIN players pb ON pb.id=dt.player_b_id
                                {where}""",args).fetchall()

            completed=con.execute("""SELECT dm.side_a_player_ids,dm.side_b_player_ids,dm.side_a,dm.side_b,dm.winner,d.event_name
                                     FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id
                                     WHERE dm.status='Completed' AND dm.side_b!='Bye'
                                       AND UPPER(COALESCE(d.event_name,'')) IN ('MD','WD','XD')""").fetchall()

            output=[]
            for row in rows:
                item=dict(row)
                ids={int(item["player_a_id"]),int(item["player_b_id"])}
                played=wins=0
                for m in completed:
                    # A partnership only owns results from its own event.
                    if str(m["event_name"] or "").upper() != str(item["event_name"] or "").upper():
                        continue
                    a_ids={int(x) for x in str(m["side_a_player_ids"] or "").split(",") if x.strip().isdigit()}
                    b_ids={int(x) for x in str(m["side_b_player_ids"] or "").split(",") if x.strip().isdigit()}
                    if ids==a_ids or ids==b_ids:
                        played+=1
                        if (ids==a_ids and m["winner"]==m["side_a"]) or (ids==b_ids and m["winner"]==m["side_b"]):
                            wins+=1
                item["total_points"]=float(item.get("total_points") or 0)
                item["matches_played"]=played
                item["wins"]=wins
                item["losses"]=max(0,played-wins)
                item["win_rate"]=round((wins/played)*100,1) if played else 0
                output.append(item)

            # MD, WD and XD are separate ranking tables. Points are the primary
            # ranking key; match wins are only a deterministic tie-breaker.
            output.sort(key=lambda item: (
                str(item.get("event_name") or ""),
                -float(item.get("total_points") or 0),
                -int(item.get("wins") or 0),
                -float(item.get("win_rate") or 0),
                str(item.get("team_name") or "").lower(),
            ))
            positions={}
            for item in output:
                key=str(item.get("event_name") or "").upper()
                positions[key]=positions.get(key,0)+1
                item["rank_position"]=positions[key]
        return jsonify(output)

    @app.route("/api/doubles/teams", methods=["POST"])
    @require_auth
    def create_doubles_team():
        data=request.get_json(silent=True) or {}
        event=(data.get("event_name") or "").strip().upper()
        requested_age=(data.get("age_group") or "All").strip()
        a_id=nullable_int(data.get("player_a_id")); b_id=nullable_int(data.get("player_b_id"))
        if event not in {"MD","WD","XD"}:
            return jsonify({"error":"Doubles team event must be MD, WD or XD."}),400
        if not a_id or not b_id:
            return jsonify({"error":"Select both partners."}),400
        with db() as con:
            a=con.execute("SELECT * FROM players WHERE id=? AND status='Active'",(a_id,)).fetchone()
            bb=con.execute("SELECT * FROM players WHERE id=? AND status='Active'",(b_id,)).fetchone()
            if not a or not bb:return jsonify({"error":"Both partners must be active players."}),400
            a=dict(a); bb=dict(bb)
            error=_validate_doubles_pair(event,a,bb)
            if error:return jsonify({"error":error}),400
            if requested_age != "All" and (not _player_matches_draw_category(a,requested_age) or not _player_matches_draw_category(bb,requested_age)):
                return jsonify({"error":f"Both partners must belong to the selected {requested_age} age category."}),400
            pa,pb=(a,bb) if int(a["id"])<int(bb["id"]) else (bb,a)
            team_name=(data.get("team_name") or f"{a['full_name']} / {bb['full_name']}").strip()
            now=now_iso()
            con.execute("""INSERT INTO doubles_teams(event_name,player_a_id,player_b_id,team_name,status,created_by,created_at,updated_at)
                           VALUES(?,?,?,?,?,?,?,?)
                           ON CONFLICT(event_name,player_a_id,player_b_id)
                           DO UPDATE SET team_name=excluded.team_name,status='Active',updated_at=excluded.updated_at""",
                        (event,pa["id"],pb["id"],team_name,"Active",g.current_user["username"],now,now))
            con.commit()
            row=con.execute("""SELECT dt.*,pa.full_name AS player_a_name,pb.full_name AS player_b_name,
                                      pa.gender AS player_a_gender,pb.gender AS player_b_gender,
                                      pa.age_group AS player_a_age_group,pb.age_group AS player_b_age_group
                               FROM doubles_teams dt JOIN players pa ON pa.id=dt.player_a_id JOIN players pb ON pb.id=dt.player_b_id
                               WHERE dt.event_name=? AND dt.player_a_id=? AND dt.player_b_id=?""",
                            (event,pa["id"],pb["id"])).fetchone()
        return jsonify(dict(row)),201

    @app.route("/api/doubles/teams/<int:team_id>", methods=["PUT"])
    @require_auth
    def update_doubles_team(team_id):
        data=request.get_json(silent=True) or {}
        with db() as con:
            current=con.execute("SELECT * FROM doubles_teams WHERE id=?",(team_id,)).fetchone()
            if not current:
                return jsonify({"error":"Doubles team not found"}),404

            event=(data.get("event_name") or current["event_name"] or "").strip().upper()
            requested_age=(data.get("age_group") or "All").strip()
            a_id=nullable_int(data.get("player_a_id")) or int(current["player_a_id"])
            b_id=nullable_int(data.get("player_b_id")) or int(current["player_b_id"])
            if event not in {"MD","WD","XD"}:
                return jsonify({"error":"Doubles team event must be MD, WD or XD."}),400
            if a_id==b_id:
                return jsonify({"error":"A player cannot be paired with themselves."}),400

            a=con.execute("SELECT * FROM players WHERE id=? AND status='Active'",(a_id,)).fetchone()
            bb=con.execute("SELECT * FROM players WHERE id=? AND status='Active'",(b_id,)).fetchone()
            if not a or not bb:
                return jsonify({"error":"Both partners must be active players."}),400
            a=dict(a); bb=dict(bb)
            error=_validate_doubles_pair(event,a,bb)
            if error:
                return jsonify({"error":error}),400
            if requested_age != "All" and (not _player_matches_draw_category(a,requested_age) or not _player_matches_draw_category(bb,requested_age)):
                return jsonify({"error":f"Both partners must belong to the selected {requested_age} age category."}),400

            pa,pb=(a,bb) if int(a["id"])<int(bb["id"]) else (bb,a)
            conflict=con.execute("""SELECT id FROM doubles_teams
                                    WHERE event_name=? AND player_a_id=? AND player_b_id=? AND id!=?""",
                                 (event,pa["id"],pb["id"],team_id)).fetchone()
            if conflict:
                return jsonify({"error":"That partnership already exists in this doubles event."}),409

            team_name=(data.get("team_name") or f"{a['full_name']} / {bb['full_name']}").strip()
            now=now_iso()
            con.execute("""UPDATE doubles_teams
                           SET event_name=?,player_a_id=?,player_b_id=?,team_name=?,status='Active',updated_at=?
                           WHERE id=?""",
                        (event,pa["id"],pb["id"],team_name,now,team_id))
            con.execute("""INSERT INTO audit_logs(actor,action,entity,entity_id,details,created_at)
                           VALUES(?,?,?,?,?,?)""",
                        (g.current_user["username"],"UPDATE_DOUBLES_TEAM","doubles_teams",team_id,
                         f"{event}: {team_name}",now))
            con.commit()
            row=con.execute("""SELECT dt.*,pa.full_name AS player_a_name,pb.full_name AS player_b_name,
                                      pa.gender AS player_a_gender,pb.gender AS player_b_gender,
                                      pa.age_group AS player_a_age_group,pb.age_group AS player_b_age_group
                               FROM doubles_teams dt
                               JOIN players pa ON pa.id=dt.player_a_id
                               JOIN players pb ON pb.id=dt.player_b_id
                               WHERE dt.id=?""",(team_id,)).fetchone()
        return jsonify(dict(row))

    @app.route("/api/doubles/teams/<int:team_id>/points", methods=["POST"])
    @require_auth
    def add_doubles_team_points(team_id):
        data=request.get_json(silent=True) or {}
        delta=nullable_float(data.get("points_delta"))
        if delta is None:
            return jsonify({"error":"points_delta is required"}),400
        note=(data.get("notes") or "Latest doubles tournament points added").strip()
        with db() as con:
            team=con.execute("SELECT * FROM doubles_teams WHERE id=?",(team_id,)).fetchone()
            if not team:
                return jsonify({"error":"Doubles team not found"}),404
            old_points=float(team["total_points"] or 0)
            new_points=old_points+float(delta)
            if new_points < 0:
                return jsonify({"error":"Doubles team points cannot be below zero."}),400
            now=now_iso()
            con.execute("UPDATE doubles_teams SET total_points=?,updated_at=? WHERE id=?",
                        (new_points,now,team_id))
            con.execute("""INSERT INTO audit_logs(actor,action,entity,entity_id,details,created_at)
                           VALUES(?,?,?,?,?,?)""",
                        (g.current_user["username"],"ADD_DOUBLES_POINTS","doubles_teams",team_id,
                         f"{team['event_name']} {team['team_name']}: {old_points} + {delta} = {new_points}. {note}",now))
            con.commit()
        return jsonify({
            "team_id":team_id,
            "team_name":team["team_name"],
            "event_name":team["event_name"],
            "old_points":old_points,
            "added_points":delta,
            "new_points":new_points,
        })

    @app.route("/api/doubles/teams/<int:team_id>", methods=["DELETE"])
    @require_auth
    def archive_doubles_team(team_id):
        now=now_iso()
        with db() as con:
            team=con.execute("SELECT * FROM doubles_teams WHERE id=?",(team_id,)).fetchone()
            if not team:return jsonify({"error":"Doubles team not found"}),404
            # Soft-delete the saved partnership so historical tournament matches
            # remain untouched while it disappears from active Doubles Team Records.
            con.execute("UPDATE doubles_teams SET status='Archived',updated_at=? WHERE id=?",(now,team_id))
            con.execute("""INSERT INTO audit_logs(actor,action,entity,entity_id,details,created_at)
                           VALUES(?,?,?,?,?,?)""",
                        (g.current_user["username"],"DELETE_DOUBLES_TEAM","doubles_teams",team_id,
                         f"{team['event_name']}: {team['team_name']}",now))
            con.commit()
        return jsonify({"deleted":True,"id":team_id})

    @app.route("/api/categories")
    @require_auth
    def categories():
        with db() as con:
            sync_player_age_categories(con)
            rows = con.execute("""
                SELECT category_code, event_type, gender, age_group, COUNT(*) AS player_count
                FROM players
                WHERE UPPER(COALESCE(category_code,'')) NOT LIKE '%JUNIOR%'
                  AND UPPER(COALESCE(age_group,''))!='JUNIOR'
                GROUP BY category_code, event_type, gender, age_group
                ORDER BY event_type, age_group
            """).fetchall()
        return jsonify([dict(row) for row in rows])

    @app.route("/api/players", methods=["GET"])
    @require_auth
    def list_players():
        category = request.args.get("category", "").strip()
        q = request.args.get("q", "").strip()
        status = request.args.get("status", "").strip()
        sql = "SELECT * FROM players WHERE 1=1"
        args = []
        if category and category != "All":
            sql += " AND category_code = ?"
            args.append(category)
        if status and status != "All":
            sql += " AND status = ?"
            args.append(status)
        if q:
            like = f"%{q}%"
            sql += " AND (full_name LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR club LIKE ? OR category_code LIKE ?)"
            args.extend([like, like, like, like, like])
        sql += " ORDER BY COALESCE(rank_position, 999999), full_name"
        with db() as con:
            sync_player_age_categories(con)
            rows = con.execute(sql, args).fetchall()
        return jsonify([serialize_player(row) for row in rows])

    @app.route("/api/players", methods=["POST"])
    @require_auth
    def create_player():
        data = request.get_json(silent=True) or {}
        if not str(data.get("date_of_birth") or "").strip():
            return jsonify({"error": "Date of birth is required for new player records."}), 400
        try:
            payload = clean_player_payload(data)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        with db() as con:
            cur = con.execute("""
                INSERT INTO players(category_code,event_type,gender,age_group,date_of_birth,club,rank_position,first_name,last_name,full_name,total_points,tournaments_played,status,notes,created_at,updated_at)
                VALUES(:category_code,:event_type,:gender,:age_group,:date_of_birth,:club,:rank_position,:first_name,:last_name,:full_name,:total_points,:tournaments_played,:status,:notes,:created_at,:updated_at)
            """, payload)
            con.commit()
            player = con.execute("SELECT * FROM players WHERE id=?", (cur.lastrowid,)).fetchone()
        return jsonify(serialize_player(player)), 201

    @app.route("/api/players/<int:player_id>", methods=["PUT"])
    @require_auth
    def update_player(player_id):
        data = request.get_json(silent=True) or {}
        with db() as con:
            found = con.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
            if not found:
                return jsonify({"error": "Player not found"}), 404

            # Merge the stored record first so older clients can still edit
            # legacy players while DOB is gradually completed by admins.
            merged = dict(found)
            merged.update(data)
            try:
                payload = clean_player_payload(merged, updating=True)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            payload["id"] = player_id

            con.execute("""
                UPDATE players SET
                    category_code=:category_code,event_type=:event_type,gender=:gender,age_group=:age_group,
                    date_of_birth=:date_of_birth,club=:club,rank_position=:rank_position,first_name=:first_name,last_name=:last_name,
                    full_name=:full_name,total_points=:total_points,tournaments_played=:tournaments_played,
                    status=:status,notes=:notes,updated_at=:updated_at
                WHERE id=:id
            """, payload)
            con.commit()
            player = con.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
        return jsonify(serialize_player(player))


    @app.route("/api/players/<int:player_id>/points", methods=["POST"])
    @require_auth
    def add_player_points(player_id):
        data = request.get_json(silent=True) or {}
        delta = nullable_float(data.get("points_delta"))
        if delta is None:
            return jsonify({"error": "points_delta is required"}), 400
        note = (data.get("notes") or "Latest tournament points added").strip()
        increment_tournament = bool(data.get("increment_tournament", True))
        with db() as con:
            player = con.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
            if not player:
                return jsonify({"error": "Player not found"}), 404
            old_points = float(player["total_points"] or 0)
            new_points = old_points + float(delta)
            tournaments_played = int(player["tournaments_played"] or 0) + (1 if increment_tournament else 0)
            now = now_iso()
            con.execute("""
                UPDATE players
                SET total_points=?, tournaments_played=?, updated_at=?
                WHERE id=?
            """, (new_points, tournaments_played, now, player_id))
            con.execute("""
                INSERT INTO audit_logs(actor, action, entity, entity_id, details, created_at)
                VALUES(?,?,?,?,?,?)
            """, (ADMIN_USERNAME, "ADD_POINTS", "players", player_id,
                  f"{player['full_name']}: {old_points} + {delta} = {new_points}. {note}", now))
            con.commit()
            updated = con.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
        return jsonify({"player": dict(updated), "old_points": old_points, "added_points": delta, "new_points": new_points})

    @app.route("/api/players/<int:player_id>", methods=["DELETE"])
    @require_auth
    def delete_player(player_id):
        with db() as con:
            player = con.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()
            if not player:
                return jsonify({"error": "Player not found"}), 404
            con.execute("DELETE FROM players WHERE id=?", (player_id,))
            con.commit()
        return jsonify({"deleted": True, "player": dict(player)})

    @app.route("/api/players/export.csv")
    @require_auth
    def export_players_csv():
        with db() as con:
            rows = con.execute("SELECT * FROM players ORDER BY COALESCE(rank_position,999999), full_name").fetchall()
        output = io.StringIO()
        writer = csv.writer(output)
        # Export every player field so the downloaded register is a complete record.
        headers = [
            ("Player ID", "id"), ("Source Ranking ID", "source_ranking_id"),
            ("Full Name", "full_name"), ("First Name", "first_name"), ("Last Name", "last_name"),
            ("Gender", "gender"), ("Age Group", "age_group"), ("Event Type", "event_type"),
            ("Category", "category_code"), ("Club", "club"), ("Rank Position", "rank_position"),
            ("Total Points", "total_points"), ("Tournaments Played", "tournaments_played"),
            ("Status", "status"), ("Notes", "notes"), ("Created At", "created_at"),
            ("Updated At", "updated_at")
        ]
        writer.writerow([label for label, _ in headers])
        for row in rows:
            writer.writerow([row[key] for _, key in headers])
        return Response(output.getvalue(), mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=lba_players.csv"})

    @app.route("/api/players/export.xlsx")
    @require_auth
    def export_players_xlsx():
        with db() as con:
            rows = con.execute("SELECT * FROM players ORDER BY COALESCE(rank_position,999999), full_name").fetchall()
        # Keep the Excel register complete: include all fields stored for each player.
        # Human-readable labels keep the workbook understandable to tournament staff.
        header_map = [
            ("Player ID", "id"), ("Source Ranking ID", "source_ranking_id"),
            ("Full Name", "full_name"), ("First Name", "first_name"), ("Last Name", "last_name"),
            ("Gender", "gender"), ("Age Group", "age_group"), ("Event Type", "event_type"),
            ("Category", "category_code"), ("Club", "club"), ("Rank Position", "rank_position"),
            ("Total Points", "total_points"), ("Tournaments Played", "tournaments_played"),
            ("Status", "status"), ("Notes", "notes"), ("Created At", "created_at"),
            ("Updated At", "updated_at")
        ]
        headers = [label for label, _ in header_map]
        keys = [key for _, key in header_map]

        wb = Workbook()
        wb.properties.title = "LBA Official Player Register"
        wb.properties.subject = "Lesotho Badminton Association player register"
        wb.properties.creator = "LBA Admin System"

        ws = wb.active
        ws.title = "Official Player Register"
        ws.sheet_view.showGridLines = False
        ws.freeze_panes = "A2"
        ws.append(headers)

        # Professional register header.
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF", size=10)
            cell.fill = PatternFill("solid", fgColor="0F766E")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.border = Border(
                bottom=Side(style="medium", color="0B5F59")
            )
        ws.row_dimensions[1].height = 30

        for row in rows:
            ws.append([row[key] for key in keys])

        # Make the register easy to read and print.
        from openpyxl.utils import get_column_letter
        from openpyxl.worksheet.table import Table, TableStyleInfo
        widths = [11, 18, 30, 18, 20, 12, 12, 20, 15, 24, 14, 14, 20, 13, 42, 22, 22]
        for i, width in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = width

        for row in ws.iter_rows(min_row=2):
            row[0].alignment = Alignment(horizontal="center")
            row[1].alignment = Alignment(horizontal="center")
            row[5].alignment = Alignment(horizontal="center")
            row[6].alignment = Alignment(horizontal="center")
            row[8].alignment = Alignment(horizontal="center")
            row[10].alignment = Alignment(horizontal="center")
            row[11].number_format = "0.00"
            row[12].alignment = Alignment(horizontal="center")
            row[13].alignment = Alignment(horizontal="center")
            row[14].alignment = Alignment(vertical="top", wrap_text=True)
            row[15].alignment = Alignment(horizontal="center")
            row[16].alignment = Alignment(horizontal="center")

        if ws.max_row >= 2:
            table = Table(displayName="LBAPlayerRegister", ref=f"A1:{get_column_letter(ws.max_column)}{ws.max_row}")
            table.tableStyleInfo = TableStyleInfo(
                name="TableStyleMedium4",
                showFirstColumn=False,
                showLastColumn=False,
                showRowStripes=True,
                showColumnStripes=False,
            )
            ws.add_table(table)

        ws.auto_filter.ref = ws.dimensions
        ws.print_title_rows = "1:1"
        ws.page_setup.orientation = "landscape"
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        ws.oddFooter.center.text = "Lesotho Badminton Association • Official Player Register"
        ws.oddFooter.right.text = "Page &P of &N"

        buf = io.BytesIO()
        wb.save(buf); buf.seek(0)
        return Response(buf.getvalue(), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition":"attachment; filename=lba_players.xlsx"})

    @app.route("/api/players/import-template.xlsx")
    @require_auth
    def import_template():
        wb = Workbook()
        ws = wb.active; ws.title = "Players"
        headers = ["full_name","first_name","last_name","gender","age_group","event_type","category_code","club","rank_position","total_points","tournaments_played","status","notes"]
        ws.append(headers)
        ws.append(["Example Player","Example","Player","Men","U15","Men's Singles","MS,U15","LBA Club",1,100,0,"Active",""])
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF"); cell.fill = PatternFill("solid", fgColor="0F766E")
        ws.freeze_panes = "A2"
        for col in ws.columns:
            ws.column_dimensions[col[0].column_letter].width = min(max(max(len(str(c.value or "")) for c in col)+2,12),34)
        buf = io.BytesIO()
        wb.save(buf); buf.seek(0)
        return Response(buf.getvalue(), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition":"attachment; filename=lba_import_template.xlsx"})

    @app.route("/api/import/excel", methods=["POST"])
    @require_auth
    def import_excel():
        if "file" not in request.files:
            return jsonify({"error": "Upload an Excel file using field name 'file'"}), 400
        file = request.files["file"]
        try:
            imported, skipped = import_workbook(file)
        except Exception as exc:
            return jsonify({"error": f"Could not read Excel file: {exc}"}), 400
        return jsonify({"imported": imported, "skipped": skipped})

    @app.route("/api/draws/random", methods=["POST"])
    @require_auth
    def random_draw():
        data=request.get_json(silent=True) or {}
        return random_draw_impl(data)

    def random_draw_impl(data):
        title = (data.get("title") or "Random Draw").strip()
        category = (data.get("category_code") or "All").strip()
        draw_type = (data.get("draw_type") or "Singles").strip()
        seed_by_rank = bool(data.get("seed_by_rank", False))
        selected_ids = [nullable_int(pid) for pid in (data.get("player_ids") or [])]
        selected_ids = [pid for pid in selected_ids if pid is not None]
        raw_pairs = data.get("pairs") or []
        save_pairs = bool(data.get("save_pairs", True))
        tournament_id=nullable_int(data.get("tournament_id"))
        event_name=(data.get("event_name") or "").strip()
        requested_round=(data.get("round_name") or "").strip()
        with db() as con:
            sync_player_age_categories(con)
            if tournament_id and not con.execute("SELECT id FROM tournaments WHERE id=?",(tournament_id,)).fetchone():
                return jsonify({"error":"Tournament not found"}),404
            if tournament_id:
                # A tournament can contain multiple independent event draws (MS, WS, MD, WD, XD).
                event_key=(event_name or "MS").strip().upper()
                existing=con.execute("SELECT id FROM draws WHERE tournament_id=? AND round_number=1 AND UPPER(COALESCE(event_name,''))=?",(tournament_id,event_key)).fetchone()
                if existing:return jsonify({"error":f"A Round 1 draw already exists for {event_key} in this tournament."}),409
            if selected_ids:
                placeholders=",".join("?" for _ in selected_ids)
                players=[dict(row) for row in con.execute(f"SELECT * FROM players WHERE status='Active' AND id IN ({placeholders})",selected_ids).fetchall()]
                order={pid:i for i,pid in enumerate(selected_ids)}; players.sort(key=lambda row:order.get(row["id"],999999))
            else:
                args=[]; sql="SELECT * FROM players WHERE status='Active'"
                if category and category!="All": sql+=" AND category_code=?"; args.append(category)
                players=[dict(row) for row in con.execute(sql,args).fetchall()]

            explicit_pairs=[]
            if draw_type.lower()=="doubles" and raw_pairs:
                used=set()
                for index,pair in enumerate(raw_pairs,1):
                    a_id=nullable_int(pair.get("player_a_id"))
                    b_id=nullable_int(pair.get("player_b_id"))
                    if not a_id or not b_id:
                        return jsonify({"error":f"Team {index} needs two partners."}),400
                    if a_id in used or b_id in used:
                        return jsonify({"error":f"A player is used more than once in the {event_name or 'doubles'} team list."}),400
                    a=con.execute("SELECT * FROM players WHERE id=? AND status='Active'",(a_id,)).fetchone()
                    bb=con.execute("SELECT * FROM players WHERE id=? AND status='Active'",(b_id,)).fetchone()
                    if not a or not bb:
                        return jsonify({"error":f"Team {index} contains an unavailable player."}),400
                    a=dict(a); bb=dict(bb)
                    error=_validate_doubles_pair(event_name,a,bb)
                    if error:
                        return jsonify({"error":f"Team {index}: {error}"}),400
                    if category and category!="All" and (not _player_matches_draw_category(a,category) or not _player_matches_draw_category(bb,category)):
                        return jsonify({"error":f"Team {index}: both partners must belong to the selected {category} age/category."}),400
                    used.update([a_id,b_id])
                    pa,pb=(a,bb) if int(a["id"])<int(bb["id"]) else (bb,a)
                    team_name=f"{a['full_name']} / {bb['full_name']}"
                    team_id=None
                    if save_pairs:
                        now_team=now_iso()
                        con.execute("""INSERT INTO doubles_teams(event_name,player_a_id,player_b_id,team_name,status,created_by,created_at,updated_at)
                                       VALUES(?,?,?,?,?,?,?,?)
                                       ON CONFLICT(event_name,player_a_id,player_b_id)
                                       DO UPDATE SET team_name=excluded.team_name,status='Active',updated_at=excluded.updated_at""",
                                    ((event_name or "MD").upper(),pa["id"],pb["id"],team_name,"Active",g.current_user["username"],now_team,now_team))
                        row_team=con.execute("SELECT id FROM doubles_teams WHERE event_name=? AND player_a_id=? AND player_b_id=?",
                                             ((event_name or "MD").upper(),pa["id"],pb["id"])).fetchone()
                        team_id=row_team["id"] if row_team else None
                    explicit_pairs.append({"name":team_name,"ids":f"{a_id},{b_id}","team_id":team_id})
                if len(explicit_pairs)<2:
                    return jsonify({"error":"Select at least two complete doubles teams for a knockout draw."}),400

            if draw_type.lower()!="doubles" and len(players)<2:
                return jsonify({"error":"Select at least two players for a knockout tournament."}),400
            if draw_type.lower()=="doubles" and not explicit_pairs and len(players)<4:
                return jsonify({"error":"Select at least four players (two teams) for a doubles knockout tournament."}),400

            if seed_by_rank and not explicit_pairs:
                players.sort(key=lambda x:(x.get("rank_position") is None,x.get("rank_position") or 999999))
            elif not explicit_pairs:
                import random; random.shuffle(players)
            elif not seed_by_rank:
                import random; random.shuffle(explicit_pairs)

            fixtures=build_fixtures(players,draw_type,explicit_pairs or None)
            if not fixtures:
                return jsonify({"error":"This event needs at least two complete entrants/teams. Doubles requires complete pairs."}),400
            slots=len(fixtures)*2
            stage={2:"Final",4:"Semifinal",8:"Quarterfinal",16:"Round of 16",32:"Round of 32",64:"Round of 64"}.get(slots,f"Round of {slots}")
            round_name=stage
            now=now_iso()
            cur=con.execute("""INSERT INTO draws(title,category_code,draw_type,created_at,tournament_id,event_name,round_name,round_number,stage,created_by)
                               VALUES(?,?,?,?,?,?,?,?,?,?)""",
                            (title,category,draw_type,now,tournament_id,event_name,round_name,1,stage,g.current_user["username"]))
            draw_id=cur.lastrowid
            for fixture in fixtures:
                code=f"{tournament_id and 'LBA' or 'DRAW'}-{tournament_id or draw_id:02d}-{draw_id:03d}-{fixture['match_no']:03d}"
                is_bye=fixture["side_b"]=="Bye"
                con.execute("""INSERT INTO draw_matches(draw_id,match_no,side_a,side_b,side_a_player_ids,side_b_player_ids,status,winner,match_code,result_entered_by,result_entered_at)
                               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                            (draw_id,fixture["match_no"],fixture["side_a"],fixture["side_b"],fixture["side_a_player_ids"],fixture["side_b_player_ids"],
                             "Completed" if is_bye else "Pending",fixture["side_a"] if is_bye else None,code,
                             "SYSTEM" if is_bye else None,now if is_bye else None))
            if tournament_id:
                con.execute("UPDATE tournaments SET status='Draw Generated',updated_at=? WHERE id=?",(now,tournament_id))
                con.execute("INSERT INTO tournament_audit(tournament_id,actor,action,details,created_at) VALUES(?,?,?,?,?)",
                            (tournament_id,g.current_user["username"],"DRAW_GENERATED",f"{round_name}: {len(players)} participant(s), {len(fixtures)} match(es)",now))
            con.execute("INSERT INTO audit_logs(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)",
                        (g.current_user["username"],"GENERATE_DRAW","draws",draw_id,f"{title}: {len(players)} selected participant(s), {len(fixtures)} match(es)",now))
            con.commit(); draw=get_draw(con,draw_id); draw["selected_player_count"]=len(players); draw["selected_team_count"]=len(explicit_pairs) if explicit_pairs else None
        return jsonify(draw),201



    @app.route("/api/draws")
    @require_auth
    def list_draws():
        with db() as con:
            rows = con.execute("SELECT * FROM draws ORDER BY id DESC").fetchall()
        return jsonify([dict(row) for row in rows])

    @app.route("/api/draws/<int:draw_id>")
    @require_auth
    def read_draw(draw_id):
        with db() as con:
            draw = get_draw(con, draw_id)
            if not draw:
                return jsonify({"error": "Draw not found"}), 404
        return jsonify(draw)

    @app.route("/api/draws/<int:draw_id>/export.pdf")
    @require_auth
    def export_draw_pdf(draw_id):
        with db() as con:
            draw = get_draw(con, draw_id)
            if not draw:
                return jsonify({"error": "Draw not found"}), 404

            if draw.get("tournament_id"):
                tournament=con.execute("SELECT * FROM tournaments WHERE id=?",(draw["tournament_id"],)).fetchone()
                event_name=(draw.get("event_name") or "MS").upper()
                cutoff=int(draw.get("round_number") or 1)
                rows=con.execute("""SELECT dm.*,d.event_name,d.round_name,d.round_number,d.stage,d.draw_type,d.category_code
                                    FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id
                                    WHERE d.tournament_id=? AND UPPER(COALESCE(d.event_name,'MS'))=? AND d.round_number<=?
                                    ORDER BY d.round_number,dm.match_no,dm.id""",
                                 (draw["tournament_id"],event_name,cutoff)).fetchall()
                matches=[]
                for row in rows:
                    item=dict(row)
                    item["games"]=[dict(gm) for gm in con.execute("SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",(row["id"],)).fetchall()]
                    matches.append(item)
                pdf_bytes=build_progressive_bracket_pdf(dict(tournament),event_name,matches,cutoff_round=cutoff)
                first_count=len([m for m in matches if int(m.get("round_number") or 1)==1 and not (m.get("stage")=="Final" and int(m.get("match_no") or 0)==3)])
                expected=max(1, first_count // (2 ** max(0, cutoff - 1)))
                stage=_bracket_stage(expected * 2)
                filename=safe_filename(f"{tournament['name']}_{event_name}_{stage}_draw.pdf")
            else:
                pdf_bytes = build_draw_pdf(draw)
                filename = safe_filename(f"{draw['title'] or 'lba_draw'}_{draw['id']}.pdf")

        return Response(
            pdf_bytes,
            mimetype="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    @app.route("/api/tournaments/<int:tournament_id>/bracket.pdf")
    @require_auth
    def export_tournament_bracket(tournament_id):
        event_name=(request.args.get("event") or "MS").strip().upper()
        requested_round=nullable_int(request.args.get("round"))
        with db() as con:
            tournament=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not tournament:
                return jsonify({"error":"Tournament not found"}),404
            rows=con.execute("""SELECT dm.*,d.event_name,d.round_name,d.round_number,d.stage,d.draw_type,d.category_code
                                FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id
                                WHERE d.tournament_id=? AND UPPER(COALESCE(d.event_name,'MS'))=?
                                ORDER BY d.round_number,dm.match_no,dm.id""",
                             (tournament_id,event_name)).fetchall()
            if not rows:
                return jsonify({"error":f"No {event_name} draw exists in this tournament."}),404
            matches=[]
            for row in rows:
                item=dict(row)
                item["games"]=[dict(gm) for gm in con.execute("SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",(row["id"],)).fetchall()]
                matches.append(item)
            latest=max(int(m.get("round_number") or 1) for m in matches)
            cutoff=max(1,min(requested_round or latest,latest))
            pdf_bytes=build_progressive_bracket_pdf(dict(tournament),event_name,matches,cutoff_round=cutoff)
            stage=_bracket_stage(max(2,len([m for m in matches if int(m.get("round_number") or 1)==cutoff])*2))
            filename=safe_filename(f"{tournament['name']}_{event_name}_{stage}_draw.pdf")
        return Response(pdf_bytes,mimetype="application/pdf",headers={"Content-Disposition":f"attachment; filename={filename}"})

    @app.route("/api/tournaments", methods=["GET"])
    @require_auth
    def list_tournaments():
        with db() as con:
            rows = con.execute("""
                SELECT t.*,
                       COUNT(DISTINCT d.id) AS draw_count,
                       COUNT(DISTINCT CASE WHEN dm.status='Completed' THEN dm.id END) AS completed_matches,
                       COUNT(DISTINCT dm.id) AS total_matches
                FROM tournaments t
                LEFT JOIN draws d ON d.tournament_id=t.id
                LEFT JOIN draw_matches dm ON dm.draw_id=d.id
                GROUP BY t.id
                ORDER BY t.id DESC
            """).fetchall()
        return jsonify([dict(row) for row in rows])

    @app.route("/api/tournaments", methods=["POST"])
    @require_auth
    def create_tournament():
        data=request.get_json(silent=True) or {}
        name=(data.get("name") or "").strip()
        if not name:
            return jsonify({"error":"Tournament name is required"}),400
        code=(data.get("tournament_code") or "").strip().upper()
        if not code:
            base=re.sub(r"[^A-Z0-9]+","-",name.upper()).strip("-")
            code=f"{base[:24] or 'LBA-TOURNAMENT'}-{datetime.now(ZoneInfo('Africa/Maseru')).strftime('%Y%m%d%H%M%S')[-6:]}"
        now=now_iso()
        with db() as con:
            try:
                cur=con.execute("""
                    INSERT INTO tournaments(tournament_code,name,venue,start_date,end_date,status,description,created_by,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)
                """,(code,name,(data.get("venue") or "").strip(),(data.get("start_date") or "").strip(),
                    (data.get("end_date") or "").strip(),"Draft",(data.get("description") or "").strip(),
                    g.current_user["username"],now,now))
            except sqlite3.IntegrityError:
                return jsonify({"error":"Tournament code already exists"}),409
            tid=cur.lastrowid
            con.execute("INSERT INTO audit_logs(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)",
                        (g.current_user["username"],"CREATE_TOURNAMENT","tournaments",tid,f"{name} ({code})",now))
            con.commit()
            row=con.execute("SELECT * FROM tournaments WHERE id=?",(tid,)).fetchone()
        return jsonify(dict(row)),201

    @app.route("/api/tournaments/<int:tournament_id>", methods=["GET"])
    @require_auth
    def get_tournament(tournament_id):
        with db() as con:
            t=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not t: return jsonify({"error":"Tournament not found"}),404
            draws=con.execute("""
                SELECT * FROM draws
                WHERE tournament_id=?
                ORDER BY round_number, id
            """,(tournament_id,)).fetchall()
            matches=con.execute("""
                SELECT dm.*, d.event_name, d.round_name AS draw_round, d.title AS draw_title,
                       d.round_number, d.stage
                FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id
                WHERE d.tournament_id=?
                ORDER BY d.round_number, dm.match_no, dm.id
            """,(tournament_id,)).fetchall()
            history=con.execute("SELECT * FROM tournament_audit WHERE tournament_id=? ORDER BY id DESC",(tournament_id,)).fetchall()
            data=dict(t)
            data["draws"]=[dict(x) for x in draws]
            data["matches"]=[]
            for m in matches:
                md=dict(m)
                games=con.execute("SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",(m["id"],)).fetchall()
                md["games"]=[dict(x) for x in games]
                data["matches"].append(md)

            # Podium is computed from recorded knockout results and is also
            # persisted when the administrator declares the tournament finished.
            final=next((m for m in data["matches"] if m.get("stage")=="Final" and m.get("status")=="Completed"),None)
            third=next((m for m in data["matches"] if m.get("stage")=="Final" and m.get("match_no")==3 and m.get("status")=="Completed"),None)
            podium={"first":data.get("winner_name"),"second":data.get("runner_up_name"),"third":data.get("third_place_name"),"third_players":[]}
            if final:
                podium["first"]=final.get("winner")
                podium["second"]=final.get("side_b") if final.get("winner")==final.get("side_a") else final.get("side_a")
            semis=[m for m in data["matches"] if m.get("stage")=="Semifinal" and m.get("status")=="Completed" and m.get("side_b")!="Bye"]
            if third:
                podium["third"]=third.get("winner")
                podium["third_players"]=[third.get("winner")]
            elif semis:
                losers=[]
                for s in semis:
                    if s.get("winner")==s.get("side_a"):
                        losers.append(s.get("side_b"))
                    else:
                        losers.append(s.get("side_a"))
                podium["third_players"]=[x for x in losers if x]
                if len(podium["third_players"])==1:
                    podium["third"]=podium["third_players"][0]
            data["podium"]=podium
            try:
                data["event_podiums"]=json.loads(data.get("event_podiums") or "{}")
            except Exception:
                data["event_podiums"]={}
            data["server_time"]=now_iso()
            data["timezone"]="Africa/Maseru (SAST, UTC+02:00)"
            data["history"]=[dict(x) for x in history]
        return jsonify(data)

    @app.route("/api/tournaments/<int:tournament_id>/archive", methods=["POST"])
    @require_auth
    def archive_tournament(tournament_id):
        data=request.get_json(silent=True) or {}
        archived=1 if bool(data.get("archived", True)) else 0
        now=now_iso()
        with db() as con:
            tournament=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not tournament:
                return jsonify({"error":"Tournament not found"}),404
            con.execute("UPDATE tournaments SET is_archived=?,updated_at=? WHERE id=?",(archived,now,tournament_id))
            con.execute("INSERT INTO tournament_audit(tournament_id,actor,action,details,created_at) VALUES(?,?,?,?,?)",
                        (tournament_id,g.current_user["username"],
                         "TOURNAMENT_ARCHIVED" if archived else "TOURNAMENT_RESTORED",
                         "Archived from active tournament list" if archived else "Restored to active tournament list",now))
            con.commit()
            row=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
        return jsonify(dict(row))

    @app.route("/api/tournaments/<int:tournament_id>", methods=["PUT"])
    @require_auth
    def update_tournament(tournament_id):
        data=request.get_json(silent=True) or {}
        with db() as con:
            t=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not t: return jsonify({"error":"Tournament not found"}),404
            status=(data.get("status") or t["status"]).strip()
            allowed_status={"Draft","Draw Generated","Live","Ready to Finish","Completed","Archived"}
            if status not in allowed_status: return jsonify({"error":"Invalid tournament status"}),400
            now=now_iso()
            con.execute("""UPDATE tournaments SET name=?,venue=?,start_date=?,end_date=?,status=?,description=?,updated_at=? WHERE id=?""",
                        ((data.get("name") or t["name"]).strip(),(data.get("venue") if data.get("venue") is not None else t["venue"]) or "",
                         (data.get("start_date") if data.get("start_date") is not None else t["start_date"]) or "",
                         (data.get("end_date") if data.get("end_date") is not None else t["end_date"]) or "",
                         status,(data.get("description") if data.get("description") is not None else t["description"]) or "",now,tournament_id))
            con.execute("INSERT INTO tournament_audit(tournament_id,actor,action,details,created_at) VALUES(?,?,?,?,?)",
                        (tournament_id,g.current_user["username"],"TOURNAMENT_UPDATED",f"Status: {status}",now))
            con.commit()
            row=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
        return jsonify(dict(row))

    @app.route("/api/tournaments/<int:tournament_id>/draw", methods=["POST"])
    @require_auth
    def tournament_draw(tournament_id):
        data=request.get_json(silent=True) or {}
        data["tournament_id"]=tournament_id
        return random_draw_impl(data)

    @app.route("/api/tournaments/<int:tournament_id>/next-round", methods=["POST"])
    @require_auth
    def tournament_next_round(tournament_id):
        data=request.get_json(silent=True) or {}
        now=now_iso()
        with db() as con:
            t=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not t:return jsonify({"error":"Tournament not found"}),404
            if t["status"]=="Completed": return jsonify({"error":"Tournament is already finished."}),400
            requested_event=(data.get("event_name") or "").strip().upper()
            if requested_event:
                latest=con.execute("SELECT * FROM draws WHERE tournament_id=? AND UPPER(COALESCE(event_name,''))=? ORDER BY round_number DESC,id DESC LIMIT 1",(tournament_id,requested_event)).fetchone()
            else:
                latest=con.execute("SELECT * FROM draws WHERE tournament_id=? ORDER BY round_number DESC,id DESC LIMIT 1",(tournament_id,)).fetchone()
            if not latest:return jsonify({"error":"Generate the first draw for this event before creating the next round."}),400
            pending=con.execute("""SELECT COUNT(*) FROM draw_matches WHERE draw_id=? AND status!='Completed'""",(latest["id"],)).fetchone()[0]
            if pending:
                return jsonify({"error":f"Round {latest['round_number']} still has {pending} unfinished match(es). Record every result before creating the next round."}),400

            existing=con.execute("SELECT id FROM draws WHERE tournament_id=? AND UPPER(COALESCE(event_name,''))=? AND round_number>?",(tournament_id,(latest["event_name"] or requested_event or "MS").upper(),latest["round_number"])).fetchone()
            if existing:return jsonify({"error":"The next round for this event has already been generated."}),409

            matches=con.execute("SELECT * FROM draw_matches WHERE draw_id=? ORDER BY match_no",(latest["id"],)).fetchall()
            winners=[]
            losers=[]
            for m in matches:
                if m["winner"] and m["winner"]!="Bye":
                    ids=(m["side_a_player_ids"] if m["winner"]==m["side_a"] else m["side_b_player_ids"]) or ""
                    winners.append({"name":m["winner"],"ids":ids})
                if m["status"]=="Completed" and m["side_b"]!="Bye":
                    loser=m["side_b"] if m["winner"]==m["side_a"] else m["side_a"]
                    ids=(m["side_b_player_ids"] if m["winner"]==m["side_a"] else m["side_a_player_ids"]) or ""
                    losers.append({"name":loser,"ids":ids})

            if len(winners)<=1:
                return jsonify({"error":"There is no second opponent available. The current winner is the tournament champion."}),400

            round_number=int(latest["round_number"] or 1)+1
            if len(winners)==2:
                stage="Final"
            else:
                slots=1
                while slots < len(winners): slots*=2
                stage={2:"Semifinal",4:"Quarterfinal",8:"Round of 16",16:"Round of 32",32:"Round of 64"}.get(slots,f"Round of {slots}")
            title=f"{t['name']} — {stage}"
            event_name=data.get("event_name") or latest["event_name"] or "Singles"
            draw_type=data.get("draw_type") or latest["draw_type"] or "Singles"

            # Preserve bracket paths: M1/M2 feed the first next-round
            # match, M3/M4 feed the second, and so on. Never reshuffle winners.
            fixtures=[]
            for i in range(0,len(winners),2):
                a=winners[i]
                b=winners[i+1] if i+1<len(winners) else {"name":"Bye","ids":""}
                fixtures.append((a,b))

            cur=con.execute("""INSERT INTO draws(title,category_code,draw_type,created_at,tournament_id,event_name,round_name,round_number,stage,created_by)
                               VALUES(?,?,?,?,?,?,?,?,?,?)""",
                            (title,latest["category_code"],draw_type,now,tournament_id,event_name,stage,round_number,stage,g.current_user["username"]))
            draw_id=cur.lastrowid
            for idx,(a,b) in enumerate(fixtures,1):
                code=f"LBA-{tournament_id:02d}-{draw_id:03d}-{idx:03d}"
                status="Completed" if b["name"]=="Bye" else "Pending"
                winner=a["name"] if b["name"]=="Bye" else None
                con.execute("""INSERT INTO draw_matches(draw_id,match_no,side_a,side_b,side_a_player_ids,side_b_player_ids,status,winner,match_code,result_entered_by,result_entered_at)
                               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                            (draw_id,idx,a["name"],b["name"],a["ids"],b["ids"],status,winner,code,
                             "SYSTEM" if winner else None,now if winner else None))

            # When the current stage is a true two-match semifinal, create the
            # bronze match from the two semifinal losers alongside the final.
            if latest["stage"]=="Semifinal" and len(losers)==2 and len(winners)==2:
                code=f"LBA-{tournament_id:02d}-{draw_id:03d}-003"
                a,b=losers
                con.execute("""INSERT INTO draw_matches(draw_id,match_no,side_a,side_b,side_a_player_ids,side_b_player_ids,status,match_code)
                               VALUES(?,?,?,?,?,?,?,?)""",
                            (draw_id,3,a["name"],b["name"],a["ids"],b["ids"],"Pending",code))

            con.execute("UPDATE tournaments SET status='Live',updated_at=? WHERE id=?",(now,tournament_id))
            con.execute("INSERT INTO tournament_audit(tournament_id,actor,action,details,created_at) VALUES(?,?,?,?,?)",
                        (tournament_id,g.current_user["username"],"ROUND_GENERATED",f"Round {round_number}: {stage} ({len(fixtures)} advancement match(es))",now))
            con.commit()
            row=con.execute("SELECT * FROM draws WHERE id=?",(draw_id,)).fetchone()
        return jsonify(dict(row)),201

    @app.route("/api/tournaments/<int:tournament_id>/finish", methods=["POST"])
    @require_auth
    def finish_tournament(tournament_id):
        now=now_iso()
        with db() as con:
            t=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not t:return jsonify({"error":"Tournament not found"}),404
            if t["status"]=="Completed": return jsonify(dict(t))

            event_rows=con.execute("SELECT DISTINCT COALESCE(NULLIF(event_name,''),'MS') AS event_name FROM draws WHERE tournament_id=? ORDER BY event_name",(tournament_id,)).fetchall()
            if not event_rows:return jsonify({"error":"Generate at least one event draw before finishing the tournament."}),400

            event_podiums={}
            missing=[]
            for er in event_rows:
                event_name=er["event_name"]
                final=con.execute("SELECT dm.* FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id WHERE d.tournament_id=? AND UPPER(COALESCE(d.event_name,'MS'))=? AND d.stage='Final' AND dm.status='Completed' ORDER BY d.round_number DESC,dm.id DESC LIMIT 1",(tournament_id,event_name.upper())).fetchone()
                if not final:
                    missing.append(event_name)
                    continue

                third=con.execute("SELECT dm.* FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id WHERE d.tournament_id=? AND UPPER(COALESCE(d.event_name,'MS'))=? AND d.stage='Final' AND dm.match_no=3 AND dm.status='Completed' ORDER BY d.round_number DESC,dm.id DESC LIMIT 1",(tournament_id,event_name.upper())).fetchone()
                third_name=third["winner"] if third else None

                if not third_name:
                    semis=con.execute("SELECT dm.* FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id WHERE d.tournament_id=? AND UPPER(COALESCE(d.event_name,'MS'))=? AND d.stage='Semifinal' AND dm.status='Completed' AND dm.side_b!='Bye' ORDER BY d.round_number DESC,dm.id",(tournament_id,event_name.upper())).fetchall()
                    if len(semis)==1:
                        s=semis[0]
                        third_name=s["side_b"] if s["winner"]==s["side_a"] else s["side_a"]
                    elif len(semis)>=2:
                        losers=[s["side_b"] if s["winner"]==s["side_a"] else s["side_a"] for s in semis[:2]]
                        third_name=" & ".join([z for z in losers if z])

                runner=final["side_b"] if final["winner"]==final["side_a"] else final["side_a"]
                event_podiums[event_name]={"first":final["winner"],"second":runner,"third":third_name}

            if missing:
                return jsonify({"error":"Every event draw must have a completed final before the tournament can be declared finished.","events_pending":missing,"completed_events":sorted(event_podiums.keys())}),400

            legacy_first=next(iter(event_podiums.values()))["first"] if len(event_podiums)==1 else "See event podiums"
            legacy_second=next(iter(event_podiums.values()))["second"] if len(event_podiums)==1 else "See event podiums"
            legacy_third=next(iter(event_podiums.values()))["third"] if len(event_podiums)==1 else "See event podiums"
            con.execute("UPDATE tournaments SET status='Completed',winner_name=?,runner_up_name=?,third_place_name=?,event_podiums=?,finished_by=?,finished_at=?,updated_at=? WHERE id=?",(legacy_first,legacy_second,legacy_third,json.dumps(event_podiums,separators=(",",":")),g.current_user["username"],now,now,tournament_id))
            con.execute("INSERT INTO tournament_audit(tournament_id,actor,action,details,created_at) VALUES(?,?,?,?,?)",(tournament_id,g.current_user["username"],"TOURNAMENT_FINISHED",json.dumps({"event_podiums":event_podiums},separators=(",",":")),now))
            con.commit()
            row=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
        return jsonify({**dict(row),"event_podiums":event_podiums})

    @app.route("/api/matches/<int:match_id>", methods=["GET"])
    @require_auth
    def get_match(match_id):
        with db() as con:
            m=con.execute("""
                SELECT dm.*,d.tournament_id,d.event_name,d.round_name,d.title AS draw_title,t.name AS tournament_name,t.tournament_code
                FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id
                LEFT JOIN tournaments t ON t.id=d.tournament_id WHERE dm.id=?
            """,(match_id,)).fetchone()
            if not m:return jsonify({"error":"Match not found"}),404
            data=dict(m)
            data["games"]=[dict(x) for x in con.execute("SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",(match_id,)).fetchall()]
        return jsonify(data)

    @app.route("/api/matches/<int:match_id>/result", methods=["POST"])
    @require_auth
    def record_match_result(match_id):
        data=request.get_json(silent=True) or {}
        raw_games=data.get("games") or []
        if not isinstance(raw_games,list) or not raw_games:return jsonify({"error":"At least one game score is required"}),400
        games=[]
        a_wins=b_wins=0
        for i,gme in enumerate(raw_games[:3],1):
            raw_a=gme.get("side_a_score"); raw_b=gme.get("side_b_score")
            try:
                num_a=float(raw_a); num_b=float(raw_b)
            except (TypeError,ValueError):
                return jsonify({"error":f"Invalid score for game {i}"}),400
            if not num_a.is_integer() or not num_b.is_integer():
                return jsonify({"error":f"Game {i} scores must be whole numbers."}),400
            a=int(num_a); b=int(num_b)
            if a<0 or b<0:
                return jsonify({"error":f"Game {i} scores cannot be negative."}),400
            if a>30 or b>30:
                return jsonify({"error":f"Game {i} scores cannot exceed 30."}),400
            if a==b:return jsonify({"error":f"Game {i} cannot end in a tie."}),400
            high=max(a,b); low=min(a,b)
            valid=(high==21 and low<=19) or (20<=low<high<=29 and high-low>=2) or (high==30 and low in range(0,30))
            if not valid:return jsonify({"error":f"Game {i} is not a valid badminton score. Use 21 points, win by 2 after 20-all, with 30 as the cap."}),400
            games.append((i,a,b))
            if a>b:a_wins+=1
            else:b_wins+=1
            if a_wins==2 or b_wins==2:break
        # A completed game can be saved immediately while the match is still
        # in progress. The match becomes Completed only when one side reaches
        # two game wins.
        completed=max(a_wins,b_wins)>=2
        status="Completed" if completed else "In Progress"

        now=now_iso()
        with db() as con:
            m=con.execute("SELECT dm.*,d.tournament_id,d.event_name,d.round_name,d.round_number,d.title,d.stage,t.name AS tournament_name FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id LEFT JOIN tournaments t ON t.id=d.tournament_id WHERE dm.id=?",(match_id,)).fetchone()
            if not m:return jsonify({"error":"Match not found"}),404
            if m["side_b"]=="Bye":return jsonify({"error":"A bye does not require a result."}),400
            previous=con.execute("SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",(match_id,)).fetchall()
            con.execute("DELETE FROM match_games WHERE match_id=?",(match_id,))
            for n,a,b in games:
                con.execute("INSERT INTO match_games(match_id,game_number,side_a_score,side_b_score,created_at,updated_at) VALUES(?,?,?,?,?,?)",(match_id,n,a,b,now,now))
            winner=(m["side_a"] if a_wins>b_wins else m["side_b"]) if completed else None

            # Once a later round has been generated, the feeder winner is
            # locked. Scores may still be corrected as long as the winner does
            # not change, protecting the bracket path already in use.
            if m["tournament_id"] and m["status"]=="Completed":
                later=con.execute("""SELECT 1 FROM draws
                                     WHERE tournament_id=?
                                       AND UPPER(COALESCE(event_name,'MS'))=UPPER(?)
                                       AND round_number>?
                                     LIMIT 1""",
                                  (m["tournament_id"],m["event_name"] or "MS",m["round_number"] or 1)).fetchone()
                invalidates_path=(status!="Completed") or (winner and m["winner"] and winner!=m["winner"])
                if later and invalidates_path:
                    return jsonify({"error":"This result already feeds a later-round match. You may correct the score only if the winner stays the same."}),409

            con.execute("""UPDATE draw_matches SET winner=?,status=?,result_entered_by=?,result_entered_at=COALESCE(result_entered_at,?),result_updated_at=? WHERE id=?""",
                        (winner,status,g.current_user["username"],now,now,match_id))
            action=("RESULT_UPDATED" if previous else "RESULT_RECORDED") if completed else "LIVE_SCORE_UPDATED"
            detail=json.dumps({"previous":[dict(x) for x in previous],"games":[{"game":n,"a":a,"b":b} for n,a,b in games],"winner":winner,"status":status},separators=(",",":"))
            con.execute("INSERT INTO tournament_audit(tournament_id,match_id,actor,action,details,created_at) VALUES(?,?,?,?,?,?)",
                        (m["tournament_id"],match_id,g.current_user["username"],action,detail,now))
            con.execute("INSERT INTO audit_logs(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)",
                        (g.current_user["username"],action,"draw_matches",match_id,f"{m['side_a']} vs {m['side_b']} -> {winner or status}",now))
            if m["tournament_id"]:
                con.execute("UPDATE tournaments SET status='Live',updated_at=? WHERE id=? AND status!='Completed'",(now,m["tournament_id"]))
            con.commit()
            result={"match_id":match_id,"winner":winner,"games":[{"game_number":n,"side_a_score":a,"side_b_score":b} for n,a,b in games],"games_won":{"side_a":a_wins,"side_b":b_wins},"status":status,"recorded_by":g.current_user["username"],"recorded_at":now}
        return jsonify(result)

    @app.route("/api/tournaments/<int:tournament_id>/executive-draws.pdf")
    @require_auth
    def export_tournament_executive_draws(tournament_id):
        with db() as con:
            tournament=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not tournament:
                return jsonify({"error":"Tournament not found"}),404

            rows=con.execute("""SELECT dm.*,d.event_name,d.round_name,d.round_number,d.stage,d.draw_type,d.category_code
                                FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id
                                WHERE d.tournament_id=?
                                ORDER BY CASE UPPER(COALESCE(d.event_name,'MS'))
                                    WHEN 'MS' THEN 1 WHEN 'WS' THEN 2 WHEN 'MD' THEN 3 WHEN 'WD' THEN 4 WHEN 'XD' THEN 5 ELSE 9 END,
                                    d.round_number,dm.match_no,dm.id""",
                             (tournament_id,)).fetchall()
            if not rows:
                return jsonify({"error":"This tournament does not have any event draws yet."}),404

            event_matches={}
            for row in rows:
                item=dict(row)
                item["games"]=[dict(gm) for gm in con.execute(
                    "SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",
                    (row["id"],)
                ).fetchall()]
                event=(item.get("event_name") or "MS").upper()
                event_matches.setdefault(event,[]).append(item)

        pdf_bytes=build_executive_draw_pack_pdf(dict(tournament),event_matches)
        filename=safe_filename(f"{tournament['name']}_Executive_Draw_Pack.pdf")
        return Response(
            pdf_bytes,
            mimetype="application/pdf",
            headers={"Content-Disposition":f"attachment; filename={filename}"}
        )

    @app.route("/api/tournaments/<int:tournament_id>/scoresheets.pdf")
    @require_auth
    def export_tournament_scoresheets(tournament_id):
        with db() as con:
            t=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not t:return jsonify({"error":"Tournament not found"}),404
            matches=con.execute("""SELECT dm.*,d.tournament_id,d.event_name,d.round_name,d.stage,d.round_number FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id WHERE d.tournament_id=? ORDER BY d.round_number,dm.match_no""",(tournament_id,)).fetchall()
            payload=dict(t); payload["matches"]=[dict(m) for m in matches]
        return Response(build_scoresheets_pdf(payload),mimetype="application/pdf",headers={"Content-Disposition":f"attachment; filename={safe_filename(t['name'])}_scoresheets.pdf"})

    @app.route("/api/tournaments/<int:tournament_id>/export.xlsx")
    @require_auth
    def export_tournament_xlsx(tournament_id):
        with db() as con:
            t=con.execute("SELECT * FROM tournaments WHERE id=?",(tournament_id,)).fetchone()
            if not t:return jsonify({"error":"Tournament not found"}),404
            rows=con.execute("""SELECT dm.*,d.event_name,d.round_name,d.title AS draw_title,d.round_number,d.stage
                                FROM draw_matches dm JOIN draws d ON d.id=dm.draw_id
                                WHERE d.tournament_id=? ORDER BY d.round_number,dm.match_no""",(tournament_id,)).fetchall()
        wb=Workbook()
        ws=wb.active; ws.title="Tournament Summary"
        ws.append(["Tournament Code","Tournament","Venue","Start Date","End Date","Status","1st Place","2nd Place","3rd Place","Finished By","Finished At"])
        ws.append([t["tournament_code"],t["name"],t["venue"],t["start_date"],t["end_date"],t["status"],t["winner_name"] or "",t["runner_up_name"] or "",t["third_place_name"] or "",t["finished_by"] or "",t["finished_at"] or ""])
        for c in ws[1]: c.font=Font(bold=True,color="FFFFFF"); c.fill=PatternFill("solid",fgColor="0F766E")
        ms=wb.create_sheet("All Matches")
        ms.append(["Round #","Stage","Match ID","Event","Player A","Player B","Status","Winner","Recorded By","Recorded At","Game 1","Game 2","Game 3"])
        for c in ms[1]: c.font=Font(bold=True,color="FFFFFF"); c.fill=PatternFill("solid",fgColor="0F766E")
        with db() as con:
            for m in rows:
                games=con.execute("SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",(m["id"],)).fetchall()
                vals=[m["round_number"] or 1,m["stage"] or m["round_name"] or "",f"{t['tournament_code']}-{m['id']:04d}",m["event_name"] or "",m["side_a"],m["side_b"],m["status"],m["winner"] or "",m["result_entered_by"] or "",m["result_updated_at"] or ""]
                vals += [f"{g['side_a_score']}-{g['side_b_score']}" for g in games[:3]]
                while len(vals)<13: vals.append("")
                ms.append(vals)
        # A separate sheet per round makes the exported workbook easy to print.
        round_numbers=sorted({int(m["round_number"] or 1) for m in rows})
        for rn in round_numbers:
            rs=wb.create_sheet(f"Round {rn}")
            rs.append(["Match ID","Stage","Event","Player A","Player B","Status","Winner","Recorded At","Game 1","Game 2","Game 3"])
            for c in rs[1]: c.font=Font(bold=True,color="FFFFFF"); c.fill=PatternFill("solid",fgColor="047857")
            for m in rows:
                if int(m["round_number"] or 1)!=rn: continue
                games=con.execute("SELECT game_number,side_a_score,side_b_score FROM match_games WHERE match_id=? ORDER BY game_number",(m["id"],)).fetchall()
                vals=[f"{t['tournament_code']}-{m['id']:04d}",m["stage"] or "",m["event_name"] or "",m["side_a"],m["side_b"],m["status"],m["winner"] or "",m["result_updated_at"] or ""]
                vals += [f"{g['side_a_score']}-{g['side_b_score']}" for g in games[:3]]
                while len(vals)<11: vals.append("")
                rs.append(vals)
        buf=io.BytesIO(); wb.save(buf); buf.seek(0)
        return Response(buf.getvalue(),mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",headers={"Content-Disposition":f"attachment; filename={safe_filename(t['name'])}_tournament.xlsx"})



    @app.route("/api/draws/<int:draw_id>", methods=["DELETE"])
    @require_auth
    def delete_draw(draw_id):
        with db() as con:
            con.execute("DELETE FROM draw_matches WHERE draw_id=?", (draw_id,))
            con.execute("DELETE FROM draws WHERE id=?", (draw_id,))
            con.commit()
        return jsonify({"deleted": True})

    return app


def send_email(to_address, subject, body):
    # Railway deployments may block outbound SMTP connections. Prefer an HTTPS
    # email API when configured, while retaining SMTP as a fallback for local use.
    if RESEND_API_KEY:
        payload = json.dumps({
            "from": EMAIL_FROM,
            "to": [to_address],
            "subject": subject,
            "text": body,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
                "User-Agent": "LBA-Mobile-App/1.0",
            },
            method="POST",
        )
        print(f"[EMAIL] Resend email attempt: to={to_address!r}, subject={subject!r}", flush=True)
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                detail = response.read().decode("utf-8", errors="replace")
                print(f"[EMAIL] Resend response status: {response.status}", flush=True)
                print(f"[EMAIL] Resend response body: {detail[:1000]}", flush=True)
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f"Email API returned HTTP {response.status}")
                return
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            print(f"[EMAIL] Resend HTTP error: status={exc.code}, body={detail[:1000]}", flush=True)
            raise RuntimeError(f"Email API returned HTTP {exc.code}: {detail[:500]}") from exc
        except urllib.error.URLError as exc:
            print(f"[EMAIL] Resend email exception: {exc.reason!r}", flush=True)
            raise RuntimeError(f"Could not reach email API: {exc.reason}") from exc
        except Exception as exc:
            print(f"[EMAIL] Resend email exception: {type(exc).__name__}: {exc}", flush=True)
            raise

    if not SMTP_HOST or not SMTP_USERNAME or not SMTP_PASSWORD or not SMTP_FROM:
        raise RuntimeError(
            "Email service is not configured. Set RESEND_API_KEY and LBA_EMAIL_FROM, "
            "or configure the LBA_SMTP_* variables."
        )

    message = EmailMessage()
    message["From"] = SMTP_FROM
    message["To"] = to_address
    message["Subject"] = subject
    message.set_content(body)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
        server.starttls()
        server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.send_message(message)


def bearer_token():
    auth = request.headers.get("Authorization", "")
    return auth.replace("Bearer ", "", 1).strip()


def public_user(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "email": row["email"],
        "full_name": row["full_name"],
        "role": row["role"],
        "is_active": bool(row["is_active"]),
        "email_verified": bool(row["email_verified"]),
        "created_at": row["created_at"],
        "last_login": row["last_login"],
    }


def require_auth(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        token = bearer_token()
        if not token:
            return jsonify({"error": "Unauthorized"}), 401

        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with db() as con:
            user = con.execute("""
                SELECT u.*
                FROM auth_tokens t
                JOIN users u ON u.id = t.user_id
                WHERE t.token_hash=?
                  AND t.expires_at > ?
                  AND u.is_active=1
            """, (token_hash, now_iso())).fetchone()

        if not user:
            return jsonify({"error": "Unauthorized"}), 401

        g.current_user = user
        return func(*args, **kwargs)
    return wrapper


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def now_iso():
    return datetime.now(ZoneInfo("Africa/Maseru")).replace(microsecond=0).isoformat()


def ensure_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as con:
        # Backward-compatible columns for existing draw records.
        for column, definition in [
            ("tournament_id", "INTEGER"), ("event_name", "TEXT"), ("round_name", "TEXT"),
        ]:
            try:
                con.execute(f"ALTER TABLE draws ADD COLUMN {column} {definition}")
            except sqlite3.OperationalError:
                pass
        for column, definition in [
            ("match_code", "TEXT"), ("court", "TEXT"), ("result_entered_by", "TEXT"),
            ("result_entered_at", "TEXT"), ("result_updated_at", "TEXT"),
        ]:
            try:
                con.execute(f"ALTER TABLE draw_matches ADD COLUMN {column} {definition}")
            except sqlite3.OperationalError:
                pass
        # Date of birth is the only age source for new manually-created players.
        # Existing databases are migrated in-place without disturbing legacy records.
        try:
            con.execute("ALTER TABLE players ADD COLUMN date_of_birth TEXT")
        except sqlite3.OperationalError:
            pass
        # Tournament archive is an organisation flag; status and historical
        # tournament results remain unchanged.
        try:
            con.execute("ALTER TABLE tournaments ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass

        # Doubles rankings use their own team points, separate from singles/player points.
        # Existing saved partnerships start at zero and keep all match-history statistics.
        try:
            con.execute("ALTER TABLE doubles_teams ADD COLUMN total_points REAL DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        con.executescript("""
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_ranking_id INTEGER,
            category_code TEXT,
            event_type TEXT,
            gender TEXT,
            age_group TEXT,
            date_of_birth TEXT,
            club TEXT,
            rank_position INTEGER,
            first_name TEXT,
            last_name TEXT,
            full_name TEXT NOT NULL,
            total_points REAL DEFAULT 0,
            tournaments_played INTEGER DEFAULT 0,
            status TEXT DEFAULT 'Active',
            notes TEXT,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS tournaments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            venue TEXT,
            start_date TEXT,
            end_date TEXT,
            status TEXT NOT NULL DEFAULT 'Draft',
            description TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            winner_name TEXT,
            runner_up_name TEXT,
            third_place_name TEXT,
            finished_by TEXT,
            finished_at TEXT,
            event_podiums TEXT,
            is_archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS match_games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id INTEGER NOT NULL,
            game_number INTEGER NOT NULL,
            side_a_score INTEGER,
            side_b_score INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(match_id, game_number),
            FOREIGN KEY(match_id) REFERENCES draw_matches(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS tournament_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id INTEGER NOT NULL,
            match_id INTEGER,
            actor TEXT,
            action TEXT NOT NULL,
            details TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
            FOREIGN KEY(match_id) REFERENCES draw_matches(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS doubles_teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            player_a_id INTEGER NOT NULL,
            player_b_id INTEGER NOT NULL,
            team_name TEXT NOT NULL,
            total_points REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'Active',
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(event_name, player_a_id, player_b_id),
            FOREIGN KEY(player_a_id) REFERENCES players(id) ON DELETE CASCADE,
            FOREIGN KEY(player_b_id) REFERENCES players(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_doubles_teams_event ON doubles_teams(event_name,status);
        CREATE TABLE IF NOT EXISTS draws (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            category_code TEXT,
            draw_type TEXT,
            created_at TEXT NOT NULL,
            tournament_id INTEGER,
            event_name TEXT,
            round_name TEXT,
            round_number INTEGER DEFAULT 1,
            stage TEXT,
            created_by TEXT
        );
        CREATE TABLE IF NOT EXISTS draw_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            draw_id INTEGER NOT NULL,
            match_no INTEGER NOT NULL,
            side_a TEXT NOT NULL,
            side_b TEXT NOT NULL,
            side_a_player_ids TEXT,
            side_b_player_ids TEXT,
            winner TEXT,
            status TEXT DEFAULT 'Pending',
            FOREIGN KEY(draw_id) REFERENCES draws(id)
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor TEXT,
            action TEXT,
            entity TEXT,
            entity_id INTEGER,
            details TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            full_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'Viewer',
            is_active INTEGER NOT NULL DEFAULT 1,
            email_verified INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_login TEXT
        );
        CREATE TABLE IF NOT EXISTS auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);
        CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
        CREATE TABLE IF NOT EXISTS email_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            token_type TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);
        CREATE INDEX IF NOT EXISTS idx_match_games_match ON match_games(match_id);
        CREATE INDEX IF NOT EXISTS idx_tournament_audit_tournament ON tournament_audit(tournament_id);

        """)
        # Tournament schema migrations for databases created before the knockout workflow.
        for table, column, definition in [
            ("tournaments", "winner_name", "TEXT"),
            ("tournaments", "runner_up_name", "TEXT"),
            ("tournaments", "third_place_name", "TEXT"),
            ("tournaments", "finished_by", "TEXT"),
            ("tournaments", "finished_at", "TEXT"),
            ("tournaments", "event_podiums", "TEXT"),
            ("draws", "round_number", "INTEGER DEFAULT 1"),
            ("draws", "stage", "TEXT"),
            ("draws", "created_by", "TEXT"),
        ]:
            try:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            except sqlite3.OperationalError:
                pass
        con.execute("UPDATE draws SET round_number=COALESCE(round_number,1)")
        con.execute("UPDATE draws SET stage=COALESCE(stage,round_name,'Round 1')")
        admin = con.execute("SELECT id FROM users WHERE username=?", (ADMIN_USERNAME,)).fetchone()
        if not admin and ADMIN_PASSWORD:
            now = now_iso()
            con.execute("""
                INSERT INTO users(username,email,full_name,password_hash,role,is_active,email_verified,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)
            """, (
                ADMIN_USERNAME,
                os.environ.get("LBA_ADMIN_EMAIL", "admin@lba.local"),
                "LBA Administrator",
                generate_password_hash(ADMIN_PASSWORD),
                "Super Admin",
                1,
                1,
                now,
                now,
            ))

        count = con.execute("SELECT COUNT(*) FROM players").fetchone()[0]
        has_combined = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='combined_rankings'").fetchone()
        if count == 0 and has_combined:
            now = now_iso()
            con.execute("""
                INSERT INTO players(source_ranking_id,category_code,event_type,gender,age_group,club,rank_position,first_name,last_name,full_name,total_points,tournaments_played,status,created_at,updated_at)
                SELECT id, category_code, event_type, gender, age_group, COALESCE(club,''), rank_position, first_name, last_name, full_name,
                       COALESCE(total_points,0), COALESCE(tournaments_played,0), 'Active', ?, ?
                FROM combined_rankings
            """, (now, now))
        con.commit()


def parse_date_of_birth(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dob = datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        raise ValueError("Date of birth must use YYYY-MM-DD format.")
    today = datetime.now(ZoneInfo("Africa/Maseru")).date()
    if dob > today:
        raise ValueError("Date of birth cannot be in the future.")
    age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
    if age < 0 or age > 120:
        raise ValueError("Enter a valid date of birth.")
    return dob


def calculate_age(date_of_birth):
    dob = parse_date_of_birth(date_of_birth)
    if not dob:
        return None
    today = datetime.now(ZoneInfo("Africa/Maseru")).date()
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def age_group_from_age(age):
    if age is None:
        return None
    if age <= 10:
        return "U11"
    if age <= 12:
        return "U13"
    if age <= 14:
        return "U15"
    if age <= 16:
        return "U17"
    return "18+"


def category_from_gender_age(gender, age_group, fallback_category=""):
    gender_text = str(gender or "").strip().lower()
    fallback = str(fallback_category or "").strip().upper()
    if gender_text in {"men", "male", "boy", "boys"}:
        prefix = "MS"
    elif gender_text in {"women", "woman", "female", "girl", "girls"}:
        prefix = "WS"
    elif fallback.startswith("MS"):
        prefix = "MS"
    elif fallback.startswith("WS"):
        prefix = "WS"
    else:
        return fallback_category or "Uncategorised"
    return f"{prefix},{age_group}" if age_group else prefix


def classify_player_age(gender, date_of_birth, fallback_category=""):
    age = calculate_age(date_of_birth)
    if age is None:
        return None
    age_group = age_group_from_age(age)
    category_code = category_from_gender_age(gender, age_group, fallback_category)
    return {
        "age": age,
        "age_group": age_group,
        "category_code": category_code,
        "event_type": infer_event_type(category_code),
    }


def serialize_player(row):
    item = dict(row)
    dob = item.get("date_of_birth")
    if dob:
        try:
            item["age"] = calculate_age(dob)
        except ValueError:
            item["age"] = None
    else:
        item["age"] = None
    return item


def sync_player_age_categories(con):
    """Promote DOB-backed players to the correct age category as time passes."""
    rows = con.execute("""
        SELECT id,gender,date_of_birth,category_code,age_group,event_type
        FROM players
        WHERE date_of_birth IS NOT NULL AND TRIM(date_of_birth)!=''
    """).fetchall()
    changed = 0
    now = now_iso()
    for row in rows:
        try:
            classification = classify_player_age(
                row["gender"], row["date_of_birth"], row["category_code"]
            )
        except ValueError:
            continue
        if not classification:
            continue
        category_code = classification["category_code"]
        age_group = classification["age_group"]
        event_type = classification["event_type"]
        if (
            str(row["category_code"] or "") != str(category_code or "")
            or str(row["age_group"] or "") != str(age_group or "")
            or str(row["event_type"] or "") != str(event_type or "")
        ):
            con.execute("""
                UPDATE players
                SET category_code=?,age_group=?,event_type=?,updated_at=?
                WHERE id=?
            """, (category_code, age_group, event_type, now, row["id"]))
            changed += 1
    if changed:
        con.commit()
    return changed


def clean_player_payload(data, updating=False):
    full_name = (data.get("full_name") or data.get("name") or "").strip()
    first_name = (data.get("first_name") or "").strip()
    last_name = (data.get("last_name") or "").strip()
    if not full_name:
        full_name = f"{first_name} {last_name}".strip()
    if not full_name:
        raise ValueError("full_name is required")
    if not first_name and full_name:
        parts = full_name.split()
        first_name = parts[0]
        last_name = " ".join(parts[1:]) if len(parts) > 1 else last_name

    date_of_birth = str(data.get("date_of_birth") or "").strip()
    category_code = (data.get("category_code") or data.get("category") or "Uncategorised").strip()
    gender = (data.get("gender") or infer_gender(category_code)).strip()

    classification = None
    if date_of_birth:
        # Validation is intentional here: DOB becomes the source of truth for
        # age group and singles category rather than manual age/category text.
        parse_date_of_birth(date_of_birth)
        classification = classify_player_age(gender, date_of_birth, category_code)

    if classification:
        category_code = classification["category_code"]
        age_group = classification["age_group"]
        event_type = classification["event_type"]
    else:
        event_type = (data.get("event_type") or infer_event_type(category_code)).strip()
        age_group = (data.get("age_group") or infer_age_group(category_code)).strip()

    now = now_iso()
    return {
        "category_code": category_code,
        "event_type": event_type,
        "gender": gender,
        "age_group": age_group,
        "date_of_birth": date_of_birth or None,
        "club": (data.get("club") or "").strip(),
        "rank_position": nullable_int(data.get("rank_position", data.get("rank"))),
        "first_name": first_name,
        "last_name": last_name,
        "full_name": full_name,
        "total_points": nullable_float(data.get("total_points", data.get("points"))) or 0,
        "tournaments_played": nullable_int(data.get("tournaments_played")) or 0,
        "status": data.get("status") or "Active",
        "notes": data.get("notes") or "",
        "created_at": now,
        "updated_at": now,
    }


def nullable_int(value):
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return None


def nullable_float(value):
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def infer_gender(category):
    text = (category or "").upper()
    if text.startswith("WS") or "WOM" in text:
        return "Women"
    if text.startswith("MS") or "MEN" in text:
        return "Men"
    return "Open"


def infer_event_type(category):
    text = (category or "").upper()
    if text.startswith("WS"):
        return "Women's Singles"
    if text.startswith("MS"):
        return "Men's Singles"
    if "XD" in text or "MIX" in text:
        return "Mixed Doubles"
    if "D" in text:
        return "Doubles"
    return "Singles"


def infer_age_group(category):
    text = (category or "").upper().replace(" ", "")
    for age in ["U11", "U13", "U15", "U17", "U19", "18+"]:
        if age in text:
            return age
    return "Open"


def _gender_bucket(player):
    gender = str(player.get("gender") or "").strip().lower()
    event_type = str(player.get("event_type") or "").strip().lower()
    if gender in {"men","male","boys","boy"} or "men's" in event_type or "boys" in event_type:
        return "M"
    if gender in {"women","female","girls","girl"} or "women's" in event_type or "girls" in event_type:
        return "W"
    return "O"


def _validate_doubles_pair(event_name, player_a, player_b):
    event=(event_name or "").upper()
    if not player_a or not player_b:
        return "Both partners are required."
    if int(player_a["id"]) == int(player_b["id"]):
        return "A player cannot be paired with themselves."
    ga=_gender_bucket(player_a); gb=_gender_bucket(player_b)
    if event=="MD" and (ga!="M" or gb!="M"):
        return "MD requires two male/boys players."
    if event=="WD" and (ga!="W" or gb!="W"):
        return "WD requires two female/girls players."
    if event=="XD" and set([ga,gb]) != {"M","W"}:
        return "XD requires one male/boys player and one female/girls player."
    return None


def _player_matches_draw_category(player, selected_category):
    selected=str(selected_category or "").strip().upper()
    if not selected or selected=="ALL":
        return True
    category=str(player.get("category_code") or "").strip().upper()
    age=str(player.get("age_group") or "").strip().upper()
    if selected==category or selected==age:
        return True
    # Accept a full singles category (e.g. WS,U15) and an age-only doubles
    # selection (e.g. U15) as the same age band when appropriate.
    selected_age=infer_age_group(selected).upper()
    return selected_age!="OPEN" and selected_age==age


def build_fixtures(players, draw_type, doubles_pairs=None):
    """Build a true power-of-two knockout bracket.

    Every entrant gets a fixed path through the draw. When the entrant count is
    not a power of two, byes are assigned in Round 1 instead of changing the
    bracket shape. This keeps Quarterfinal -> Semifinal -> Final paths stable.
    """
    if draw_type.lower() == "doubles":
        entrants = []
        if doubles_pairs:
            for pair in doubles_pairs:
                entrants.append({
                    "name": pair["name"],
                    "ids": pair["ids"],
                    "team_id": pair.get("team_id")
                })
        else:
            # Backward compatibility for older clients. The current tournament
            # UI sends explicit admin-selected pairs instead of relying on order.
            for i in range(0, len(players), 2):
                a = players[i]
                b = players[i + 1] if i + 1 < len(players) else None
                if not b:
                    continue
                entrants.append({
                    "name": f"{a['full_name']} / {b['full_name']}",
                    "ids": f"{a['id']},{b['id']}"
                })
    else:
        entrants = [{"name": p["full_name"], "ids": str(p["id"])} for p in players]

    if len(entrants) < 2:
        return []

    slots = 1
    while slots < len(entrants):
        slots *= 2
    bye_count = slots - len(entrants)

    # Put each bye against a real entrant first, then pair the remaining
    # entrants. This prevents Bye-vs-Bye fixtures and preserves a full bracket.
    fixture_pairs = []
    cursor = 0
    for _ in range(bye_count):
        fixture_pairs.append((entrants[cursor], {"name": "Bye", "ids": ""}))
        cursor += 1
    while cursor < len(entrants):
        a = entrants[cursor]
        b = entrants[cursor + 1]
        fixture_pairs.append((a, b))
        cursor += 2

    fixtures = []
    for a, b in fixture_pairs:
        fixtures.append({
            "match_no": len(fixtures) + 1,
            "side_a": a["name"],
            "side_b": b["name"],
            "side_a_player_ids": a["ids"],
            "side_b_player_ids": b["ids"]
        })
    return fixtures


def get_draw(con, draw_id):
    row = con.execute("SELECT * FROM draws WHERE id=?", (draw_id,)).fetchone()
    if not row:
        return None
    matches = con.execute("SELECT * FROM draw_matches WHERE draw_id=? ORDER BY match_no", (draw_id,)).fetchall()
    data = dict(row)
    data["matches"] = [dict(match) for match in matches]
    return data


def safe_filename(name):
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("_")
    return cleaned or "lba_draw.pdf"


def build_scoresheets_pdf(tournament):
    buffer=io.BytesIO()
    doc=SimpleDocTemplate(buffer,pagesize=A4,rightMargin=14*mm,leftMargin=14*mm,topMargin=12*mm,bottomMargin=12*mm,title=f"{tournament.get('name','LBA Tournament')} Scoresheets")
    styles=getSampleStyleSheet(); title=styles["Title"]; title.fontName="Helvetica-Bold"; title.fontSize=16
    normal=styles["BodyText"]; normal.fontSize=9; normal.leading=12
    story=[]
    for index,m in enumerate(tournament.get("matches") or []):
        if index:
            from reportlab.platypus import PageBreak
            story.append(PageBreak())
        if LOGO_PATH.exists():
            try: story.append(Image(str(LOGO_PATH),width=22*mm,height=22*mm))
            except Exception: pass
        story += [Paragraph("Lesotho Badminton Association",title),Paragraph("Official Match Scoresheet",styles["Heading2"]),Spacer(1,4*mm)]
        meta=[[ "Tournament",tournament.get("name","-") ],["Event",m.get("event_name") or "-"],["Round",m.get("round_name") or "-"],["Match ID",m.get("match_code") or f"{tournament.get('tournament_code','LBA')}-{m.get('id')}"],["Court",m.get("court") or "________"]]
        tab=Table(meta,colWidths=[35*mm,145*mm]); tab.setStyle(TableStyle([("BACKGROUND",(0,0),(0,-1),colors.HexColor("#f1f5f9")),("FONTNAME",(0,0),(0,-1),"Helvetica-Bold"),("BOX",(0,0),(-1,-1),.7,colors.HexColor("#cbd5e1")),("INNERGRID",(0,0),(-1,-1),.4,colors.HexColor("#e2e8f0")),("PADDING",(0,0),(-1,-1),6)])); story.append(tab); story.append(Spacer(1,6*mm))
        players=Table([["PLAYER A","PLAYER B"],[m.get("side_a") or "-",m.get("side_b") or "-"]],colWidths=[90*mm,90*mm])
        players.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),colors.HexColor("#0f172a")),("TEXTCOLOR",(0,0),(-1,0),colors.white),("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"),("ALIGN",(0,0),(-1,-1),"CENTER"),("BOX",(0,0),(-1,-1),.7,colors.HexColor("#cbd5e1")),("INNERGRID",(0,0),(-1,-1),.4,colors.HexColor("#e2e8f0")),("PADDING",(0,0),(-1,-1),9)])); story.append(players); story.append(Spacer(1,7*mm))
        score=Table([["Game","Player A","Player B"]]+[[str(i),"________","________"] for i in range(1,4)],colWidths=[30*mm,75*mm,75*mm])
        score.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),colors.HexColor("#047857")),("TEXTCOLOR",(0,0),(-1,0),colors.white),("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"),("ALIGN",(0,0),(-1,-1),"CENTER"),("BOX",(0,0),(-1,-1),.7,colors.HexColor("#cbd5e1")),("INNERGRID",(0,0),(-1,-1),.4,colors.HexColor("#e2e8f0")),("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white,colors.HexColor("#f8fafc")]),("PADDING",(0,0),(-1,-1),9)])); story.append(score); story.append(Spacer(1,8*mm))
        sig=Table([["Winner:","____________________________"],["Official:","____________________________"],["Signature:","____________________________"],["Date:","____________________________"]],colWidths=[35*mm,145*mm]); sig.setStyle(TableStyle([("FONTNAME",(0,0),(0,-1),"Helvetica-Bold"),("BOX",(0,0),(-1,-1),.7,colors.HexColor("#cbd5e1")),("INNERGRID",(0,0),(-1,-1),.4,colors.HexColor("#e2e8f0")),("PADDING",(0,0),(-1,-1),7)])); story.append(sig)
        story.append(Spacer(1,7*mm)); story.append(Paragraph("Keep this sheet with the official tournament records. The Match ID links this paper record to the digital result.",normal))
    doc.build(story); buffer.seek(0); return buffer.getvalue()

def build_draw_pdf(draw):
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title=draw.get("title") or "LBA Draw",
    )
    styles = getSampleStyleSheet()
    story = []

    title_style = styles["Title"]
    title_style.fontName = "Helvetica-Bold"
    title_style.fontSize = 18
    title_style.leading = 22
    title_style.textColor = colors.HexColor("#0f172a")

    normal = styles["BodyText"]
    normal.fontName = "Helvetica"
    normal.fontSize = 9
    normal.leading = 12

    small = styles["BodyText"]
    small.fontName = "Helvetica"
    small.fontSize = 8
    small.leading = 10
    small.textColor = colors.HexColor("#475569")

    heading_style = styles["Heading2"]
    heading_style.textColor = colors.HexColor("#047857")
    heading_style.spaceAfter = 4

    logo_path = BASE_DIR.parent / "frontend" / "src" / "assets" / "lba-logo.png"
    if logo_path.exists():
        try:
            story.append(Image(str(logo_path), width=26 * mm, height=26 * mm))
            story.append(Spacer(1, 3 * mm))
        except Exception:
            pass

    story.append(Paragraph("Lesotho Badminton Association", title_style))
    story.append(Paragraph("Official Tournament Draw Sheet", heading_style))
    story.append(Spacer(1, 5 * mm))

    meta = [
        ["Draw title", draw.get("title") or "-", "Draw type", draw.get("draw_type") or "-"],
        ["Category", draw.get("category_code") or "All", "Created", draw.get("created_at") or "-"],
        ["Draw ID", str(draw.get("id") or "-"), "Matches", str(len(draw.get("matches") or []))],
    ]
    meta_table = Table(meta, colWidths=[25 * mm, 65 * mm, 25 * mm, 65 * mm])
    meta_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 7 * mm))

    # Present the draw in normal sports language rather than database terminology.
    # A doubles fixture already contains both players on each side, e.g.
    # "Player A / Player B vs Player C / Player D".
    match_rows = [["Match", "Players", "Winner / Score"]]
    for match in draw.get("matches") or []:
        player_a = str(match.get("side_a") or "-")
        player_b = str(match.get("side_b") or "-")
        fixture = f"{player_a}  vs.  {player_b}"
        match_rows.append([
            str(match.get("match_no") or ""),
            Paragraph(fixture, normal),
            "",
        ])

    table = Table(match_rows, colWidths=[18 * mm, 124 * mm, 40 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(table)
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph("Prepared by LBA Admin System. Keep this file as the official draw record for the tournament.", small))

    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()



def _bracket_stage(slots):
    return {
        2: "Final",
        4: "Semifinal",
        8: "Quarterfinal",
        16: "Round of 16",
        32: "Round of 32",
        64: "Round of 64",
        128: "Round of 128",
    }.get(slots, f"Round of {slots}")


def _pdf_fit_text(c, text, font_name, font_size, max_width):
    value = str(text or "")
    if c.stringWidth(value, font_name, font_size) <= max_width:
        return value
    suffix = "..."
    while value and c.stringWidth(value + suffix, font_name, font_size) > max_width:
        value = value[:-1]
    return (value + suffix) if value else suffix


def _prepare_progressive_bracket(event_name, matches, cutoff_round=None):
    event_name = (event_name or "MS").upper()
    filtered = [
        dict(m) for m in (matches or [])
        if (m.get("event_name") or "MS").upper() == event_name
        and not (m.get("stage") == "Final" and int(m.get("match_no") or 0) == 3)
    ]
    if not filtered:
        raise ValueError(f"No matches found for {event_name}.")

    first_round = sorted(
        [m for m in filtered if int(m.get("round_number") or 1) == 1],
        key=lambda m: (int(m.get("match_no") or 0), int(m.get("id") or 0))
    )
    first_count = len(first_round)
    if first_count < 1:
        raise ValueError("The event does not contain a first-round draw.")

    total_rounds = 1
    count = first_count
    while count > 1:
        total_rounds += 1
        count = max(1, count // 2)

    available_rounds = [int(m.get("round_number") or 1) for m in filtered]
    latest_round = max(available_rounds) if available_rounds else 1
    cutoff_round = max(1, min(int(cutoff_round or latest_round), total_rounds))

    rounds = []
    for round_index in range(total_rounds):
        round_number = round_index + 1
        expected = max(1, first_count // (2 ** round_index))
        actual = sorted(
            [
                m for m in filtered
                if int(m.get("round_number") or 1) == round_number
                and round_number <= cutoff_round
            ],
            key=lambda m: (int(m.get("match_no") or 0), int(m.get("id") or 0))
        )
        stage = _bracket_stage(expected * 2)
        items = []
        for i in range(expected):
            if i < len(actual):
                item = dict(actual[i])
                item["virtual"] = False
            else:
                item = {
                    "id": f"standby-{round_number}-{i + 1}",
                    "match_no": i + 1,
                    "match_code": f"STANDBY-{round_number}-{i + 1}",
                    "side_a": "",
                    "side_b": "",
                    "winner": None,
                    "status": "Standby",
                    "games": [],
                    "virtual": True,
                }
            items.append(item)
        rounds.append({"number": round_number, "stage": stage, "matches": items})

    return {
        "event_name": event_name,
        "first_count": first_count,
        "total_rounds": total_rounds,
        "cutoff_round": cutoff_round,
        "rounds": rounds,
        "page_size": landscape(A2 if first_count > 16 else A3),
    }


def _draw_progressive_bracket_page(c, tournament, prepared, executive_pack=False):
    event_name = prepared["event_name"]
    first_count = prepared["first_count"]
    total_rounds = prepared["total_rounds"]
    cutoff_round = prepared["cutoff_round"]
    rounds = prepared["rounds"]
    page_size = prepared["page_size"]
    c.setPageSize(page_size)
    page_w, page_h = page_size

    navy = colors.HexColor("#0f172a")
    green = colors.HexColor("#047857")
    line = colors.HexColor("#64748b")
    border = colors.HexColor("#94a3b8")
    muted = colors.HexColor("#475569")
    standby = colors.HexColor("#f8fafc")

    margin = 24
    footer_h = 22
    header_h = 88
    content_top = page_h - header_h
    usable_h = content_top - footer_h - 10
    gap = 30
    col_w = (page_w - (2 * margin) - (gap * (total_rounds - 1))) / total_rounds
    row_unit = usable_h / first_count
    card_h = min(38, max(20, row_unit * 0.74))

    logo_x = margin
    if LOGO_PATH.exists():
        try:
            c.drawImage(str(LOGO_PATH), logo_x, page_h - 68, width=44, height=44, preserveAspectRatio=True, mask="auto")
            logo_x += 54
        except Exception:
            pass

    c.setFillColor(navy)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(logo_x, page_h - 33, "Lesotho Badminton Association")
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(green)
    c.drawString(logo_x, page_h - 51, "Executive Tournament Draw Pack" if executive_pack else "Official Progressive Tournament Draw")

    c.setFillColor(navy)
    c.setFont("Helvetica-Bold", 11)
    c.drawRightString(page_w - margin, page_h - 31, str(tournament.get("name") or "Tournament"))
    c.setFont("Helvetica", 8.5)
    c.setFillColor(muted)
    latest_stage = rounds[cutoff_round - 1]["stage"]
    meta = f"{event_name}  |  {tournament.get('venue') or 'Venue not recorded'}  |  Filled through: {latest_stage}"
    c.drawRightString(page_w - margin, page_h - 47, meta)
    date_text = tournament.get("start_date") or tournament.get("created_at") or ""
    c.drawRightString(page_w - margin, page_h - 61, f"Date: {date_text or '-'}")
    c.setStrokeColor(border)
    c.setLineWidth(0.7)
    c.line(margin, page_h - 72, page_w - margin, page_h - 72)

    def card_position(round_index, match_index):
        center = content_top - ((match_index + 0.5) * (2 ** round_index) * row_unit)
        x = margin + round_index * (col_w + gap)
        y = center - card_h / 2
        return x, y, center

    c.setStrokeColor(line)
    c.setLineWidth(0.8)
    for r in range(total_rounds - 1):
        for i in range(len(rounds[r]["matches"])):
            x1, _, y1 = card_position(r, i)
            x2, _, y2 = card_position(r + 1, i // 2)
            start_x = x1 + col_w
            end_x = x2
            mid_x = start_x + gap / 2
            c.line(start_x, y1, mid_x, y1)
            c.line(mid_x, y1, mid_x, y2)
            c.line(mid_x, y2, end_x, y2)

    for r, round_data in enumerate(rounds):
        x = margin + r * (col_w + gap)
        c.setFillColor(navy)
        c.setFont("Helvetica-Bold", 9)
        c.drawCentredString(x + col_w / 2, content_top + 7, round_data["stage"].upper())
        c.setStrokeColor(green)
        c.setLineWidth(1.4)
        c.line(x, content_top + 1, x + col_w, content_top + 1)

        for i, m in enumerate(round_data["matches"]):
            x, y, _ = card_position(r, i)
            is_virtual = bool(m.get("virtual"))
            c.setFillColor(standby if is_virtual else colors.white)
            c.setStrokeColor(border if is_virtual else navy)
            c.setLineWidth(0.65 if is_virtual else 0.9)
            c.roundRect(x, y, col_w, card_h, 5, fill=1, stroke=1)

            status = str(m.get("status") or "Pending")
            status_color = green if status == "Completed" else (colors.HexColor("#d97706") if status == "In Progress" else muted)
            c.setFillColor(status_color)
            c.setFont("Helvetica-Bold", 5.8 if first_count > 16 else 6.5)
            code = str(m.get("match_code") or f"M{m.get('match_no') or i + 1}")
            label = "STANDBY" if is_virtual else ("LIVE" if status == "In Progress" else ("RESULT" if status == "Completed" else "READY"))
            c.drawString(x + 5, y + card_h - 8, _pdf_fit_text(c, f"{code} - {label}", "Helvetica-Bold", 6.5, col_w - 10))

            text_size = 6.2 if first_count > 16 else 7.4
            side_a = str(m.get("side_a") or "")
            side_b = str(m.get("side_b") or "")
            winner = str(m.get("winner") or "")
            row1_y = y + card_h * 0.56
            row2_y = y + card_h * 0.25
            for name, py in [(side_a, row1_y), (side_b, row2_y)]:
                is_winner = bool(winner and name and name == winner)
                c.setFillColor(green if is_winner else navy)
                c.setFont("Helvetica-Bold" if is_winner else "Helvetica", text_size)
                fitted = _pdf_fit_text(c, name, "Helvetica-Bold" if is_winner else "Helvetica", text_size, col_w - 12)
                c.drawString(x + 6, py, fitted)
                if is_winner:
                    c.setFont("Helvetica-Bold", text_size)
                    c.drawRightString(x + col_w - 6, py, "W")

            games = m.get("games") or []
            if games and card_h >= 30:
                score = "  ".join(f"{g.get('side_a_score')}-{g.get('side_b_score')}" for g in games)
                c.setFillColor(muted)
                c.setFont("Helvetica", 5.8)
                c.drawRightString(x + col_w - 5, y + 4, _pdf_fit_text(c, score, "Helvetica", 5.8, col_w * 0.55))

    c.setFillColor(muted)
    c.setFont("Helvetica", 7)
    c.drawString(margin, 9, f"{event_name} bracket snapshot - filled through {latest_stage}. Future rounds remain on standby.")
    c.drawRightString(page_w - margin, 9, "Generated by LBA Tournament System")


def build_progressive_bracket_pdf(tournament, event_name, matches, cutoff_round=None):
    prepared = _prepare_progressive_bracket(event_name, matches, cutoff_round)
    buffer = io.BytesIO()
    c = pdfcanvas.Canvas(buffer, pagesize=prepared["page_size"])
    c.setTitle(f"{tournament.get('name','LBA Tournament')} - {prepared['event_name']} Progressive Draw")
    _draw_progressive_bracket_page(c, tournament, prepared, executive_pack=False)
    c.showPage()
    c.save()
    buffer.seek(0)
    return buffer.getvalue()


def build_executive_draw_pack_pdf(tournament, event_matches):
    """One-click executive PDF: cover summary plus every event bracket."""
    event_order = ["MS", "WS", "MD", "WD", "XD"]
    prepared_events = []
    for event_name in event_order:
        matches = event_matches.get(event_name) or []
        if not matches:
            continue
        latest = max(int(m.get("round_number") or 1) for m in matches)
        prepared_events.append(_prepare_progressive_bracket(event_name, matches, latest))

    if not prepared_events:
        raise ValueError("No event draws are available for this tournament.")

    buffer = io.BytesIO()
    c = pdfcanvas.Canvas(buffer, pagesize=A4)
    c.setTitle(f"{tournament.get('name','LBA Tournament')} - Executive Draw Pack")

    navy = colors.HexColor("#0f172a")
    green = colors.HexColor("#047857")
    muted = colors.HexColor("#475569")
    border = colors.HexColor("#cbd5e1")

    # Executive cover page.
    c.setPageSize(A4)
    page_w, page_h = A4
    margin = 38
    if LOGO_PATH.exists():
        try:
            c.drawImage(str(LOGO_PATH), margin, page_h - 92, width=56, height=56, preserveAspectRatio=True, mask="auto")
        except Exception:
            pass
    c.setFillColor(navy)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(margin + 68, page_h - 54, "Lesotho Badminton Association")
    c.setFillColor(green)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(margin + 68, page_h - 74, "Executive Tournament Draw Pack")
    c.setStrokeColor(border)
    c.line(margin, page_h - 105, page_w - margin, page_h - 105)

    c.setFillColor(navy)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(margin, page_h - 142, str(tournament.get("name") or "Tournament"))
    c.setFont("Helvetica", 10)
    c.setFillColor(muted)
    c.drawString(margin, page_h - 160, f"Code: {tournament.get('tournament_code') or '-'}")
    c.drawString(margin, page_h - 176, f"Venue: {tournament.get('venue') or '-'}")
    c.drawString(margin, page_h - 192, f"Date: {tournament.get('start_date') or '-'}")
    c.drawString(margin, page_h - 208, f"Status: {tournament.get('status') or '-'}")
    c.drawString(margin, page_h - 224, f"Generated: {now_iso()}")

    y = page_h - 270
    c.setFillColor(navy)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(margin, y, "EVENT")
    c.drawString(margin + 65, y, "LATEST ROUND")
    c.drawString(margin + 190, y, "MATCHES")
    c.drawString(margin + 255, y, "COMPLETED")
    c.drawString(margin + 335, y, "STATUS")
    c.setStrokeColor(border)
    c.line(margin, y - 6, page_w - margin, y - 6)

    y -= 28
    for prepared in prepared_events:
        event_name = prepared["event_name"]
        matches = event_matches.get(event_name) or []
        completed = sum(1 for m in matches if m.get("status") == "Completed")
        total = len(matches)
        latest_stage = prepared["rounds"][prepared["cutoff_round"] - 1]["stage"]
        final_done = any(m.get("stage") == "Final" and int(m.get("match_no") or 0) != 3 and m.get("status") == "Completed" for m in matches)
        c.setFillColor(navy)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(margin, y, event_name)
        c.setFont("Helvetica", 9)
        c.drawString(margin + 65, y, latest_stage)
        c.drawString(margin + 190, y, str(total))
        c.drawString(margin + 255, y, str(completed))
        c.setFillColor(green if final_done else muted)
        c.drawString(margin + 335, y, "Complete" if final_done else "In progress")
        y -= 24

    c.setFillColor(muted)
    c.setFont("Helvetica", 8)
    c.drawString(margin, 34, "The following pages contain the latest available draw for each event, with future bracket paths retained through the Final.")
    c.showPage()

    for prepared in prepared_events:
        _draw_progressive_bracket_page(c, tournament, prepared, executive_pack=True)
        c.showPage()

    c.save()
    buffer.seek(0)
    return buffer.getvalue()


def import_workbook(file_storage):
    wb = load_workbook(file_storage, data_only=True)
    imported = 0
    skipped = 0
    now = now_iso()

    with db() as con:
        for sheet in wb.worksheets:
            rows = list(sheet.iter_rows(values_only=True))
            if not rows:
                continue

            # LBA ranking workbooks may have title/metadata rows before the
            # actual player-table header. Find the row containing Last Name
            # and First Name instead of assuming the first row is the header.
            header_index = None
            for idx, row in enumerate(rows):
                normalized = [
                    str(cell).strip().lower().replace(" ", "_") if cell is not None else ""
                    for cell in row
                ]
                if "last_name" in normalized and "first_name" in normalized:
                    header_index = idx
                    break

            if header_index is None:
                # Also support simple import sheets whose first row is already
                # a standard header.
                header_index = 0

            headers = [
                str(cell).strip().lower().replace(" ", "_") if cell is not None else ""
                for cell in rows[header_index]
            ]

            # The official LBA ranking workbook stores:
            # column B = rank, C = last name, D = first name,
            # E = total points, F = tournaments played.
            def get_value(record, *names):
                for name in names:
                    value = record.get(name)
                    if value not in (None, ""):
                        return value
                return None

            # Infer category/event information from the worksheet name.
            sheet_name = str(sheet.title).strip()
            category_from_sheet = sheet_name.replace(" ", "")
            if category_from_sheet.upper().startswith("MS,U"):
                category_from_sheet = category_from_sheet.upper()
            elif category_from_sheet.upper().startswith("MS,18"):
                category_from_sheet = "MS,18+"
            elif category_from_sheet.upper().startswith("WS,U"):
                category_from_sheet = category_from_sheet.upper()
            elif category_from_sheet.upper().startswith("WS,18"):
                category_from_sheet = "WS,18+"

            for values in rows[header_index + 1:]:
                record = dict(zip(headers, values))

                full_name = str(get_value(
                    record, "full_name", "name", "player_name",
                    "player", "player_full_name"
                ) or "").strip()

                first = str(get_value(
                    record, "first_name", "firstname", "first"
                ) or "").strip()
                last = str(get_value(
                    record, "last_name", "lastname", "surname", "last"
                ) or "").strip()

                # Official LBA workbook uses C/D for last/first name.
                if not full_name:
                    full_name = f"{first} {last}".strip()

                if not full_name:
                    skipped += 1
                    continue

                rank = get_value(
                    record, "rank_position", "rank", "#"
                )
                total_points = get_value(
                    record, "total_points", "points", "points_total"
                )
                tournaments_played = get_value(
                    record, "tournaments_played", "tournaments", "tournament_played"
                )

                category = str(get_value(
                    record, "category_code", "category", "category_name",
                    "event_category"
                ) or category_from_sheet).strip()

                payload = clean_player_payload({
                    "full_name": full_name,
                    "first_name": first,
                    "last_name": last,
                    "category_code": category,
                    "gender": get_value(record, "gender"),
                    "age_group": get_value(record, "age_group"),
                    "event_type": get_value(record, "event_type"),
                    "club": get_value(record, "club"),
                    "rank_position": rank,
                    "total_points": total_points,
                    "tournaments_played": tournaments_played,
                    "status": "Active",
                    "notes": f"Imported from {sheet.title}",
                })

                con.execute("""
                    INSERT INTO players(
                        category_code,event_type,gender,age_group,club,
                        rank_position,first_name,last_name,full_name,
                        total_points,tournaments_played,status,notes,
                        created_at,updated_at
                    )
                    VALUES(
                        :category_code,:event_type,:gender,:age_group,:club,
                        :rank_position,:first_name,:last_name,:full_name,
                        :total_points,:tournaments_played,:status,:notes,
                        :created_at,:updated_at
                    )
                """, payload)
                imported += 1

        con.commit()

    return imported, skipped


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(debug=False, host="0.0.0.0", port=port)
