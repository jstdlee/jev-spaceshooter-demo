"""Standard-library server and bounded Jev movement-choice bridge."""

from __future__ import annotations

import argparse
import json
import math
import os
import socket
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEMO_DIR = Path(__file__).resolve().parent
HTML_PATH = DEMO_DIR / "space-shooter.html"
ACTION_MS = 240
HORIZON_MS = 600
ACTION_IDS = (
    "hold", "left", "right", "up", "down",
    "up_left", "up_right", "down_left", "down_right",
)
ACTION_DESCRIPTIONS = {
    "hold": "Stop for the bounded interval",
    "left": "Move left for the bounded interval",
    "right": "Move right for the bounded interval",
    "up": "Move up for the bounded interval",
    "down": "Move down for the bounded interval",
    "up_left": "Move diagonally up and left for the bounded interval",
    "up_right": "Move diagonally up and right for the bounded interval",
    "down_left": "Move diagonally down and left for the bounded interval",
    "down_right": "Move diagonally down and right for the bounded interval",
}


class RequestValidationError(ValueError):
    """Raised before any upstream call when browser state is malformed."""


def _load_env_file() -> None:
    """Load the repository-root .env without overriding process variables."""
    env_path = DEMO_DIR.parent / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def _nonnegative_int(value: Any, name: str) -> int:
    if type(value) is not int or value < 0:
        raise RequestValidationError(f"{name} must be a nonnegative integer")
    return value


def _finite_number(value: Any, name: str, *, nullable: bool = False) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RequestValidationError(f"{name} must be finite" + (" or null" if nullable else ""))
    return float(value)


