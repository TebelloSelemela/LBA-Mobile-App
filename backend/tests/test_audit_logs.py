"""Read-only system audit and tournament record regressions."""
import ast
import sqlite3
import unittest
from pathlib import Path

BACKEND=Path(__file__).resolve().parents[1] / 'app.py'
SOURCE=BACKEND.read_text(encoding='utf-8')
MODULE=ast.parse(SOURCE)
helper=next(n for n in MODULE.body if isinstance(n,ast.FunctionDef) and n.name=='_audit_snapshot')
scope={}
exec(compile(ast.Module(body=[helper],type_ignores=[]),str(BACKEND),'exec'),scope)
snapshot=scope['_audit_snapshot']


class AuditWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.con=sqlite3.connect(':memory:')
        self.con.row_factory=sqlite3.Row
        self.con.executescript("""
            CREATE TABLE audit_logs (
                id INTEGER PRIMARY KEY,actor TEXT,action TEXT,
                entity TEXT,entity_id INTEGER,details TEXT,created_at TEXT
            );
            CREATE TABLE tournaments (id INTEGER PRIMARY KEY,name TEXT);
            CREATE TABLE tournament_audit (
                id INTEGER PRIMARY KEY,tournament_id INTEGER,match_id INTEGER,
                actor TEXT,action TEXT,details TEXT,created_at TEXT
            );
            INSERT INTO tournaments VALUES (7,'Test Tournament');
            INSERT INTO audit_logs VALUES
                (1,'admin','CREATE_PLAYER','players',21,'New player','2026-10-20T10:00:00+02:00'),
                (2,'admin','CREATE_TOURNAMENT','tournaments',7,'Test Tournament','2026-10-21T10:00:00+02:00');
            INSERT INTO tournament_audit VALUES
                (1,7,12,'admin','RESULT_RECORDED','Game scores','2026-10-20T10:10:00+02:00'),
                (2,7,NULL,'SYSTEM','PODIUM_RECONCILED','3rd place updated','2026-10-21T10:01:00+02:00');
        """)

    def tearDown(self):
        self.con.close()

    def test_separate_lists_with_readable_tournament_name(self):
        payload=snapshot(self.con)
        self.assertEqual(len(payload['system_logs']),2)
        self.assertEqual(len(payload['system_records']),2)
        self.assertEqual(payload['system_logs'][0]['action'],'CREATE_TOURNAMENT')
        self.assertEqual(payload['system_records'][0]['action'],'PODIUM_RECONCILED')
        self.assertEqual(payload['system_records'][0]['tournament_name'],'Test Tournament')
        self.assertEqual(payload['system_records'][1]['match_id'],12)

    def test_limit_is_applied_to_each_registry(self):
        payload=snapshot(self.con,1)
        self.assertEqual(len(payload['system_logs']),1)
        self.assertEqual(len(payload['system_records']),1)

    def test_audit_query_does_not_mutate_persisted_records(self):
        before=self.con.total_changes
        snapshot(self.con)
        self.assertEqual(self.con.total_changes,before)

    def test_endpoint_requires_authentication(self):
        self.assertIn('@app.route("/api/audit", methods=["GET"])\n    @require_auth',SOURCE)

    def test_tournament_view_does_not_render_separate_old_audit_panel(self):
        frontend=BACKEND.parents[1] / 'frontend' / 'src' / 'main.jsx'
        jsx=frontend.read_text(encoding='utf-8')
        self.assertNotIn('<section className="audit-history">',jsx)
        self.assertIn('function AuditLogsPage(',jsx)
        self.assertIn("'audit','Audit Logs'",jsx)


if __name__=='__main__':
    unittest.main()
