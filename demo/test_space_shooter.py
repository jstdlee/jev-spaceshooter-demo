import datetime as real_datetime
import hashlib
import io
import json
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import space_shooter_server as server


def html_fixture(core="core-source", controller="controller-source"):
    return (
        "<html><body>"
        f'<script id="space-decision-core">{core}</script>'
        f'<script id="space-djev-controller">{controller}</script>'
        "</body></html>"
    )


def source_hash(core="core-source", controller="controller-source"):
    return hashlib.sha256(f"{core}\n{controller}".encode("utf-8")).hexdigest()


def start_body(engine_hash=None):
    return {
        "schema_version": 1,
        "manifest": {
            "seed": 20260920,
            "profile": "hardest",
            "difficulty": {
                "bulletDensity": 4,
                "enemyDensity": 3,
                "fastBulletRatio": 0.85,
                "fastBulletSpeed": 2.4,
            },
            "engine_version": "slice-a-test",
            "engine_hash": engine_hash or source_hash(),
            "dt_ms": 1000 / 60,
            "prompt_version": "djev-authoritative-v2",
            "context_version": "djev-observation-v2",
            "mode": "cli",
            "rules": {
                "player_speed_px_s": 112,
                "lease_ticks": {"short": 15, "medium": 30},
            },
        },
    }


def candidate(movement):
    return {
        "id": movement,
        "short": {
            "endpoint": {"x": 480.123, "y": 407.987},
            "contact_ms": None,
            "clearance_px": 37.25,
            "enemy_clearance_px": None,
            "edge_distances_px": {"left": 460.123, "right": 459.877, "top": 398.987, "bottom": 193.013},
            "shot_eta_ms": 218.75,
        },
        "medium": {
            "endpoint": {"x": 481.456, "y": 406.654},
            "contact_ms": 125.0 if movement == "left" else None,
            "clearance_px": 28.75,
            "enemy_clearance_px": 64.25,
            "edge_distances_px": {"left": 461.456, "right": 458.544, "top": 397.654, "bottom": 194.346},
            "shot_eta_ms": None,
        },
    }


def decision_body(run_id):
    return {
        "schema_version": 1,
        "run_id": run_id,
        "epoch": 3,
        "sequence": 4,
        "snapshot_tick": 120,
        "client_send_wall_ms": 2000.5,
        "state": {
            "tick": 120,
            "sim_ms": 2000.0,
            "wave": 2,
            "difficulty": {
                "bulletDensity": 4,
                "enemyDensity": 3,
                "fastBulletRatio": 0.85,
                "fastBulletSpeed": 2.4,
            },
            "player": {
                "x": 480.12,
                "y": 408.34,
                "w": 20,
                "h": 18,
                "lives": 3,
                "cooldown_ms": 40.25,
                "invulnerability_ms": 0,
            },
            "active_command": {
                "decision_id": "old-decision",
                "sequence": 3,
                "movement": "up",
                "fire": "shoot",
                "lease": "short",
                "remaining_ms": 83.34,
                "intent": "evade",
            },
            "last_intent": "recover",
            "enemy_fire_in_ms": 155.5,
            "threat_counts": {"enemies": 6, "enemy_bullets": 11, "nearest_threats_total": 17},
            "nearest_threats": [
                {"kind": "bullet", "x": 500, "y": 320, "vx": 0, "vy": 405.25, "w": 8, "h": 8},
                {"kind": "enemy", "x": 420, "y": 130, "vx": 15, "vy": 0, "w": 26, "h": 20},
            ],
            "recent_commands": [
                {"movement": "left", "fire": "cease", "lease": "medium", "elapsed_ms": 500, "dx": -56, "dy": 0, "source": "djev"},
                {"movement": "up", "fire": "shoot", "lease": "short", "elapsed_ms": 250, "dx": 0, "dy": -28, "source": "djev"},
                {"movement": "hold", "fire": "cease", "lease": None, "elapsed_ms": 66.7, "dx": 0, "dy": 0, "source": "neutral"},
            ],
            "recent_hits": [
                {"ago_ms": 4500, "kind": "enemy", "x": 430, "y": 390, "vx": 0, "vy": 0, "lives_after": 3},
                {"ago_ms": 1200, "kind": "bullet", "x": 481, "y": 403, "vx": 0, "vy": 405, "lives_after": 2},
                {"ago_ms": 200, "kind": "bullet", "x": 482, "y": 402, "vx": 0, "vy": 405, "lives_after": 1},
            ],
        },
        "forecast": {
            "expected_delay_ms": 260,
            "latency_samples": 0,
            "latency_spread_ms": 0,
            "horizon_ms": 760,
            "prefix": {"authorized_remaining_ms": 83.34, "contact_ms": None},
            "assumptions": {
                "enemy_motion": "current_linear",
                "future_spawns_included": False,
                "contact_window": "after_arrival_while_vulnerable",
                "enemy_clearance_window": "after_arrival",
            },
            "candidates": [candidate(movement) for movement in server.ACTION_IDS],
        },
        "checkpoint": {"seed": 20260920, "rng_state": "must stay out of upstream", "tick": 120},
    }


class BackendContractTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.html_path = self.root / "space-shooter.html"
        self.html_path.write_text(html_fixture(), encoding="utf-8")
        self.strategy_path = self.root / "strategy.md"
        self.strategy_text = (
            "version: djev-authoritative-v2\n"
            "Prioritize survival and useful fire. Shooting has no movement penalty and no ammo cost.\n"
        )
        self.strategy_path.write_text(self.strategy_text, encoding="utf-8")
        self.runs_dir = self.root / "runs"
        self.addCleanup(self.tempdir.cleanup)
        self.patches = [
            mock.patch.object(server, "HTML_PATH", self.html_path),
            mock.patch.object(server, "STRATEGY_PATH", self.strategy_path),
            mock.patch.object(server, "RUNS_DIR", self.runs_dir),
        ]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        server.reset_runtime_for_tests()

    def read_records(self, run_id):
        events_path = self.runs_dir / run_id / "events.jsonl"
        return [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]

    def start_run(self):
        return server.start_run(start_body())

    def test_provider_config_uses_environment_defaults_and_rejects_unsafe_values(self):
        with mock.patch.dict(server.os.environ, {
            "DJEV_URL": "http://127.0.0.1:8011/", "DJEV_MODEL": "default-model",
        }, clear=True):
            self.assertEqual(server.validate_provider_config({}), {
                "url": "http://127.0.0.1:8011", "model": "default-model",
            })
            for url in (
                "file:///tmp/api", "http://user:pass@example.test", "https://example.test/?token=x",
                "https://example.test/#fragment", "https://example.test/v1/systemone",
                "http://[broken", "http://example.test:bad",
            ):
                with self.subTest(url=url), self.assertRaises(server.RequestValidationError):
                    server.validate_provider_config({"url": url, "model": "m"})
            for provider in (
                {"url": "http://example.test", "model": "  "},
                {"url": "http://example.test", "model": "m" * (server.MAX_MODEL_LEN + 1)},
                {"url": "http://example.test", "model": "m", "api_key": "secret"},
            ):
                with self.subTest(provider=provider), self.assertRaises(server.RequestValidationError):
                    server.validate_provider_config(provider)

    def test_provider_settings_are_captured_per_run_and_used_for_upstream_calls(self):
        response_body = {
            "model": "fixture-response",
            "answers": {
                "intent": {"choice": "position", "confidence": 0.9},
                "path": {"choice": "hold__medium", "confidence": 0.9},
                "fire": {"choice": "shoot", "confidence": 0.9},
            },
        }
        captured = []

        def capture_request(request, *, timeout):
            captured.append((request.full_url, json.loads(request.data)))
            raw = io.BytesIO(json.dumps(response_body).encode("utf-8"))
            raw.status = 200
            return raw

        with mock.patch.dict(server.os.environ, {"DJEV_API_KEY": "secret-fixture"}, clear=True), \
                mock.patch.object(server.urllib.request, "urlopen", side_effect=capture_request):
            runs = []
            for url, model in (("http://first.example/", "first-model"),
                               ("https://provider.example/api/jev/", "second-model")):
                body = start_body()
                body["provider"] = {"url": url, "model": model}
                runs.append(server.start_run(body))

            for run in runs:
                result = server.handle_decision(decision_body(run["run_id"]))
                self.assertTrue(result["valid_choice"])

        self.assertEqual([url for url, _ in captured], [
            "http://first.example/v1/systemone",
            "https://provider.example/api/jev/v1/systemone",
        ])
        self.assertEqual([request["model"] for _, request in captured], ["first-model", "second-model"])
        for run in runs:
            records = self.read_records(run["run_id"])
            self.assertEqual(records[0]["manifest"]["provider"]["model"], records[0]["model_identity"]["configured_model"])
            self.assertNotIn("secret-fixture", json.dumps(records))

    def test_get_api_config_exposes_only_safe_effective_provider_values(self):
        with mock.patch.dict(server.os.environ, {
            "DJEV_URL": "https://provider.example/api/jev/", "DJEV_MODEL": "default-model",
            "DJEV_API_KEY": "secret-fixture",
        }, clear=True):
            httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(httpd.server_close)
            self.addCleanup(thread.join, 1)
            self.addCleanup(httpd.shutdown)
            with server.urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_port}/api/config") as response:
                body = response.read().decode("utf-8")
            self.assertEqual(json.loads(body), {
                "schema_version": 1,
                "provider": {"url": "https://provider.example/api/jev", "model": "default-model"},
            })
            self.assertNotIn("secret-fixture", body)

    def test_run_start_pins_prompt_source_hash_and_runtime_without_auth_secrets(self):
        result = self.start_run()
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["prompt_version"], "djev-authoritative-v2")
        expected_prompt_hash = hashlib.sha256(
            "Prioritize survival and useful fire. Shooting has no movement penalty and no ammo cost.\n".encode("utf-8")
        ).hexdigest()
        self.assertEqual(result["prompt_hash"], expected_prompt_hash)
        self.assertTrue((self.runs_dir / result["run_id"] / "events.jsonl").exists())

        manifest_record = self.read_records(result["run_id"])[0]
        self.assertEqual(manifest_record["record_type"], "run_started")
        self.assertEqual(manifest_record["context_version"], "djev-observation-v2")
        self.assertEqual(manifest_record["engine_source_hash"], source_hash())
        self.assertEqual(manifest_record["prompt_text"], "Prioritize survival and useful fire. Shooting has no movement penalty and no ammo cost.\n")
        self.assertIn("configured_model", manifest_record["model_identity"])
        self.assertNotIn("authorization", json.dumps(manifest_record).lower())
        with self.assertRaises(server.RequestValidationError):
            server.start_run(start_body(engine_hash="0" * 64))

    def test_run_start_uses_python310_compatible_utc_timezone_api(self):
        python310_datetime = types.SimpleNamespace(
            datetime=real_datetime.datetime,
            timezone=real_datetime.timezone,
        )
        with mock.patch.object(server, "_dt", python310_datetime):
            result = self.start_run()

        self.assertRegex(result["run_id"], r"^run-\d{8}T\d{6}Z-")
        manifest_record = self.read_records(result["run_id"])[0]
        self.assertRegex(manifest_record["recorded_at_utc"], r"Z$")
        self.assertRegex(manifest_record["server_time_utc"], r"Z$")

    def test_run_start_rejects_v1_manifest_versions(self):
        for field, old_version in (("prompt_version", "djev-authoritative-v1"), ("context_version", "djev-observation-v1")):
            with self.subTest(field=field):
                body = start_body()
                body["manifest"][field] = old_version
                with self.assertRaises(server.RequestValidationError):
                    server.start_run(body)

    def test_inline_center_progress_is_signed_distance_change_and_gap_can_be_null(self):
        for end_y, progress in ((494, 56.0), (550, 0.0), (606, -56.0)):
            with self.subTest(end_y=end_y):
                body = decision_body("geometry-fixture")
                body["state"]["player"].update(x=480, y=550)
                body["state"]["player"]["private_extra"] = "not model-visible"
                prediction = body["forecast"]["candidates"][0]["medium"]
                prediction["endpoint"] = {"x": 480, "y": end_y}
                prediction["clearance_px"] = None
                packed = server.pack_model_context(body)
                self.assertNotIn("paths", packed)
                self.assertIn("hold_gap_px", packed)
                self.assertIsNone(packed["hold_gap_px"])
                self.assertEqual(server.build_path_criteria(body)["hold__medium"],
                                 f"collision=false; collision_ms=None; gap_px=None; center_progress={progress}; wall_room=194.346.")
                self.assertEqual(list(packed["player"]), ["x", "y", "w", "h", "lives", "cooldown_ms", "invulnerability_ms"])
                self.assertNotIn("private_extra", packed["player"])
                self.assertEqual(body["state"]["player"]["private_extra"], "not model-visible")

    def test_inside_center_region_uses_inclusive_raw_coordinate_boundaries(self):
        cases = [
            (480, 310, True), (360, 230, True), (600, 390, True),
            (360, 390, True), (600, 230, True),
            (359.99, 310, False), (600.01, 310, False),
            (480, 229.99, False), (480, 390.01, False),
            (10, 9, False), (950, 611, False),
        ]
        for x, y, expected in cases:
            with self.subTest(x=x, y=y):
                body = decision_body("region-fixture")
                body["state"]["player"].update(x=x, y=y)
                packed = server.pack_model_context(body)
                self.assertIs(packed.get("inside_center_region"), expected)

    def test_hold_collision_and_inline_contact_preserve_null_zero_and_precision_by_id(self):
        cases = [(None, False), (0, True), (0.04, True), (322.64, True), (391.24, True)]
        for contact, expected in cases:
            with self.subTest(contact=contact):
                body = decision_body("hold-contact-fixture")
                body["forecast"]["prefix"]["contact_ms"] = 999
                body["forecast"]["candidates"][0]["short"]["contact_ms"] = 7
                body["forecast"]["candidates"][0]["medium"]["contact_ms"] = contact
                body["forecast"]["candidates"].reverse()
                packed = server.pack_model_context(body)
                self.assertIs(packed.get("hold_collision"), expected)
                criteria = server.build_path_criteria(body)
                self.assertEqual(next(iter(criteria)), "hold__medium")
                self.assertEqual(criteria["hold__medium"],
                                 f"collision={str(expected).lower()}; collision_ms={contact}; gap_px=28.75; center_progress=1.7; wall_room=194.346.")
                self.assertEqual(packed["hold_gap_px"], 28.75)
                self.assertEqual(packed["wait_collision_ms"], 999)
                self.assertEqual(body["forecast"]["candidates"][-1]["medium"]["contact_ms"], contact)

    def test_inline_criteria_keep_all_nine_colliding_paths_in_fixed_order(self):
        body = decision_body("all-colliding")
        for candidate in body["forecast"]["candidates"]:
            candidate["medium"]["contact_ms"] = 0
            candidate["medium"]["clearance_px"] = -0.25
        body["forecast"]["candidates"].reverse()

        criteria = server.build_path_criteria(body)

        self.assertEqual(list(criteria), [
            "hold__medium", "left__medium", "right__medium", "up__medium", "down__medium",
            "up_left__medium", "up_right__medium", "down_left__medium", "down_right__medium",
        ])
        for criterion in criteria.values():
            self.assertEqual(criterion, "collision=true; collision_ms=0; gap_px=-0.25; center_progress=1.7; wall_room=194.346.")
        self.assertEqual(server.pack_model_context(body)["hold_gap_px"], -0.25)

    def test_hold_contact_packing_rejects_invalid_or_ambiguous_forecasts(self):
        for contact in (-1, True, "none", float("inf")):
            with self.subTest(contact=contact):
                body = decision_body("invalid-hold-contact")
                body["forecast"]["candidates"][0]["medium"]["contact_ms"] = contact
                with self.assertRaises(server.RequestValidationError):
                    server.pack_model_context(body)
        for changed_index in (0, 1):
            with self.subTest(changed_index=changed_index):
                body = decision_body("ambiguous-hold-contact")
                body["forecast"]["candidates"][changed_index]["id"] = "left" if changed_index == 0 else "hold"
                with self.assertRaises(server.RequestValidationError):
                    server.pack_model_context(body)

    def test_table_rejects_nonfinite_or_invalid_required_observations(self):
        cases = [
            (("state", "player", "x"), float("nan")),
            (("state", "player", "w"), None),
            (("state", "player", "h"), True),
            (("state", "player", "cooldown_ms"), -1),
            (("state", "player", "invulnerability_ms"), float("inf")),
            (("state", "player", "lives"), 1.5),
            (("state", "threat_counts", "enemies"), -1),
            (("forecast", "expected_delay_ms"), float("inf")),
            (("forecast", "prefix", "contact_ms"), -1),
            (("forecast", "candidates", 8, "medium", "clearance_px"), float("inf")),
            (("forecast", "candidates", 8, "medium", "endpoint", "x"), True),
            (("forecast", "candidates", 8, "medium", "edge_distances_px", "right"), -1),
        ]
        for field_path, value in cases:
            with self.subTest(field=field_path):
                body = decision_body("invalid-table")
                target = body
                for key in field_path[:-1]:
                    target = target[key]
                target[field_path[-1]] = value
                with self.assertRaises(server.RequestValidationError):
                    server.pack_model_context(body)
        for missing in ("contact_ms", "clearance_px"):
            with self.subTest(missing=missing):
                body = decision_body("missing-table-fact")
                del body["forecast"]["candidates"][8]["medium"][missing]
                with self.assertRaises(server.RequestValidationError):
                    server.pack_model_context(body)

    def test_normalization_preserves_every_model_intent_path_and_fire_combination(self):
        movements = ("hold", "left", "right", "up", "down", "up_left", "up_right", "down_left", "down_right")
        for intent in ("evade", "recover", "position"):
            for movement in movements:
                for fire in ("shoot", "cease"):
                    with self.subTest(intent=intent, movement=movement, fire=fire):
                        response = {"answers": {
                            "intent": {"choice": intent, "confidence": 0.65},
                            "path": {"choice": f"{movement}__medium", "confidence": 0.75},
                            "fire": {"choice": fire, "confidence": 0.85},
                        }}
                        result = server.normalize_decision_response(response)
                        self.assertIn("intent", result)
                        self.assertTrue(result["valid_choice"])
                        self.assertEqual((result["intent"], result["movement"], result["fire"], result["lease"]), (intent, movement, fire, "medium"))
                        self.assertEqual(result["confidence"], {"intent": 0.65, "path": 0.75, "movement": 0.75, "fire": 0.85, "lease": 0.75})

    @mock.patch.object(server, "_call_djev")
    def test_missing_or_invalid_intent_is_atomic_and_preserved_in_raw_trace(self, call):
        run = self.start_run()
        cases = [
            (None, "missing_intent"),
            ("recover", "invalid_intent_answer"),
            ({"choice": "retreat", "confidence": 0.9}, "unknown_intent_choice"),
            ({"choice": 1}, "invalid_intent_choice_type"),
        ]
        for sequence, (intent_answer, error) in enumerate(cases):
            with self.subTest(intent=intent_answer):
                parsed = {"model": "dgemma", "answers": {
                    "path": {"choice": "left__medium", "confidence": 0.9},
                    "fire": {"choice": "shoot", "confidence": 0.8},
                }}
                if intent_answer is not None:
                    parsed["answers"]["intent"] = intent_answer
                call.return_value = server.UpstreamResult(parsed, json.dumps(parsed), 200, 0.1, {"input_tokens": 50, "output_tokens": 5})
                body = decision_body(run["run_id"])
                body["sequence"] = sequence
                result = server.handle_decision(body)
                self.assertTrue(result["api_ok"])
                self.assertFalse(result["valid_choice"])
                for key in ("intent", "movement", "fire", "lease"):
                    self.assertIn(key, result)
                    self.assertIsNone(result[key])
                self.assertEqual(result["confidence"], {"intent": None, "path": None, "movement": None, "fire": None, "lease": None})
                self.assertEqual(result["error"], error)
                record = self.read_records(run["run_id"])[-1]
                self.assertEqual(record["rawsnapshot"], body)
                self.assertEqual(record["rawupstreamresponse"]["body"], json.dumps(parsed))
                self.assertEqual(record["normalized"], result)

    @mock.patch.object(server, "_call_djev")
    def test_upstream_and_context_errors_return_and_log_null_intent(self, call):
        run = self.start_run()
        for failure in ("transport", "http", "budget"):
            with self.subTest(failure=failure):
                call.reset_mock(side_effect=True)
                if failure == "transport":
                    call.side_effect = TimeoutError("fixture timeout")
                else:
                    parsed = {"answers": {"intent": {"choice": "recover"}, "path": {"choice": "right__medium"}, "fire": {"choice": "shoot"}}}
                    call.return_value = server.UpstreamResult(parsed, json.dumps(parsed), 503, 0.1, {"input_tokens": None, "output_tokens": None}, "HTTPError: 503")
                with mock.patch.object(server, "MAX_PACKED_STATE_CHARS", 1 if failure == "budget" else 6000):
                    result = server.handle_decision(decision_body(run["run_id"]))
                if failure == "budget":
                    call.assert_not_called()
                self.assertFalse(result["api_ok"])
                self.assertFalse(result["valid_choice"])
                for key in ("intent", "movement", "fire", "lease"):
                    self.assertIn(key, result)
                    self.assertIsNone(result[key])
                self.assertEqual(result["confidence"], {"intent": None, "path": None, "movement": None, "fire": None, "lease": None})
                records = self.read_records(run["run_id"])
                response_record = records[-1]
                self.assertEqual(response_record["normalized"], result)
                self.assertIn("exactrequestbody", response_record)
                if failure == "budget":
                    self.assertIsNone(response_record["exactrequestbody"])
                else:
                    request_record = next(record for record in reversed(records) if record["record_type"] == "decision_request")
                    self.assertEqual(response_record["exactrequestbody"], request_record["exactrequestbody"])
                    self.assertEqual(json.loads(response_record["exactrequestbody"]), response_record["exactactualpayload"])

    @mock.patch.object(server, "_load_env_file")
    @mock.patch.object(server.urllib.request, "urlopen")
    def test_exact_request_body_precedes_transport_and_preserves_wire_order_without_credentials(self, urlopen, _load_env):
        api_key = "fixture-api-key-never-in-trace"
        response_body = {
            "model": "dgemma",
            "answers": {
                "intent": {"choice": "recover", "confidence": 0.9},
                "path": {"choice": "left__medium", "confidence": 0.8},
                "fire": {"choice": "shoot", "confidence": 0.7},
            },
            "usage": {"input_tokens": 100, "output_tokens": 12},
        }
        env = {"DJEV_URL": "http://djev.invalid:8011", "DJEV_MODEL": "fixture-model", "DJEV_API_KEY": api_key}
        with mock.patch.dict(server.os.environ, env, clear=True):
            for outcome in ("success", "http_error", "timeout"):
                with self.subTest(outcome=outcome):
                    run = self.start_run()
                    wire_bodies = []

                    def capture_request(request, *, timeout):
                        wire_bodies.append(request.data)
                        self.assertEqual(request.get_header("Authorization"), f"Bearer {api_key}")
                        records = self.read_records(run["run_id"])
                        self.assertEqual([record["record_type"] for record in records], ["run_started", "decision_request"])
                        record = records[-1]
                        self.assertIn("exactrequestbody", record)
                        self.assertEqual(record["exactrequestbody"].encode("utf-8"), request.data)
                        sent = json.loads(request.data)
                        self.assertEqual(sent.get("steps"), 1)
                        self.assertEqual(sent.get("samples"), 1)
                        self.assertEqual(sent, record["exactactualpayload"])
                        self.assertEqual(list(sent["state"]), [
                            "player", "inside_center_region", "hold_collision", "wait_ms", "wait_collision_ms", "enemy_count", "hold_gap_px",
                        ])
                        self.assertEqual(list(sent["questions"]), ["intent", "path", "fire"])
                        self.assertEqual(list(sent["questions"]["intent"]["criteria"]), ["evade", "recover", "position"])
                        self.assertEqual(list(sent["questions"]["path"]["criteria"]), [
                            "hold__medium", "left__medium", "right__medium", "up__medium", "down__medium",
                            "up_left__medium", "up_right__medium", "down_left__medium", "down_right__medium",
                        ])
                        self.assertNotIn("paths", sent["state"])
                        self.assertEqual(sent["state"]["hold_gap_px"], 28.75)
                        self.assertEqual(sent["questions"]["path"]["criteria"]["left__medium"],
                                         "collision=true; collision_ms=125.0; gap_px=28.75; center_progress=1.7; wall_room=194.346.")
                        self.assertEqual(list(sent["questions"]["fire"]["criteria"]), ["shoot", "cease"])
                        if outcome == "timeout":
                            raise TimeoutError("fixture timeout")
                        response = io.BytesIO(json.dumps(response_body).encode("utf-8"))
                        if outcome == "http_error":
                            raise server.urllib.error.HTTPError(request.full_url, 503, "fixture failure", None, response)
                        response.status = 200
                        return response

                    urlopen.side_effect = capture_request
                    result = server.handle_decision(decision_body(run["run_id"]))
                    self.assertEqual(len(wire_bodies), 1)
                    self.assertEqual(result["api_ok"], outcome == "success")
                    self.assertEqual(result["valid_choice"], outcome == "success")
                    records = self.read_records(run["run_id"])
                    self.assertEqual(records[-1]["record_type"], "decision_response")
                    self.assertEqual(records[-1]["exactrequestbody"].encode("utf-8"), wire_bodies[0])
                    self.assertEqual(records[-1]["exactrequestbody"], records[-2]["exactrequestbody"])
                    trace = json.dumps(records)
                    self.assertNotIn(api_key, trace)
                    self.assertNotIn("authorization", trace.lower())
                    self.assertNotIn("DJEV_API_KEY", trace)

    @mock.patch.object(server, "_call_djev")
    def test_decision_sends_all_choices_compact_context_and_excludes_checkpoint(self, call):
        run = self.start_run()
        call.return_value = server.UpstreamResult(
            parsed={
                "model": "dgemma",
                "answers": {
                    "intent": {"choice": "position", "confidence": 0.6},
                    "path": {"choice": "down_right__medium", "confidence": 0.7},
                    "fire": {"choice": "shoot", "confidence": 0.8},
                },
                "usage": {"input_tokens": 314, "output_tokens": 16},
            },
            raw_body='{"model":"dgemma"}',
            status=200,
            elapsed_s=0.1895,
            usage={"input_tokens": 314, "output_tokens": 16},
        )
        body = decision_body(run["run_id"])
        call.return_value.raw_body = json.dumps(call.return_value.parsed)
        result = server.handle_decision(body)

        self.assertTrue(result["api_ok"])
        self.assertTrue(result["valid_choice"])
        self.assertEqual(result["intent"], "position")
        self.assertEqual((result["movement"], result["fire"], result["lease"]), ("down_right", "shoot", "medium"))
        self.assertEqual(result["usage"], {"input_tokens": 314, "output_tokens": 16})
        self.assertEqual(result["api_token_throughput"], round(330 / 0.1895, 1))

        payload = call.call_args.args[1]
        call.assert_called_once()
        self.assertEqual(set(payload), {"model", "instructions", "state", "questions", "samples", "steps"})
        self.assertEqual(list(payload["questions"]), ["intent", "path", "fire"])
        for question in payload["questions"].values():
            self.assertEqual(set(question), {"type", "instructions", "criteria"})
        self.assertEqual(payload["questions"]["intent"]["type"], "choice")
        self.assertEqual(list(payload["questions"]["intent"]["criteria"]), ["evade", "recover", "position"])
        path_question = payload["questions"]["path"]
        self.assertEqual(len(path_question["criteria"]), 9)
        self.assertEqual(list(path_question["criteria"])[0], "hold__medium")
        self.assertEqual(list(path_question["criteria"])[1], "left__medium")
        self.assertEqual(list(path_question["criteria"])[-1], "down_right__medium")
        self.assertFalse(any(path_id.endswith("__short") for path_id in path_question["criteria"]))
        self.assertEqual(path_question["criteria"], {
            f"{movement}__medium": (
                "collision=true; collision_ms=125.0; gap_px=28.75; center_progress=1.7; wall_room=194.346."
                if movement == "left" else
                "collision=false; collision_ms=None; gap_px=28.75; center_progress=1.7; wall_room=194.346."
            )
            for movement in ("hold", "left", "right", "up", "down", "up_left", "up_right", "down_left", "down_right")
        })
        self.assertEqual(list(payload["questions"]["fire"]["criteria"]), ["shoot", "cease"])
        self.assertEqual(payload["questions"]["fire"]["criteria"], {"shoot": "Fire weapon.", "cease": "Do not fire."})
        self.assertEqual(payload["samples"], 1)
        self.assertEqual(payload.get("steps"), 1)

        packed = payload["state"]
        self.assertEqual(
            packed,
            {
                "player": {"x": 480.12, "y": 408.34, "w": 20, "h": 18, "lives": 3, "cooldown_ms": 40.25, "invulnerability_ms": 0},
                "inside_center_region": False,
                "hold_collision": False,
                "wait_ms": 260,
                "wait_collision_ms": None,
                "enemy_count": 6,
                "hold_gap_px": 28.75,
            },
        )
        self.assertNotIn("context", packed)
        self.assertNotIn("candidate_columns", packed)
        self.assertNotIn("candidates", packed)
        self.assertNotIn("threat_columns", packed)
        self.assertNotIn("threats", packed)
        self.assertNotIn("history_columns", packed)
        self.assertNotIn("history", packed)
        self.assertNotIn("hits", packed)
        self.assertNotIn("history_counts", packed)
        rendered = json.dumps(payload, sort_keys=True)
        self.assertNotIn("checkpoint", rendered)
        self.assertNotIn("rng_state", rendered)
        self.assertNotIn("seed", rendered)
        self.assertNotIn("old-decision", rendered)
        self.assertNotIn("soft_cost", rendered)
        self.assertEqual(result["confidence"], {"intent": 0.6, "path": 0.7, "movement": 0.7, "fire": 0.8, "lease": 0.7})
        self.assertLessEqual(len(json.dumps(packed, separators=(",", ":"), ensure_ascii=True)), server.MAX_PACKED_STATE_CHARS)

        records = self.read_records(run["run_id"])
        request_record = next(record for record in records if record["record_type"] == "decision_request")
        self.assertEqual(request_record["prompt_version"], "djev-authoritative-v2")
        self.assertEqual(request_record["context_version"], "djev-observation-v2")
        self.assertEqual(request_record["rawsnapshot"], body)
        self.assertEqual(request_record["rawsnapshot"]["forecast"]["candidates"][0]["medium"]["enemy_clearance_px"], 64.25)
        self.assertEqual(request_record["rawsnapshot"]["forecast"]["candidates"][0]["short"]["shot_eta_ms"], 218.75)
        self.assertEqual(request_record["exactactualpayload"], payload)
        response_record = next(record for record in records if record["record_type"] == "decision_response")
        self.assertEqual(response_record["rawsnapshot"], body)
        self.assertEqual(response_record["rawupstreamresponse"]["body"], call.return_value.raw_body)
        self.assertEqual(response_record["normalized"], result)
        self.assertIn("nearest_threats", request_record["rawsnapshot"]["state"])
        self.assertIn("recent_commands", request_record["rawsnapshot"]["state"])
        self.assertIn("recent_hits", request_record["rawsnapshot"]["state"])
        self.assertIn("checkpoint", request_record["rawsnapshot"])

    @mock.patch.object(server, "_call_djev")
    def test_removed_upstream_context_fields_are_not_required_for_packing(self, call):
        run = self.start_run()
        call.return_value = server.UpstreamResult(
            parsed={
                "model": "dgemma",
                "answers": {
                    "intent": {"choice": "position", "confidence": 0.4},
                    "path": {"choice": "hold__medium", "confidence": 0.6},
                    "fire": {"choice": "cease", "confidence": 0.5},
                },
            },
            raw_body='{"model":"dgemma"}',
            status=200,
            elapsed_s=0.1,
            usage={"input_tokens": 1, "output_tokens": 1},
        )
        body = decision_body(run["run_id"])
        del body["state"]["sim_ms"]
        del body["state"]["wave"]
        del body["state"]["difficulty"]
        for field in ("active_command", "last_intent", "recent_commands", "recent_hits", "nearest_threats", "enemy_fire_in_ms"):
            del body["state"][field]
        del body["state"]["threat_counts"]["enemy_bullets"]
        del body["forecast"]["latency_samples"]
        del body["forecast"]["latency_spread_ms"]
        del body["forecast"]["prefix"]["authorized_remaining_ms"]
        del body["forecast"]["horizon_ms"]
        for forecast in body["forecast"]["candidates"]:
            del forecast["medium"]["enemy_clearance_px"]
            del forecast["medium"]["shot_eta_ms"]

        result = server.handle_decision(body)

        self.assertTrue(result["valid_choice"])
        packed = call.call_args.args[1]["state"]
        self.assertEqual(list(packed), ["player", "inside_center_region", "hold_collision", "wait_ms", "wait_collision_ms", "enemy_count", "hold_gap_px"])

    @mock.patch.object(server, "_call_djev")
    def test_invalid_missing_fire_response_is_atomic_and_raw_logged(self, call):
        run = self.start_run()
        call.return_value = server.UpstreamResult(
            parsed={
                "model": "dgemma",
                "answers": {
                    "intent": {"choice": "recover", "confidence": 0.8},
                    "path": {"choice": "left__medium", "confidence": 0.9},
                },
                "usage": {"input_tokens": 50, "output_tokens": 5},
            },
            raw_body='{"model":"dgemma","answers":{"path":{"choice":"left__medium"}}}',
            status=200,
            elapsed_s=0.1,
            usage={"input_tokens": 50, "output_tokens": 5},
        )
        result = server.handle_decision(decision_body(run["run_id"]))

        self.assertTrue(result["api_ok"])
        self.assertFalse(result["valid_choice"])
        self.assertIsNone(result["intent"])
        self.assertIsNone(result["movement"])
        self.assertIsNone(result["fire"])
        self.assertIsNone(result["lease"])
        self.assertEqual(result["confidence"], {"intent": None, "path": None, "movement": None, "fire": None, "lease": None})

        records = self.read_records(run["run_id"])
        response_records = [record for record in records if record["record_type"] == "decision_response"]
        self.assertEqual(len(response_records), 1)
        response_record = response_records[0]
        self.assertEqual(response_record["rawupstreamresponse"]["status"], 200)
        self.assertEqual(response_record["rawupstreamresponse"]["parsed"]["model"], "dgemma")
        self.assertEqual(response_record["model_identity"]["response_model"], "dgemma")
        self.assertIsNone(response_record["normalized"]["movement"])
        self.assertIn("missing_fire", response_record["normalized"]["error"])

    @mock.patch.object(server, "_call_djev")
    def test_short_path_response_is_invalid_under_live_medium_only_contract(self, call):
        run = self.start_run()
        call.return_value = server.UpstreamResult(
            parsed={
                "model": "dgemma",
                "answers": {
                    "intent": {"choice": "evade", "confidence": 0.8},
                    "path": {"choice": "left__short", "confidence": 0.9},
                    "fire": {"choice": "shoot", "confidence": 0.8},
                },
                "usage": {"input_tokens": 50, "output_tokens": 5},
            },
            raw_body='{"model":"dgemma","answers":{"path":{"choice":"left__short"},"fire":{"choice":"shoot"}}}',
            status=200,
            elapsed_s=0.1,
            usage={"input_tokens": 50, "output_tokens": 5},
        )
        result = server.handle_decision(decision_body(run["run_id"]))

        self.assertTrue(result["api_ok"])
        self.assertFalse(result["valid_choice"])
        self.assertIsNone(result["intent"])
        self.assertIsNone(result["movement"])
        self.assertIsNone(result["fire"])
        self.assertIsNone(result["lease"])
        self.assertIn("unknown_path_choice", result["error"])

    @mock.patch.object(server, "_call_djev")
    def test_validation_requires_medium_forecasts_but_short_is_optional_before_upstream(self, call):
        run = self.start_run()
        body = decision_body(run["run_id"])
        del body["forecast"]["candidates"][0]["medium"]

        with self.assertRaises(server.RequestValidationError):
            server.handle_decision(body)
        call.assert_not_called()

        call.return_value = server.UpstreamResult(
            parsed={
                "model": "dgemma",
                "answers": {
                    "intent": {"choice": "position", "confidence": 0.4},
                    "path": {"choice": "hold__medium", "confidence": 0.6},
                    "fire": {"choice": "cease", "confidence": 0.5},
                },
            },
            raw_body='{"model":"dgemma"}',
            status=200,
            elapsed_s=0.1,
            usage={"input_tokens": 1, "output_tokens": 1},
        )
        body = decision_body(run["run_id"])
        for forecast in body["forecast"]["candidates"]:
            del forecast["short"]
        result = server.handle_decision(body)
        self.assertEqual((result["movement"], result["fire"], result["lease"]), ("hold", "cease", "medium"))
        payload = call.call_args.args[1]
        self.assertEqual(len(payload["questions"]["path"]["criteria"]), 9)
        self.assertFalse(any(path_id.endswith("__short") for path_id in payload["questions"]["path"]["criteria"]))

    @mock.patch.object(server, "_call_djev")
    def test_validation_requires_forecast_windows_before_upstream(self, call):
        run = self.start_run()
        body = decision_body(run["run_id"])
        body["forecast"]["assumptions"]["contact_window"] = "whole_horizon"
        with self.assertRaises(server.RequestValidationError):
            server.handle_decision(body)

        body = decision_body(run["run_id"])
        body["forecast"]["assumptions"]["enemy_clearance_window"] = "prefix"
        with self.assertRaises(server.RequestValidationError):
            server.handle_decision(body)

        call.assert_not_called()

    def test_event_batches_are_durable_idempotent_and_reject_gaps_conflicts(self):
        run = self.start_run()
        event_one = {"event_id": 1, "epoch": 3, "sequence": 4, "tick": 121, "sim_ms": 2016.7, "wall_ms": 2017, "type": "command_applied", "payload": {"decision_id": "d1"}}
        event_two = {"event_id": 2, "epoch": 3, "sequence": None, "tick": 122, "sim_ms": 2033.3, "wall_ms": 2035, "type": "hit", "payload": {"lives_after": 2}}
        ack = server.record_run_events({"schema_version": 1, "run_id": run["run_id"], "events": [event_one, event_two]})
        self.assertEqual(ack["acked_event_id"], 2)

        records_after_first = self.read_records(run["run_id"])
        repeat_ack = server.record_run_events({"schema_version": 1, "run_id": run["run_id"], "events": [event_one, event_two]})
        self.assertEqual(repeat_ack["acked_event_id"], 2)
        self.assertEqual(records_after_first, self.read_records(run["run_id"]))

        with self.assertRaises(server.ConflictError):
            server.record_run_events({"schema_version": 1, "run_id": run["run_id"], "events": [{**event_two, "payload": {"lives_after": 1}}]})
        with self.assertRaises(server.ConflictError):
            server.record_run_events({"schema_version": 1, "run_id": run["run_id"], "events": [{**event_two, "event_id": 4}]})

        ack = server.record_run_events({"schema_version": 1, "run_id": run["run_id"], "events": [{**event_two, "event_id": 3}]})
        self.assertEqual(ack["acked_event_id"], 3)

    @mock.patch.object(server, "_call_djev")
    def test_per_run_upstream_lock_rejects_concurrent_decision_without_call(self, call):
        run = self.start_run()
        run_state = server.get_run_state(run["run_id"])
        self.assertTrue(run_state.upstream_lock.acquire(blocking=False))
        self.addCleanup(run_state.upstream_lock.release)

        with self.assertRaises(server.ConflictError):
            server.handle_decision(decision_body(run["run_id"]))
        call.assert_not_called()

    def test_run_end_requires_acked_events_and_marks_complete_summary(self):
        run = self.start_run()
        event = {"event_id": 1, "epoch": 3, "sequence": 4, "tick": 121, "sim_ms": 2016.7, "wall_ms": 2017, "type": "checkpoint", "payload": {"hash": "abc"}}
        server.record_run_events({"schema_version": 1, "run_id": run["run_id"], "events": [event]})
        with self.assertRaises(server.ConflictError):
            server.end_run({"schema_version": 1, "run_id": run["run_id"], "last_event_id": 2, "terminal": terminal_body()})

        result = server.end_run({"schema_version": 1, "run_id": run["run_id"], "last_event_id": 1, "terminal": terminal_body()})
        self.assertTrue(result["complete"])
        self.assertEqual(result["summary"]["status"], "complete")
        self.assertEqual(result["summary"]["terminal_reason"], "target")
        records = self.read_records(run["run_id"])
        self.assertEqual(records[-1]["record_type"], "run_ended")
        self.assertEqual(records[-1]["terminal"]["reason"], "target")

    @mock.patch.object(server, "_call_djev")
    def test_run_end_waits_for_inflight_decision_and_preserves_raw_response(self, call):
        run = self.start_run()
        event = {"event_id": 1, "epoch": 3, "sequence": 4, "tick": 121, "sim_ms": 2016.7, "wall_ms": 2017, "type": "checkpoint", "payload": {"hash": "abc"}}
        server.record_run_events({"schema_version": 1, "run_id": run["run_id"], "events": [event]})
        upstream_started = threading.Event()
        release_upstream = threading.Event()
        decision_result = {}
        end_result = {}
        thread_errors = []

        def slow_upstream(_run, _payload):
            upstream_started.set()
            if not release_upstream.wait(timeout=1):
                raise AssertionError("test upstream was not released")
            return server.UpstreamResult(
                parsed={
                    "model": "dgemma",
                    "answers": {
                        "intent": {"choice": "evade", "confidence": 0.9},
                        "path": {"choice": "up__medium", "confidence": 0.7},
                        "fire": {"choice": "shoot", "confidence": 0.8},
                    },
                    "usage": {"input_tokens": 1956, "output_tokens": 16},
                },
                raw_body='{"model":"dgemma","answers":{"path":{"choice":"up__medium"},"fire":{"choice":"shoot"}}}',
                status=200,
                elapsed_s=0.4895,
                usage={"input_tokens": 1956, "output_tokens": 16},
            )

        def run_decision():
            try:
                decision_result["value"] = server.handle_decision(decision_body(run["run_id"]))
            except Exception as exc:  # pragma: no cover - failure transport for thread
                thread_errors.append(exc)

        def run_end():
            try:
                end_result["value"] = server.end_run({"schema_version": 1, "run_id": run["run_id"], "last_event_id": 1, "terminal": terminal_body()})
            except Exception as exc:  # pragma: no cover - failure transport for thread
                thread_errors.append(exc)

        call.side_effect = slow_upstream
        decision_thread = threading.Thread(target=run_decision)
        end_thread = threading.Thread(target=run_end)
        decision_thread.start()
        self.assertTrue(upstream_started.wait(timeout=1))
        end_thread.start()
        time.sleep(0.05)
        self.assertTrue(end_thread.is_alive(), "end_run returned before the in-flight upstream call finished")

        release_upstream.set()
        decision_thread.join(timeout=1)
        end_thread.join(timeout=1)

        self.assertFalse(decision_thread.is_alive())
        self.assertFalse(end_thread.is_alive())
        self.assertEqual(thread_errors, [])
        self.assertEqual(decision_result["value"]["movement"], "up")
        self.assertEqual(decision_result["value"]["intent"], "evade")
        self.assertTrue(end_result["value"]["complete"])

        records = self.read_records(run["run_id"])
        response_index = next(index for index, record in enumerate(records) if record["record_type"] == "decision_response")
        end_index = next(index for index, record in enumerate(records) if record["record_type"] == "run_ended")
        self.assertLess(response_index, end_index)
        response_record = records[response_index]
        self.assertEqual(response_record["rawupstreamresponse"]["status"], 200)
        self.assertEqual(response_record["rawupstreamresponse"]["parsed"]["model"], "dgemma")

    @mock.patch.object(server, "_call_djev")
    def test_decision_rechecks_complete_after_acquiring_upstream_lock(self, call):
        run = self.start_run()
        run_state = server.get_run_state(run["run_id"])

        class CompleteOnAcquire:
            def acquire(self, blocking=True, timeout=-1):
                run_state.complete = True
                return True

            def release(self):
                return None

        run_state.upstream_lock = CompleteOnAcquire()
        call.return_value = server.UpstreamResult(
            parsed={
                "model": "dgemma",
                "answers": {
                    "intent": {"choice": "recover", "confidence": 0.9},
                    "path": {"choice": "up__medium", "confidence": 0.7},
                    "fire": {"choice": "shoot", "confidence": 0.8},
                },
            },
            raw_body='{"model":"dgemma"}',
            status=200,
            elapsed_s=0.1,
            usage={"input_tokens": 1, "output_tokens": 1},
        )

        with self.assertRaises(server.ConflictError) as raised:
            server.handle_decision(decision_body(run["run_id"]))
        self.assertEqual(raised.exception.code, "run_complete")
        call.assert_not_called()


def terminal_body():
    return {
        "reason": "target",
        "tick": 7260,
        "sim_ms": 121000,
        "wall_ms": 121300,
        "lives": 1,
        "wave": 9,
        "score": 12345,
        "qualification_violations": [],
    }


if __name__ == "__main__":
    unittest.main()