def build_decision_request(state: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise RequestValidationError("request state must be an object")
    epoch = _nonnegative_int(state.get("epoch"), "epoch")
    sequence = _nonnegative_int(state.get("sequence"), "sequence")
    player = state.get("player")
    if not isinstance(player, dict):
        raise RequestValidationError("player must be an object")
    player_out = {
        "x": round(_finite_number(player.get("x"), "player.x"), 3),
        "y": round(_finite_number(player.get("y"), "player.y"), 3),
    }
    previous_action = state.get("previous_action")
    if previous_action not in ACTION_IDS:
        raise RequestValidationError("previous_action is unknown")
    candidates = state.get("candidates")
    if not isinstance(candidates, list):
        raise RequestValidationError("candidates must be a list")
    if not 2 <= len(candidates) <= len(ACTION_IDS):
        raise RequestValidationError("candidates must contain 2 to 9 actions")

    seen: set[str] = set()
    candidates_out: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise RequestValidationError(f"candidate {index} must be an object")
        action_id = candidate.get("id")
        if action_id not in ACTION_IDS:
            raise RequestValidationError(f"candidate {index} has an unknown id")
        if action_id in seen:
            raise RequestValidationError(f"candidate id {action_id} is duplicated")
        seen.add(action_id)
        clearance = _finite_number(candidate.get("clearance_px"), f"candidate {action_id}.clearance_px", nullable=True)
        center_cost = _finite_number(candidate.get("center_cost"), f"candidate {action_id}.center_cost")
        room_px = _finite_number(candidate.get("room_px"), f"candidate {action_id}.room_px")
        switch_cost = _finite_number(candidate.get("switch_cost"), f"candidate {action_id}.switch_cost")
        soft_cost = _finite_number(candidate.get("soft_cost"), f"candidate {action_id}.soft_cost")
        if center_cost < 0 or room_px < 0 or switch_cost < 0 or soft_cost < 0 or (clearance is not None and clearance < 0):
            raise RequestValidationError(f"candidate {action_id} contains a negative feature")
        candidates_out.append({
            "id": action_id,
            "clearance_px": None if clearance is None else round(clearance, 3),
            "center_cost": round(center_cost, 4),
            "room_px": round(room_px, 3),
            "switch_cost": round(switch_cost, 4),
            "soft_cost": round(soft_cost, 4),
        })

    instructions = (
        "Choose one supplied movement action. Local swept collision checks already determine eligibility. "
        "Prefer center room and continuity among eligible actions; do not invent trajectories, change "
        "difficulty, or extend the action duration."
    )
    question_instructions = (
        "Select exactly one eligible action ID from the candidate table. Prefer low soft_cost, which "
        "expresses center room and continuity. The browser may override a choice if current conditions have changed."
    )
    return {
        "model": "jev-latest",
        "instructions": instructions,
        "state": {
            "epoch": epoch,
            "sequence": sequence,
            "action_ms": ACTION_MS,
            "horizon_ms": HORIZON_MS,
            "player": player_out,
            "previous_action": previous_action,
            "candidates": candidates_out,
        },
        "questions": {
            "movement": {
                "type": "choice",
                "instructions": question_instructions,
                "criteria": {candidate["id"]: ACTION_DESCRIPTIONS[candidate["id"]] for candidate in candidates_out},
            }
        },
        "samples": 1,
    }


def normalize_decision(response: Any, state: dict[str, Any]) -> dict[str, Any]:
    result = {
        "epoch": state.get("epoch"),
        "sequence": state.get("sequence"),
        "movement": None,
        "valid_choice": False,
        "confidence": None,
        "error": None,
    }
    if not isinstance(response, dict):
        result["error"] = "invalid_root"
        return result
    answers = response.get("answers")
    if not isinstance(answers, dict):
        result["error"] = "invalid_answers"
        return result
    answer = answers.get("movement")
    if not isinstance(answer, dict):
        result["error"] = "invalid_answer"
        return result
    choice = answer.get("choice")
    if choice is None:
        result["error"] = "missing_choice"
        return result
    if not isinstance(choice, str):
        result["error"] = "invalid_choice_type"
        return result
    choice = choice.strip().lower()
    if choice not in ACTION_IDS:
        result["error"] = "unknown_choice"
        return result
    offered = {candidate.get("id") for candidate in state.get("candidates", []) if isinstance(candidate, dict)}
    if choice not in offered:
        result["error"] = "unoffered_choice"
        return result
    confidence = answer.get("confidence")
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and math.isfinite(confidence):
        result["confidence"] = round(max(0.0, min(1.0, float(confidence))), 3)
    result.update({"movement": choice, "valid_choice": True, "error": None})
    return result


def _usage_count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return int(value)


def _call_djev(payload: dict[str, Any]) -> tuple[Any, float, dict[str, int | None]]:
    _load_env_file()
    base_url = os.environ.get("DJEV_URL", "http://127.0.0.1:8011").rstrip("/")
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("DJEV_API_KEY", os.environ.get("API_KEY", ""))
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        base_url + "/v1/systemone",
        data=json.dumps(payload, allow_nan=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=2.0) as response:
        response_payload = json.loads(response.read().decode("utf-8"))
    elapsed_s = max(0.0, time.perf_counter() - started)
    usage_obj = response_payload.get("usage") if isinstance(response_payload, dict) else None
    usage_obj = usage_obj if isinstance(usage_obj, dict) else {}
    usage = {
        "input_tokens": _usage_count(usage_obj.get("input_tokens")),
        "output_tokens": _usage_count(usage_obj.get("output_tokens")),
    }
    return response_payload, elapsed_s, usage


def decide(state: dict[str, Any]) -> dict[str, Any]:
    request = build_decision_request(state)
    started = time.perf_counter()
    try:
        response, elapsed_s, usage = _call_djev(request)
        result = normalize_decision(response, request["state"])
        total_tokens = None
        if usage["input_tokens"] is not None and usage["output_tokens"] is not None:
            total_tokens = usage["input_tokens"] + usage["output_tokens"]
        throughput = round(total_tokens / elapsed_s, 1) if total_tokens is not None and elapsed_s > 0 else None
        result.update({
            "api_ok": True,
            "latency_ms": round(elapsed_s * 1000, 1),
            "api_token_throughput": throughput,
            "usage": usage,
        })
        return result
    except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, ValueError) as exc:
        elapsed_s = max(0.0, time.perf_counter() - started)
        return {
            "epoch": request["state"]["epoch"],
            "sequence": request["state"]["sequence"],
            "movement": None,
            "valid_choice": False,
            "confidence": None,
            "api_ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "latency_ms": round(elapsed_s * 1000, 1),
            "api_token_throughput": None,
            "usage": {"input_tokens": None, "output_tokens": None},
        }


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path in {"/", "/space-shooter.html"}:
            self._send(200, HTML_PATH.read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/health":
            self._send(200, b'{"ok":true}', "application/json")
        else:
            self._send(404, b'{"error":"not found"}', "application/json")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/api/decision":
            self._send(404, b'{"error":"not found"}', "application/json")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            state = json.loads(self.rfile.read(length).decode("utf-8"))
            result = decide(state)
            self._send(200, json.dumps(result, allow_nan=False).encode("utf-8"), "application/json")
        except (RequestValidationError, json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            self._send(400, json.dumps({"error": str(exc)}).encode("utf-8"), "application/json")

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the bounded Jev movement decision demo")
    parser.add_argument("--host", default=os.environ.get("SHOOTER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SHOOTER_PORT", "7862")))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Space shooter: http://{args.host}:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
