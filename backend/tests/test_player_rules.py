"""Regression tests for duplicate player registration and tournament medals.

Pure rule tests intentionally avoid Flask startup / production credentials.
They extract the implemented helpers from the actual backend source.
"""
import ast
import json
import sqlite3
import unittest
import unicodedata
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "app.py"
program = ast.parse(SOURCE.read_text(encoding="utf-8"))
required = {
    "_player_name_keys", "_duplicate_player", "_player_duplicate_message",
    "_event_podium", "_tournament_event_podiums",
    "_knockout_stage", "_backfill_completed_tournament_podiums",
}
nodes = [node for node in program.body if isinstance(node, ast.FunctionDef) and node.name in required]
assert {n.name for n in nodes} == required, "Expected backend helpers are missing"
namespace = {"unicodedata": unicodedata, "json": json,
             "now_iso": lambda: "2026-10-20T12:00:00+02:00"}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), "exec"), namespace)


class PlayerUniquenessTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.execute("""CREATE TABLE players(
            id INTEGER PRIMARY KEY, full_name TEXT, first_name TEXT,
            last_name TEXT, date_of_birth TEXT)""")
        self.con.execute("INSERT INTO players VALUES(1,'  Néo   Ramoholi  ','Néo','Ramoholi','2004-08-15')")

    def tearDown(self):
        self.con.close()

    def test_same_name_and_dob_blocked_despite_spacing_and_case(self):
        incoming = {"full_name": "  NÉO RAMOHOLI ", "date_of_birth": "2004-08-15"}
        self.assertEqual(namespace["_duplicate_player"](self.con, incoming)["id"], 1)

    def test_same_name_different_birth_date_permitted(self):
        incoming = {"full_name": "Néo Ramoholi", "date_of_birth": "2005-08-15"}
        self.assertIsNone(namespace["_duplicate_player"](self.con, incoming))

    def test_updating_existing_player_excludes_self(self):
        incoming = {"full_name": "Néo Ramoholi", "date_of_birth": "2004-08-15"}
        self.assertIsNone(namespace["_duplicate_player"](self.con, incoming, exclude_id=1))

    def test_import_without_dob_does_not_duplicate_name(self):
        incoming = {"full_name": "Néo Ramoholi", "date_of_birth": None}
        self.assertEqual(namespace["_duplicate_player"](self.con, incoming)["id"], 1)

    def test_existing_without_birthdate_blocks_ambiguous_new_record(self):
        self.con.execute("INSERT INTO players VALUES(2,'Lerato Thabo','Lerato','Thabo',NULL)")
        incoming = {"full_name": "Lerato Thabo", "date_of_birth": "2008-05-21"}
        self.assertEqual(namespace["_duplicate_player"](self.con, incoming)["id"], 2)

    def test_first_last_names_detect_mismatch_with_full_name(self):
        incoming = {"full_name": "Different Display", "first_name": "Néo",
                    "last_name": "Ramoholi", "date_of_birth": "2004-08-15"}
        self.assertEqual(namespace["_duplicate_player"](self.con, incoming)["id"], 1)


def match(stage, number, a, b, winner=None, status="Completed"):
    return {"stage":stage, "match_no":number, "side_a":a, "side_b":b,
            "winner":winner, "status":status}


class ThirdPlaceTests(unittest.TestCase):
    def setUp(self):
        self.semis = [
            match("Semifinal",1,"Alice","Beth","Alice"),
            match("Semifinal",2,"Claire","Dineo","Claire"),
        ]
        self.final = match("Final",1,"Alice","Claire","Alice")
        self.bronze = match("Final",3,"Beth","Dineo",None,"Pending")

    def test_unplayed_bronze_awards_joint_third(self):
        result = namespace["_event_podium"](self.semis+[self.final,self.bronze])
        self.assertEqual(result["first"],"Alice")
        self.assertEqual(result["second"],"Claire")
        self.assertEqual(result["third_players"],["Beth","Dineo"])
        self.assertEqual(result["third"],"Beth & Dineo")

    def test_played_bronze_has_only_its_winner(self):
        bronze=match("Final",3,"Beth","Dineo","Dineo")
        result=namespace["_event_podium"](self.semis+[self.final,bronze])
        self.assertEqual(result["third_players"],["Dineo"])
        self.assertEqual(result["third"],"Dineo")

    def test_bronze_cannot_be_mistaken_for_championship_final(self):
        bronze=match("Final",3,"Beth","Dineo","Beth")
        result=namespace["_event_podium"](self.semis+[bronze])
        self.assertIsNone(result["first"])
        self.assertEqual(result["third"],"Beth")

    def test_medals_isolated_by_event(self):
        db = sqlite3.connect(":memory:")
        db.row_factory=sqlite3.Row
        db.execute("""CREATE TABLE draws(id INTEGER PRIMARY KEY,tournament_id INTEGER,
                      event_name TEXT,stage TEXT,round_number INTEGER)""")
        db.execute("""CREATE TABLE draw_matches(id INTEGER PRIMARY KEY,draw_id INTEGER,
                      match_no INTEGER,side_a TEXT,side_b TEXT,winner TEXT,status TEXT)""")
        for draw_id, ev, stage, round_no in [(1,"MS","Semifinal",1),
                                             (2,"MS","Final",2),
                                             (3,"WS","Semifinal",1),
                                             (4,"WS","Final",2)]:
            db.execute("INSERT INTO draws VALUES(?,?,?,?,?)",(draw_id,5,ev,stage,round_no))
        rows=[
            (1,1,1,"Alice","Beth","Alice","Completed"),
            (2,1,2,"Claire","Dineo","Claire","Completed"),
            (3,2,1,"Alice","Claire","Alice","Completed"),
            (4,2,3,"Beth","Dineo",None,"Pending"),
            (5,3,1,"Eva","Fifi","Eva","Completed"),
            (6,3,2,"Gina","Hannah","Gina","Completed"),
            (7,4,1,"Eva","Gina","Gina","Completed"),
        ]
        db.executemany("INSERT INTO draw_matches VALUES(?,?,?,?,?,?,?)",rows)
        podiums=namespace["_tournament_event_podiums"](db,5)
        self.assertEqual(podiums["MS"]["third_players"],["Beth","Dineo"])
        self.assertEqual(podiums["WS"]["third_players"],["Fifi","Hannah"])
        db.execute("UPDATE draw_matches SET winner='Beth',status='Completed' WHERE id=4")
        podiums=namespace["_tournament_event_podiums"](db,5)
        self.assertEqual(podiums["MS"]["third_players"],["Beth"])
        self.assertEqual(podiums["WS"]["third_players"],["Fifi","Hannah"])
        db.close()


