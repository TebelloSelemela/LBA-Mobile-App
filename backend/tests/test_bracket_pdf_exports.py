"""Render real PDF exports to detect missing match results and truncated workflows.

Backend PDF helpers are loaded by AST to avoid touching the live LESBAD SQLite DB.
"""
import ast
import io
import unittest
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import A2, A3, A4, landscape
from reportlab.pdfgen import canvas as pdfcanvas

SOURCE=Path(__file__).resolve().parents[1] / "app.py"
program=ast.parse(SOURCE.read_text(encoding="utf-8"))
names={
    "_bracket_stage", "_pdf_fit_text", "_prepare_progressive_bracket",
    "_draw_progressive_bracket_page", "_draw_bracket_results_pages",
    "build_progressive_bracket_pdf", "build_executive_draw_pack_pdf"
}
nodes=[node for node in program.body if isinstance(node,ast.FunctionDef) and node.name in names]
assert {node.name for node in nodes}==names, "PDF builder entrypoints missing"
env={
    "colors":colors, "A2":A2, "A3":A3, "A4":A4, "landscape":landscape,
    "io":io, "pdfcanvas":pdfcanvas,
    "LOGO_PATH":Path("__missing_test_logo__.png"),
    "now_iso":lambda:"2026-11-06T10:00:00+02:00"
}
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),"exec"),env)


def fixtures(size=16,event="MS"):
    assert size and size & (size-1)==0
    data=[]
    count=size
    round_number=1
    while count:
        stage=env["_bracket_stage"](count*2)
        for i in range(count):
            games=[
                {"game_number":1,"side_a_score":15,"side_b_score":17},
                {"game_number":2,"side_a_score":11,"side_b_score":15}
            ] if i==0 else []
            data.append({
                "id":f"{round_number}-{i+1}", "event_name":event,
                "round_number":round_number, "stage":stage, "match_no":i+1,
                "match_code":f"LBA-03-{round_number:03d}-{i+1:03d}",
                "side_a":f"Alpha Player {i+1}",
                "side_b":f"Bravo Player {i+1}",
                "winner":f"Bravo Player {i+1}" if i==0 else None,
                "status":"Completed" if i==0 else "Pending",
                "games":games
            })
        count//=2
        round_number+=1
    return data


def read_pdf(pdf):
    document=PdfReader(io.BytesIO(pdf))
    return len(document.pages),"\n".join(page.extract_text() or "" for page in document.pages)


class ProgressivePdfTests(unittest.TestCase):
    def setUp(self):
        self.tournament={"name":"LESBAD Junior Tournament","venue":"Maseru",
                         "start_date":"2026-11-06","tournament_code":"LBA03"}

    def test_all_match_results_are_exported_readably(self):
        data=fixtures()
        size,text=read_pdf(env["build_progressive_bracket_pdf"](self.tournament,"MS",data))
        self.assertGreaterEqual(size,3)
        self.assertIn("Official Progressive Tournament Draw",text)
        self.assertIn("Official Match Results",text)
        self.assertIn("Alpha Player 1",text)
        self.assertIn("Bravo Player 1",text)
        self.assertIn("15-17 | 11-15",text)
        self.assertIn("Round of 32",text)
        self.assertIn("Semifinal",text)
        self.assertIn("Final",text)

    def test_32_match_first_round_renders_and_preserves_scores(self):
        data=fixtures(32)
        size,text=read_pdf(env["build_progressive_bracket_pdf"](self.tournament,"MS",data))
        self.assertGreaterEqual(size,4)
        self.assertIn("Alpha Player 32",text)
        self.assertIn("15-17 | 11-15",text)

    def test_bronze_results_in_record_not_final_path(self):
        data=fixtures(2)
        data.append({"id":"bronze","event_name":"MS","round_number":2,
                     "stage":"Final","match_no":3,"match_code":"LBA-BRONZE",
                     "side_a":"Bronze Alice","side_b":"Bronze Bob",
                     "winner":"Bronze Alice","status":"Completed",
                     "games":[{"game_number":1,"side_a_score":15,"side_b_score":11}]})
        size,text=read_pdf(env["build_progressive_bracket_pdf"](self.tournament,"MS",data))
        self.assertEqual(size,2)
        self.assertIn("Third Place",text)
        self.assertIn("LBA-BRONZE",text)
        self.assertIn("15-11",text)

    def test_executive_export_has_results_for_each_event(self):
        events={"MS":fixtures(2,"MS"),"WS":fixtures(2,"WS")}
        size,text=read_pdf(env["build_executive_draw_pack_pdf"](self.tournament,events))
        self.assertGreaterEqual(size,5)
        self.assertIn("Executive Tournament Draw Pack",text)
        self.assertEqual(text.count("Official Match Results"),2)
        self.assertIn("GAME SCORES (A-B)",text)


if __name__=="__main__":
    unittest.main()
