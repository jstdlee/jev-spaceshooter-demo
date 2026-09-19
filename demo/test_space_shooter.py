import json
import math
import socket
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import space_shooter_server as server


def valid_state(**overrides):
    state = {
        "epoch": 7,
        "sequence": 12,
        "player": {"x": 480, "y": 408},
        "previous_action": "hold",
        "candidates": [
            {"id": "hold", "clearance_px": 50, "center_cost": 0, "room_px": 183, "switch_cost": 0, "soft_cost": 0},
            {"id": "left", "clearance_px": 45, "center_cost": 0, "room_px": 183, "switch_cost": 1, "soft_cost": 0.1},
        ],
    }
    state.update(overrides)
    return state


class RequestTests(unittest.TestCase):
    def test_request_has_one_supported_choice_and_omits_unrecognized_state(self):
        request = server.build_decision_request(valid_state(raw_threats=[{"secret": 1}], wave=99))
        self.assertEqual(set(request["questions"]), {"movement"})
        movement = request["questions"]["movement"]
        self.assertEqual(movement["type"], "choice")
        self.assertEqual(set(movement["criteria"]), {"hold", "left"})
        self.assertEqual(request["samples"], 1)
        self.assertIn("Local swept collision checks", request["instructions"])
        self.assertIn("Select exactly one eligible action", movement["instructions"])
        self.assertNotIn("raw_threats", request["state"])
        self.assertNotIn("wave", request["state"])
        self.assertEqual(request["state"]["action_ms"], 240)
        self.assertEqual(request["state"]["horizon_ms"], 600)

    def test_request_rejects_bad_candidate_containers_counts_and_ids(self):
        base = valid_state()["candidates"]
        invalid = [
            {}, valid_state(candidates=None), valid_state(candidates=[base[0]]),
            valid_state(candidates=base * 5), valid_state(candidates=[base[0], base[0]]),
            valid_state(candidates=[base[0], {**base[1], "id": "warp"}]),
        ]
        for state in invalid:
            with self.subTest(state=state):
                with self.assertRaises(server.RequestValidationError):
                    server.build_decision_request(state)

    def test_request_rejects_invalid_metadata_and_nonfinite_features(self):
        base = valid_state()["candidates"]
        invalid = [
            valid_state(epoch=True), valid_state(sequence=-1),
            valid_state(player={"x": math.nan, "y": 1}),
            valid_state(candidates=[base[0], {**base[1], "soft_cost": math.inf}]),
            valid_state(candidates=[base[0], {**base[1], "clearance_px": "far"}]),
        ]
        for state in invalid:
            with self.subTest(state=state):
                with self.assertRaises(server.RequestValidationError):
                    server.build_decision_request(state)


class NormalizationTests(unittest.TestCase):
    def test_documented_choice_normalizes_and_echoes_request_identity(self):
        response = {"epoch": 999, "sequence": 999, "answers": {"movement": {"choice": "left", "confidence": 1.7}}}
        result = server.normalize_decision(response, valid_state())
        self.assertEqual(result["movement"], "left")
        self.assertTrue(result["valid_choice"])
        self.assertEqual(result["confidence"], 1.0)
        self.assertEqual((result["epoch"], result["sequence"]), (7, 12))

    def test_malformed_shapes_and_unoffered_choices_are_invalid_without_fallback_choice(self):
        responses = [
            None, [], {}, {"answers": None}, {"answers": []},
            {"answers": {"movement": None}}, {"answers": {"movement": []}},
            {"answers": {"movement": "left"}}, {"answers": {"movement": {}}},
            {"answers": {"movement": {"choice": "right"}}},
            {"answers": {"movement": {"choice": 42}}},
        ]
        for response in responses:
            with self.subTest(response=response):
                result = server.normalize_decision(response, valid_state())
                self.assertIsNone(result["movement"])
                self.assertFalse(result["valid_choice"])
                self.assertIsNotNone(result["error"])

    def test_bad_confidence_is_null_not_invented_certainty(self):
        for confidence in (None, "high", math.nan, math.inf):
            response = {"answers": {"movement": {"choice": "hold", "confidence": confidence}}}
            with self.subTest(confidence=confidence):
                self.assertIsNone(server.normalize_decision(response, valid_state())["confidence"])


class DecisionCallTests(unittest.TestCase):
    @mock.patch.object(server, "_call_djev")
    def test_valid_reply_preserves_usage_latency_and_truthful_token_throughput(self, call):
        call.return_value = ({"answers": {"movement": {"choice": "left", "confidence": 0.75}}}, 0.5, {"input_tokens": 80, "output_tokens": 20})
        result = server.decide(valid_state())
        self.assertTrue(result["api_ok"])
        self.assertEqual(result["latency_ms"], 500.0)
        self.assertEqual(result["usage"], {"input_tokens": 80, "output_tokens": 20})
        self.assertEqual(result["api_token_throughput"], 200.0)
        self.assertNotIn("result_speed", result)
        self.assertNotIn("token_tps", result)

    @mock.patch.object(server, "_call_djev")
    def test_successful_api_with_invalid_choice_is_not_transport_failure(self, call):
        call.return_value = ({"answers": {"movement": {"choice": "right"}}}, 0.1, {"input_tokens": 1, "output_tokens": 1})
        result = server.decide(valid_state())
        self.assertTrue(result["api_ok"])
        self.assertFalse(result["valid_choice"])
        self.assertIsNone(result["movement"])

    @mock.patch.object(server, "_call_djev")
    def test_network_timeout_url_and_json_failures_stay_failures(self, call):
        failures = [TimeoutError("slow"), socket.timeout("slow"), urllib.error.URLError("offline"), json.JSONDecodeError("bad", "{", 0)]
        for failure in failures:
            call.side_effect = failure
            with self.subTest(failure=type(failure).__name__):
                result = server.decide(valid_state())
                self.assertFalse(result["api_ok"])
                self.assertFalse(result["valid_choice"])
                self.assertIsNone(result["movement"])
                self.assertIsNone(result["usage"]["input_tokens"])
                self.assertGreaterEqual(result["latency_ms"], 0)

    @mock.patch.object(server, "_call_djev")
    def test_invalid_request_fails_before_upstream_call(self, call):
        with self.assertRaises(server.RequestValidationError):
            server.decide(valid_state(epoch=True))
        call.assert_not_called()


class PageSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = Path(__file__).with_name("space-shooter.html").read_text(encoding="utf-8")

    def test_single_page_has_game_decision_panels_and_only_decision_route(self):
        self.assertIn('id="game-panel"', self.html)
        self.assertIn('id="decision-panel"', self.html)
        self.assertIn('fetch("/api/decision"', self.html)
        self.assertNotIn("/api/trajectory", self.html)

    def test_page_has_inline_core_and_no_bomb_language(self):
        self.assertIn('<script id="space-decision-core">', self.html)
        self.assertNotIn("bomb", self.html.lower())


if __name__ == "__main__":
    unittest.main()
