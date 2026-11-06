"""Regression: scatter BYEs across knockout branches without changing advancement."""
import ast
import random
import unittest
from pathlib import Path

SOURCE=Path(__file__).resolve().parents[1]/"app.py"
tree=ast.parse(SOURCE.read_text(encoding="utf-8"))
required={"_protected_seed_count","_balanced_bracket_order","build_fixtures"}
nodes=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in required]
assert {node.name for node in nodes}==required, "BYE allocation helpers missing"
scope={}
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),"exec"),scope)
order_fn=scope["_balanced_bracket_order"]
fixtures_fn=scope["build_fixtures"]


def players(n):
    return [{"id":i,"full_name":f"Player {i}"} for i in range(1,n+1)]


def bye_indices(fixtures):
    return [i for i,f in enumerate(fixtures) if f["side_b"]=="Bye"]


class ByeDistributionTests(unittest.TestCase):
    def test_balanced_match_order_for_32_slot_bracket(self):
        # All 8 BYEs are spread throughout the 16 first-round matches.
        self.assertEqual(order_fn(16)[:8],[0,8,4,12,2,10,6,14])

    def test_bracket_orders_have_every_slot_once(self):
        for m in (1,2,4,8,16,32,64,128):
            with self.subTest(matches=m):
                indices=order_fn(m)
                self.assertEqual(sorted(indices),list(range(m)))
        for invalid in (0,3,5,12):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    order_fn(invalid)

    def test_all_player_counts_are_valid_with_and_without_seeds(self):
        random.seed(2026)
        for n in range(2,129):
            for seeded in (False,True):
                with self.subTest(players=n,seeded=seeded):
                    result=fixtures_fn(players(n),"Singles",seed_by_rank=seeded)
                    slots=1<<(n-1).bit_length()
                    self.assertEqual(len(result),slots//2)
                    self.assertEqual([m["match_no"] for m in result],list(range(1,slots//2+1)))
                    self.assertEqual(len(bye_indices(result)),slots-n)
                    self.assertTrue(all(m["side_a"]!="Bye" for m in result))
                    ids=[int(m["side_a_player_ids"]) for m in result]
                    ids += [int(m["side_b_player_ids"]) for m in result if m["side_b"]!="Bye"]
                    self.assertEqual(sorted(ids),list(range(1,n+1)))

    def test_eight_byes_do_not_cluster_in_same_advancement_branch(self):
        result=fixtures_fn(players(24),"Singles",seed_by_rank=False)
        bye_set=set(bye_indices(result))
        self.assertEqual(len(bye_set),8)
        for pair in range(8):
            self.assertEqual(len(bye_set.intersection({pair*2,pair*2+1})),1)

    def test_four_byes_cover_all_quarters(self):
        result=fixtures_fn(players(28),"Singles",seed_by_rank=False)
        bye_set=set(bye_indices(result))
        self.assertEqual(bye_set,{0,8,4,12})
        for quarter in range(4):
            indices=set(range(quarter*4,(quarter+1)*4))
            self.assertEqual(len(bye_set&indices),1)

    def test_bye_positions_cover_halves_quarters_and_eighths(self):
        for n in (24,28,36,48,56,68,96,112):
            for seeded in (False,True):
                with self.subTest(n=n,seeded=seeded):
                    f=fixtures_fn(players(n),"Singles",seed_by_rank=seeded)
                    m=len(f)
                    byes=bye_indices(f)
                    for partitions in (2,4,8):
                        if m>=partitions and len(byes)>=partitions:
                            for part in range(partitions):
                                self.assertTrue(any(
                                    part*(m//partitions) <= pos < (part+1)*(m//partitions)
                                    for pos in byes
                                ),f"Bye gap in partition {part}/{partitions} for {n}")

    def test_top_ranked_seeds_get_priority_and_stay_apart(self):
        # 28 entrants: 32 slots, 4 byes and 3 protected seeds.
        f=fixtures_fn(players(28),"Singles",seed_by_rank=True)
        self.assertEqual(set(bye_indices(f)),{0,4,8,12})
        self.assertEqual(f[0]["side_a"],"Player 1")
        self.assertEqual(f[8]["side_a"],"Player 2")
        self.assertEqual(f[4]["side_a"],"Player 3")
        self.assertEqual(f[0]["side_b"],"Bye")
        self.assertEqual(f[8]["side_b"],"Bye")
        self.assertEqual(f[4]["side_b"],"Bye")

    def test_seed_without_bye_has_a_real_opponent(self):
        # 30 entrants have only 2 byes; rank 3 gets an actual opponent.
        f=fixtures_fn(players(30),"Singles",seed_by_rank=True)
        self.assertEqual(set(bye_indices(f)),{0,8})
        self.assertEqual(f[4]["side_a"],"Player 3")
        self.assertNotEqual(f[4]["side_b"],"Bye")

    def test_doubles_team_ids_remain_linked_to_names(self):
        teams=[{"name":f"Team {i}","ids":f"{i*2-1},{i*2}"} for i in range(1,12)]
        f=fixtures_fn([],"Doubles",doubles_pairs=teams,seed_by_rank=False)
        self.assertEqual(len(f),8)
        self.assertEqual(len(bye_indices(f)),5)
        pairs={}
        for match in f:
            pairs[match["side_a"]]=match["side_a_player_ids"]
            if match["side_b"]!="Bye":
                pairs[match["side_b"]]=match["side_b_player_ids"]
        self.assertEqual(pairs,{t["name"]:t["ids"] for t in teams})

    def test_generated_byes_are_completions_not_real_scores(self):
        # Existing persistence contract: these fixtures will be marked complete
        # by random_draw_impl, never presented for manual scoring.
        f=fixtures_fn(players(20),"Singles",seed_by_rank=False)
        for fixture in f:
            if fixture["side_b"]=="Bye":
                self.assertNotEqual(fixture["side_a"],"Bye")
                self.assertEqual(fixture["side_b_player_ids"],"")


if __name__=="__main__":
    unittest.main()
