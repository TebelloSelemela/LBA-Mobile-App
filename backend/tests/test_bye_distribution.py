"""Regression tests for BYE intervals and protected seeded bracket paths.

Fixtures are tested with pure production helpers extracted from app.py.
No production database, tournament state or admin credentials are touched.
"""
import ast
import random
import unittest
from pathlib import Path

SOURCE=Path(__file__).resolve().parents[1]/"app.py"
tree=ast.parse(SOURCE.read_text(encoding="utf-8"))
required={
    "_protected_seed_count", "_balanced_bracket_order",
    "_spaced_bye_positions", "build_fixtures"
}
nodes=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in required]
assert {node.name for node in nodes}==required, "Bracket allocation helpers missing"
scope={}
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),"exec"),scope)
order_fn=scope["_balanced_bracket_order"]
positions_fn=scope["_spaced_bye_positions"]
fixtures_fn=scope["build_fixtures"]


def players(n):
    return [{"id":i,"full_name":f"Player {i}"} for i in range(1,n+1)]


def bye_indices(fixtures):
    return [i for i,f in enumerate(fixtures) if f["side_b"]=="Bye"]


class ByeDistributionTests(unittest.TestCase):
    def test_fixed_examples_requested_for_round_of_64_and_32(self):
        # 56 participants -> 64 available slots -> 32 first-round matches
        # with eight BYEs: one BYE AFTER every fourth fixture.
        for seeded in (False,True):
            draw=fixtures_fn(players(56),"Singles",seed_by_rank=seeded)
            self.assertEqual(
                [i+1 for i in bye_indices(draw)],
                [4,8,12,16,20,24,28,32]
            )
        # 24 participants -> 32 available slots -> 16 first-round matches
        # with eight BYEs: every second fixture.
        for seeded in (False,True):
            draw=fixtures_fn(players(24),"Singles",seed_by_rank=seeded)
            self.assertEqual(
                [i+1 for i in bye_indices(draw)],
                [2,4,6,8,10,12,14,16]
            )

    def test_other_bye_counts_change_spacing_automatically(self):
        # Same Round of 32; only four BYEs -> every fourth fixture.
        result=fixtures_fn(players(28),"Singles")
        self.assertEqual([i+1 for i in bye_indices(result)],[4,8,12,16])
        # Only two BYEs -> matches 8 and 16.
        result=fixtures_fn(players(30),"Singles")
        self.assertEqual([i+1 for i in bye_indices(result)],[8,16])
        # Seven BYEs -> gaps are either two or three matches.
        result=fixtures_fn(players(25),"Singles")
        self.assertEqual([i+1 for i in bye_indices(result)],[2,4,6,9,11,13,16])

    def test_any_valid_bye_ratio_is_evenly_spaced(self):
        for match_count in (1,2,4,8,16,32,64,128):
            for byes in range(match_count):
                with self.subTest(matches=match_count,byes=byes):
                    indices=positions_fn(match_count,byes)
                    self.assertEqual(len(indices),byes)
                    self.assertEqual(indices,sorted(set(indices)))
                    if byes:
                        self.assertEqual(indices[-1],match_count-1)
                        # In full groups of fixtures, BYEs are no more than
                        # one fixture further apart than another group.
                        distances=[indices[0]+1]
                        distances.extend(
                            b-a for a,b in zip(indices,indices[1:])
                        )
                        self.assertLessEqual(max(distances)-min(distances),1)

    def test_invalid_counts_are_rejected(self):
        for bad_match_count in (0,3,5,12):
            with self.assertRaises(ValueError):
                positions_fn(bad_match_count,0)
        for invalid_byes in (-1,8,9):
            with self.assertRaises(ValueError):
                positions_fn(8,invalid_byes)

    def test_balanced_seed_priority_order_is_complete(self):
        for count in (1,2,4,8,16,32,64):
            self.assertEqual(sorted(order_fn(count)),list(range(count)))

    def test_every_player_used_once_for_all_sizes_seeded_unseeded(self):
        random.seed(2026)
        for n in range(2,129):
            for seeded in (False,True):
                with self.subTest(players=n,seeded=seeded):
                    result=fixtures_fn(players(n),"Singles",seed_by_rank=seeded)
                    slots=1<<(n-1).bit_length()
                    self.assertEqual(len(result),slots//2)
                    self.assertEqual(
                        [m["match_no"] for m in result],
                        list(range(1,slots//2+1))
                    )
                    self.assertEqual(len(bye_indices(result)),slots-n)
                    self.assertTrue(all(m["side_a"]!="Bye" for m in result))
                    ids=[int(m["side_a_player_ids"]) for m in result]
                    ids += [
                        int(m["side_b_player_ids"]) for m in result
                        if m["side_b"]!="Bye"
                    ]
                    self.assertEqual(sorted(ids),list(range(1,n+1)))

    def test_byes_cover_halves_quarters_and_eighths_when_possible(self):
        for n in (24,28,36,48,56,68,96,112):
            for seeded in (False,True):
                with self.subTest(n=n,seeded=seeded):
                    draw=fixtures_fn(players(n),"Singles",seed_by_rank=seeded)
                    m=len(draw)
                    indices=bye_indices(draw)
                    for parts in (2,4,8):
                        if m>=parts and len(indices)>=parts:
                            for group in range(parts):
                                self.assertTrue(any(
                                    group*(m//parts)<=i<(group+1)*(m//parts)
                                    for i in indices
                                ),f"Missing BYE in bracket region {group}/{parts} for {n}")

    def test_when_feasible_only_one_bye_enters_each_round_two_match(self):
        for n in (20,24,28,30,48,56,60):
            draw=fixtures_fn(players(n),"Singles")
            indices=set(bye_indices(draw))
            if len(indices)<=len(draw)//2:
                for k in range(0,len(draw),2):
                    self.assertLessEqual(len(indices.intersection({k,k+1})),1)

    def test_ranked_seeds_take_priority_for_byes(self):
        # Four BYEs, three protected seeds: all top-ranked seeds have BYEs.
        draw=fixtures_fn(players(28),"Singles",seed_by_rank=True)
        byes=[d for d in draw if d["side_b"]=="Bye"]
        self.assertEqual(len(byes),4)
        self.assertTrue(
            {"Player 1","Player 2","Player 3"}.issubset(
                {d["side_a"] for d in byes}
            )
        )
        # Top two protected seeds are in opposite halves of the bracket.
        pos={d["side_a"]:i for i,d in enumerate(draw)}
        self.assertNotEqual(pos["Player 1"]//8,pos["Player 2"]//8)

    def test_top_ranked_without_bye_gets_actual_opponent(self):
        # 30 entrants -> 2 BYEs but 3 protected seeds.
        draw=fixtures_fn(players(30),"Singles",seed_by_rank=True)
        bye_players={d["side_a"] for d in draw if d["side_b"]=="Bye"}
        self.assertEqual(bye_players,{"Player 1","Player 2"})
        seeded_three=next(d for d in draw if d["side_a"]=="Player 3")
        self.assertNotEqual(seeded_three["side_b"],"Bye")

    def test_doubles_teams_and_ids_are_intact(self):
        teams=[{"name":f"Team {i}","ids":f"{i*2-1},{i*2}"} for i in range(1,12)]
        for seeded in (False,True):
            with self.subTest(seeded=seeded):
                draw=fixtures_fn([],"Doubles",doubles_pairs=teams,seed_by_rank=seeded)
                self.assertEqual(len(draw),8)
                self.assertEqual(len(bye_indices(draw)),5)
                actual={}
                for match in draw:
                    actual[match["side_a"]]=match["side_a_player_ids"]
                    if match["side_b"]!="Bye":
                        actual[match["side_b"]]=match["side_b_player_ids"]
                self.assertEqual(actual,{t["name"]:t["ids"] for t in teams})

    def test_bye_winner_contract_remains_compatible_with_auto_advance(self):
        # random_draw_impl records these as complete with side_a as winner;
        # next-round pairs fixed match numbers 1/2, 3/4, 5/6, etc.
        draw=fixtures_fn(players(20),"Singles")
        winners=[]
        for item in draw:
            if item["side_b"]=="Bye":
                self.assertNotEqual(item["side_a"],"Bye")
                self.assertEqual(item["side_b_player_ids"],"")
            # A complete normal game would return its winner in this slot.
            winners.append(item["side_a"])
        next_round=[(winners[i],winners[i+1])
                    for i in range(0,len(winners),2)]
        self.assertEqual(len(next_round),len(draw)//2)
        self.assertEqual(next_round[0],(draw[0]["side_a"],draw[1]["side_a"]))


if __name__=="__main__":
    unittest.main()