class LegacySevenMatchTournamentTests(unittest.TestCase):
    """The real-world regression: 4 matches + 2 wrongly labelled + Final = 7."""
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript("""
            CREATE TABLE tournaments(
                id INTEGER PRIMARY KEY,status TEXT,winner_name TEXT,
                runner_up_name TEXT,third_place_name TEXT,event_podiums TEXT,
                finished_at TEXT);
            CREATE TABLE tournament_audit(
                tournament_id INTEGER,actor TEXT,action TEXT,details TEXT,created_at TEXT);
            CREATE TABLE draws(
                id INTEGER PRIMARY KEY,tournament_id INTEGER,
                event_name TEXT,stage TEXT,round_number INTEGER);
            CREATE TABLE draw_matches(
                id INTEGER PRIMARY KEY,draw_id INTEGER,match_no INTEGER,
                side_a TEXT,side_b TEXT,winner TEXT,status TEXT);
        """)
        self.con.execute(
            "INSERT INTO tournaments VALUES(?,?,?,?,?,?,?)",
            (11,"Completed","Alice","Claire",None,
             json.dumps({"MS":{"first":"Alice","second":"Claire","third":None}}),
             "2026-10-20T11:52:00+02:00")
        )
        self.con.executemany(
            "INSERT INTO draws VALUES(?,?,?,?,?)",
            [(1,11,"MS","Quarterfinal",1),
             (2,11,"MS","Quarterfinal",2),  # Historical bug: actual semifinal
             (3,11,"MS","Final",3)]
        )
        self.con.executemany(
            "INSERT INTO draw_matches VALUES(?,?,?,?,?,?,?)",
            [
                (1,1,1,"Alice","Adele","Alice","Completed"),
                (2,1,2,"Beth","Bokang","Beth","Completed"),
                (3,1,3,"Claire","Celeste","Claire","Completed"),
                (4,1,4,"Dineo","Daisy","Dineo","Completed"),
                (5,2,1,"Alice","Beth","Alice","Completed"),
                (6,2,2,"Claire","Dineo","Claire","Completed"),
                (7,3,1,"Alice","Claire","Alice","Completed"),
            ]
        )

    def tearDown(self):
        self.con.close()

    def test_new_round_stage_uses_entrants_not_match_count(self):
        self.assertEqual(namespace["_knockout_stage"](4), "Semifinal")
        self.assertEqual(namespace["_knockout_stage"](8), "Quarterfinal")
        self.assertEqual(namespace["_knockout_stage"](2), "Final")
        self.assertEqual(namespace["_knockout_stage"](16), "Round of 16")

    def test_legacy_seven_completed_matches_now_show_both_third_places(self):
        podiums = namespace["_tournament_event_podiums"](self.con, 11)
        self.assertEqual(podiums["MS"]["first"],"Alice")
        self.assertEqual(podiums["MS"]["second"],"Claire")
        self.assertEqual(podiums["MS"]["third_players"],["Beth","Dineo"])
        self.assertEqual(podiums["MS"]["third"],"Beth & Dineo")

    def test_migration_repairs_saved_archive_without_touching_results(self):
        n = namespace["_backfill_completed_tournament_podiums"](self.con)
        self.assertEqual(n,1)
        row=self.con.execute("SELECT * FROM tournaments WHERE id=11").fetchone()
        self.assertEqual(row["third_place_name"],"Beth & Dineo")
        self.assertEqual(json.loads(row["event_podiums"])["MS"]["third"],"Beth & Dineo")
        self.assertEqual(row["finished_at"],"2026-10-20T11:52:00+02:00")
        self.assertEqual(row["status"],"Completed")
        self.assertEqual(
            self.con.execute("SELECT COUNT(*) FROM draw_matches").fetchone()[0],7
        )
        action=self.con.execute("SELECT action FROM tournament_audit").fetchone()[0]
        self.assertEqual(action,"PODIUM_RECONCILED")
        self.assertEqual(namespace["_backfill_completed_tournament_podiums"](self.con),0)

    def test_completed_bronze_overrides_joint_third_after_migration(self):
        self.con.execute("INSERT INTO draw_matches VALUES(?,?,?,?,?,?,?)",
                         (8,3,3,"Beth","Dineo","Beth","Completed"))
        podiums=namespace["_tournament_event_podiums"](self.con,11)
        self.assertEqual(podiums["MS"]["third_players"],["Beth"])
        self.assertEqual(namespace["_backfill_completed_tournament_podiums"](self.con),1)
        self.assertEqual(self.con.execute(
            "SELECT third_place_name FROM tournaments WHERE id=11").fetchone()[0],"Beth")


if __name__ == "__main__":
    unittest.main()
