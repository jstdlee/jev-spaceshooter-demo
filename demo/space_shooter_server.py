"""Standard-library djev-authoritative bridge for the space shooter demo."""

from __future__ import annotations

import argparse
import dataclasses
import datetime as _dt
import hashlib
import json
import math
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEMO_DIR = Path(__file__).resolve().parent
HTML_PATH = DEMO_DIR / "space-shooter.html"
STATIC_ASSETS = {
    "/space-shooter-renderer.js": (DEMO_DIR / "space-shooter-renderer.js", "text/javascript; charset=utf-8"),
    "/assets/space-shooter-sprites.png": (DEMO_DIR / "assets" / "space-shooter-sprites.png", "image/png"),
}
STRATEGY_PATH = DEMO_DIR / "strategy.md"
RUNS_DIR = DEMO_DIR / "runs"

SCHEMA_VERSION = 1
PROMPT_VERSION = "djev-authoritative-v2"
CONTEXT_VERSION = "djev-observation-v2"
DJEV_MODEL_DEFAULT = "auto"
DJEV_URL_DEFAULT = "http://127.0.0.1:8011"
MAX_PACKED_STATE_CHARS = 6000
MAX_MODEL_LEN = 4096
RESERVED_OUTPUT_TOKENS = 512
UPSTREAM_TIMEOUT_S = 2.0
END_RUN_UPSTREAM_WAIT_S = 2.5
DT_MS = 1000 / 60
ARENA_CENTER_X = 480.0
ARENA_CENTER_Y = 310.0

ACTION_IDS = (
    "hold", "left", "right", "up", "down",
    "up_left", "up_right", "down_left", "down_right",
)
FIRE_IDS = ("shoot", "cease")
INTENT_IDS = ("evade", "recover", "position")
LEASE_IDS = ("short", "medium")
LIVE_PATH_LEASE = "medium"
LEASE_TICKS = {"short": 15, "medium": 30}
LEASE_MS = {"short": 250.0, "medium": 500.0}
PATH_IDS = tuple(f"{movement}__{LIVE_PATH_LEASE}" for movement in ACTION_IDS)
DIFFICULTY_KEYS = ("bulletDensity", "enemyDensity", "fastBulletRatio", "fastBulletSpeed")

ACTION_DESCRIPTIONS = {
    "hold": "Hold current position; arena walls may still physically clamp the body.",
    "left": "Move left at the normal 112 px/s movement speed.",
    "right": "Move right at the normal 112 px/s movement speed.",
    "up": "Move up at the normal 112 px/s movement speed.",
    "down": "Move down at the normal 112 px/s movement speed.",
    "up_left": "Move diagonally up-left at normalized 112 px/s speed.",
    "up_right": "Move diagonally up-right at normalized 112 px/s speed.",
    "down_left": "Move diagonally down-left at normalized 112 px/s speed.",
    "down_right": "Move diagonally down-right at normalized 112 px/s speed.",
}
FIRE_DESCRIPTIONS = {
    "shoot": "Fire weapon.",
    "cease": "Do not fire.",
}
INTENT_DESCRIPTIONS = {
    "evade": "hold_collision=true.",
    "recover": "hold_collision=false and inside_center_region=false.",
    "position": "hold_collision=false and inside_center_region=true.",
}
LEASE_DESCRIPTIONS = {
    "short": "Authorize the chosen movement/fire for 15 ticks, about 250 ms at 60 Hz.",
    "medium": "Authorize the chosen movement/fire for 30 ticks, about 500 ms at 60 Hz.",
}


class ApiError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class RequestValidationError(ApiError, ValueError):
    """Raised before an endpoint action when client input is malformed."""


class ConflictError(ApiError):
    status = 409
    code = "conflict"


class NotFoundError(ApiError):
    status = 404
    code = "not_found"


class ContextBudgetExceeded(ApiError):
    code = "context_budget_exceeded"


@dataclasses.dataclass(slots=True)
class UpstreamResult:
    parsed: Any
    raw_body: str | None
    status: int | None
    elapsed_s: float
    usage: dict[str, int | None]
    error: str | None = None


@dataclasses.dataclass(slots=True)
class RunState:
    run_id: str
    run_path: Path
    events_path: Path
    manifest: dict[str, Any]
    prompt_version: str
    prompt_text: str
    prompt_hash: str
    context_version: str
    engine_source_hash: str
    provider_url: str
    configured_model: str
    model_identity: dict[str, Any]
    upstream_lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    event_lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    trace_lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    append_index: int = 0
    last_event_id: int | None = None
    event_hashes: dict[int, str] = dataclasses.field(default_factory=dict)
    complete: bool = False
    decision_count: int = 0
    invalid_decision_count: int = 0
    event_count: int = 0
    terminal: dict[str, Any] | None = None


_RUNS: dict[str, RunState] = {}
_RUNS_LOCK = threading.Lock()


def reset_runtime_for_tests() -> None:
    with _RUNS_LOCK:
        _RUNS.clear()


def get_run_state(run_id: str) -> RunState:
    if not isinstance(run_id, str) or not run_id:
        raise RequestValidationError("run_id must be a nonempty string")
    with _RUNS_LOCK:
        run = _RUNS.get(run_id)
    if run is None:
        raise NotFoundError(f"unknown run_id {run_id!r}")
    return run


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


def _utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def _compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _require_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RequestValidationError(f"{name} must be an object")
    return value


def _require_list(value: Any, name: str) -> list[Any]:
    if not isinstance(value, list):
        raise RequestValidationError(f"{name} must be a list")
    return value


def _require_schema(body: Any) -> dict[str, Any]:
    body = _require_object(body, "request")
    if body.get("schema_version") != SCHEMA_VERSION:
        raise RequestValidationError("schema_version must be 1")
    return body


def _nonnegative_int(value: Any, name: str) -> int:
    if type(value) is not int or value < 0:
        raise RequestValidationError(f"{name} must be a nonnegative integer")
    return value


def _integer_or_none(value: Any, name: str) -> int | None:
    if value is None:
        return None
    return _nonnegative_int(value, name)


def _finite_number(value: Any, name: str, *, nullable: bool = False, minimum: float | None = None) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RequestValidationError(f"{name} must be finite" + (" or null" if nullable else ""))
    number = float(value)
    if minimum is not None and number < minimum:
        raise RequestValidationError(f"{name} must be >= {minimum:g}")
    return number


def _round1(value: Any, name: str, *, nullable: bool = False, minimum: float | None = None) -> float | None:
    number = _finite_number(value, name, nullable=nullable, minimum=minimum)
    return None if number is None else round(number, 1)


def _round3(value: Any, name: str, *, nullable: bool = False, minimum: float | None = None) -> float | None:
    number = _finite_number(value, name, nullable=nullable, minimum=minimum)
    return None if number is None else round(number, 3)


def _enum(value: Any, name: str, allowed: tuple[str, ...], *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or value not in allowed:
        raise RequestValidationError(f"{name} must be one of {', '.join(allowed)}")
    return value


def validate_provider_config(value: Any) -> dict[str, str]:
    _load_env_file()
    value = _require_object(value, "provider")
    unknown = set(value) - {"url", "model"}
    if unknown:
        raise RequestValidationError(f"provider contains unknown fields: {', '.join(sorted(unknown))}")
    raw_url = value.get("url", os.environ.get("DJEV_URL", DJEV_URL_DEFAULT))
    model = value.get("model", os.environ.get("DJEV_MODEL", DJEV_MODEL_DEFAULT))
    if not isinstance(raw_url, str) or not raw_url or raw_url != raw_url.strip():
        raise RequestValidationError("provider.url must be a trimmed absolute HTTP(S) base URL")
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        hostname = parsed.hostname
        parsed.port
    except ValueError as exc:
        raise RequestValidationError("provider.url is malformed or has an invalid port") from exc
    path = parsed.path.rstrip("/")
    if (parsed.scheme not in {"http", "https"} or not hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or path.endswith("/v1/systemone")):
        raise RequestValidationError(
            "provider.url must be an HTTP(S) base URL without credentials, query, fragment, or a duplicated /v1/systemone path"
        )
    if not isinstance(model, str):
        raise RequestValidationError("provider.model must be a string")
    model = model.strip()
    if not model or len(model) > MAX_MODEL_LEN:
        raise RequestValidationError(f"provider.model must contain 1 to {MAX_MODEL_LEN} characters")
    return {"url": urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", "")), "model": model}


def effective_provider_config() -> dict[str, str]:
    return validate_provider_config({})


def _usage_count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return int(value)


def _usage_from_payload(payload: Any) -> dict[str, int | None]:
    usage_obj = payload.get("usage") if isinstance(payload, dict) else None
    usage_obj = usage_obj if isinstance(usage_obj, dict) else {}
    return {
        "input_tokens": _usage_count(usage_obj.get("input_tokens")),
        "output_tokens": _usage_count(usage_obj.get("output_tokens")),
    }


def _extract_script(html: str, script_id: str) -> str:
    pattern = re.compile(
        r"<script\b(?=[^>]*\bid=[\"']" + re.escape(script_id) + r"[\"'])[^>]*>([\s\S]*?)</script>",
        re.IGNORECASE,
    )
    match = pattern.search(html)
    if not match:
        raise RequestValidationError(f"missing inline script {script_id!r}")
    return match.group(1)


def compute_engine_source_hash() -> str:
    html = HTML_PATH.read_text(encoding="utf-8")
    core = _extract_script(html, "space-decision-core")
    controller = _extract_script(html, "space-djev-controller")
    return _sha256_text(f"{core}\n{controller}")


def load_strategy(prompt_version: str) -> tuple[str, str]:
    if prompt_version != PROMPT_VERSION:
        raise RequestValidationError(f"unknown prompt_version {prompt_version!r}")
    text = STRATEGY_PATH.read_text(encoding="utf-8")
    first_line, sep, body = text.partition("\n")
    if sep == "" or first_line.strip() != f"version: {prompt_version}":
        raise RequestValidationError("strategy.md first line must pin the requested prompt version")
    if not body.strip():
        raise RequestValidationError("strategy prompt body must not be empty")
    if len(body.split()) > 180:
        raise RequestValidationError("strategy prompt body must be at most 180 words")
    return body, _sha256_text(body)


def _append_record(run: RunState, record: dict[str, Any], *, fsync: bool = False) -> None:
    with run.trace_lock:
        run.append_index += 1
        full_record = {
            "schema_version": SCHEMA_VERSION,
            "append_index": run.append_index,
            "recorded_at_utc": _utc_now(),
            **record,
        }
        run.run_path.mkdir(parents=True, exist_ok=True)
        with run.events_path.open("a", encoding="utf-8") as handle:
            handle.write(_canonical_json(full_record))
            handle.write("\n")
            handle.flush()
            if fsync:
                os.fsync(handle.fileno())


def _make_run_id() -> str:
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"run-{stamp}-{secrets.token_urlsafe(8).replace('_', '-').rstrip('-')}"


def _validate_manifest(manifest: Any) -> dict[str, Any]:
    manifest = _require_object(manifest, "manifest")
    if manifest.get("prompt_version") != PROMPT_VERSION:
        raise RequestValidationError("manifest.prompt_version is unknown")
    if manifest.get("context_version") != CONTEXT_VERSION:
        raise RequestValidationError("manifest.context_version is unknown")
    if manifest.get("mode") not in {"browser", "cli"}:
        raise RequestValidationError("manifest.mode must be browser or cli")
    _finite_number(manifest.get("dt_ms"), "manifest.dt_ms", minimum=0)
    if abs(float(manifest["dt_ms"]) - DT_MS) > 0.001:
        raise RequestValidationError("manifest.dt_ms must be 1000/60")
    if not isinstance(manifest.get("engine_hash"), str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["engine_hash"]):
        raise RequestValidationError("manifest.engine_hash must be a lowercase SHA-256 hex digest")
    if "rules" not in manifest or not isinstance(manifest["rules"], dict):
        raise RequestValidationError("manifest.rules must be an object")
    return manifest


def start_run(body: dict[str, Any]) -> dict[str, Any]:
    body = _require_schema(body)
    manifest = _validate_manifest(body.get("manifest"))
    provider = validate_provider_config(body.get("provider", {}))
    prompt_text, prompt_hash = load_strategy(manifest["prompt_version"])
    actual_engine_hash = compute_engine_source_hash()
    if manifest["engine_hash"] != actual_engine_hash:
        raise RequestValidationError("manifest.engine_hash does not match current inline engine/controller source")

    run_id = _make_run_id()
    run_path = RUNS_DIR / run_id
    while run_path.exists():
        run_id = _make_run_id()
        run_path = RUNS_DIR / run_id
    run_path.mkdir(parents=True, exist_ok=False)
    events_path = run_path / "events.jsonl"
    run_manifest = {**manifest, "provider": provider}
    model_identity = {
        "configured_model": provider["model"],
        "endpoint": provider["url"],
        "response_model": None,
    }
    run = RunState(
        run_id=run_id,
        run_path=run_path,
        events_path=events_path,
        manifest=json.loads(_canonical_json(run_manifest)),
        prompt_version=manifest["prompt_version"],
        prompt_text=prompt_text,
        prompt_hash=prompt_hash,
        context_version=manifest["context_version"],
        engine_source_hash=actual_engine_hash,
        provider_url=provider["url"],
        configured_model=provider["model"],
        model_identity=model_identity,
    )
    _append_record(
        run,
        {
            "record_type": "run_started",
            "run_id": run_id,
            "status": "incomplete",
            "manifest": run.manifest,
            "engine_source_hash": actual_engine_hash,
            "prompt_version": run.prompt_version,
            "prompt_hash": prompt_hash,
            "prompt_text": prompt_text,
            "context_version": run.context_version,
            "model_identity": model_identity,
            "prng": {
                "algorithm": run.manifest.get("rules", {}).get("prng_algorithm"),
                "seed": run.manifest.get("seed"),
                "initial_rng_state": run.manifest.get("initial_rng_state"),
            },
            "server_time_utc": _utc_now(),
        },
        fsync=True,
    )
    with _RUNS_LOCK:
        _RUNS[run_id] = run
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "prompt_version": run.prompt_version,
        "prompt_hash": prompt_hash,
        "trace_path": str(events_path.resolve()),
    }


def _validate_decision_request(body: Any) -> dict[str, Any]:
    body = _require_schema(body)
    if not isinstance(body.get("run_id"), str) or not body["run_id"]:
        raise RequestValidationError("run_id must be a nonempty string")
    _nonnegative_int(body.get("epoch"), "epoch")
    _nonnegative_int(body.get("sequence"), "sequence")
    _nonnegative_int(body.get("snapshot_tick"), "snapshot_tick")
    _finite_number(body.get("client_send_wall_ms"), "client_send_wall_ms", minimum=0)
    _require_object(body.get("state"), "state")
    _require_object(body.get("forecast"), "forecast")
    if "checkpoint" not in body:
        raise RequestValidationError("checkpoint is required for trace logging")
    return body


def _active_command(value: Any, snapshot_tick: int) -> dict[str, Any] | None:
    if value is None:
        return None
    command = _require_object(value, "active_command")
    movement = _enum(command.get("movement"), "active_command.movement", ACTION_IDS)
    intent = _enum(command.get("intent"), "active_command.intent", INTENT_IDS, nullable=True)
    if "remaining_ms" in command:
        remaining_ms = _round1(command.get("remaining_ms"), "active_command.remaining_ms", minimum=0)
    elif "end_tick" in command:
        end_tick = _nonnegative_int(command.get("end_tick"), "active_command.end_tick")
        remaining_ms = round(max(0, end_tick - snapshot_tick) * DT_MS, 1)
    else:
        raise RequestValidationError("active_command.remaining_ms or end_tick is required")
    return {"movement": movement, "remaining_ms": remaining_ms, "intent": intent}


def _observed_number(
    value: dict[str, Any], key: str, name: str, *, nullable: bool = False, minimum: float | None = None,
) -> int | float | None:
    """Validate a required observation without changing its numeric precision."""
    if key not in value:
        raise RequestValidationError(f"{name}.{key} is required")
    _finite_number(value[key], f"{name}.{key}", nullable=nullable, minimum=minimum)
    return value[key]


def _packed_player(value: Any) -> dict[str, Any]:
    player = _require_object(value, "player")
    return {
        "x": _observed_number(player, "x", "player"),
        "y": _observed_number(player, "y", "player"),
        "w": _observed_number(player, "w", "player", minimum=0),
        "h": _observed_number(player, "h", "player", minimum=0),
        "lives": _nonnegative_int(player.get("lives"), "player.lives"),
        "cooldown_ms": _observed_number(player, "cooldown_ms", "player", minimum=0),
        "invulnerability_ms": _observed_number(player, "invulnerability_ms", "player", minimum=0),
    }


def _packed_difficulty(value: Any) -> dict[str, Any]:
    difficulty = _require_object(value, "difficulty")
    return {
        "bulletDensity": _round1(difficulty.get("bulletDensity"), "difficulty.bulletDensity", minimum=0),
        "enemyDensity": _round1(difficulty.get("enemyDensity"), "difficulty.enemyDensity", minimum=0),
        "fastBulletRatio": _round3(difficulty.get("fastBulletRatio"), "difficulty.fastBulletRatio", minimum=0),
        "fastBulletSpeed": _round1(difficulty.get("fastBulletSpeed"), "difficulty.fastBulletSpeed", minimum=0),
    }


def _packed_counts(value: Any) -> dict[str, Any]:
    counts = _require_object(value, "threat_counts")
    bullet_key = "bullets" if "bullets" in counts else "enemy_bullets"
    return {
        "bullets": _nonnegative_int(counts.get(bullet_key), f"threat_counts.{bullet_key}"),
        "enemies": _nonnegative_int(counts.get("enemies"), "threat_counts.enemies"),
    }


def _edge_room(value: Any, name: str) -> int | float:
    if isinstance(value, dict):
        distances = [_observed_number(value, key, name, minimum=0) for key in ("left", "right", "top", "bottom")]
    elif isinstance(value, list) and len(value) == 4:
        for index, item in enumerate(value):
            _finite_number(item, f"{name}[{index}]", minimum=0)
        distances = value
    else:
        raise RequestValidationError(f"{name} must contain four edge distances")
    return min(distances)


def _candidate_forecasts(value: Any) -> dict[str, dict[str, Any]]:
    candidates = _require_list(value, "forecast.candidates")
    if len(candidates) != len(ACTION_IDS):
        raise RequestValidationError("forecast.candidates must contain exactly nine movement candidates")
    by_id: dict[str, dict[str, Any]] = {}
    for index, candidate in enumerate(candidates):
        candidate = _require_object(candidate, f"forecast.candidates[{index}]")
        movement = _enum(candidate.get("id"), f"forecast.candidates[{index}].id", ACTION_IDS)
        if movement in by_id:
            raise RequestValidationError(f"candidate {movement} is duplicated")
        by_id[movement] = candidate
    missing = [movement for movement in ACTION_IDS if movement not in by_id]
    if missing:
        raise RequestValidationError(f"missing movement candidates: {', '.join(missing)}")
    return by_id


def _path_table(value: Any, player: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = _candidate_forecasts(value)
    center_distance = math.hypot(player["x"] - ARENA_CENTER_X, player["y"] - ARENA_CENTER_Y)
    rows: list[dict[str, Any]] = []
    for movement in ACTION_IDS:
        name = f"candidate {movement}.{LIVE_PATH_LEASE}"
        prediction = _require_object(by_id[movement].get(LIVE_PATH_LEASE), name)
        endpoint = _require_object(prediction.get("endpoint"), f"{name}.endpoint")
        end_x = _observed_number(endpoint, "x", f"{name}.endpoint")
        end_y = _observed_number(endpoint, "y", f"{name}.endpoint")
        contact = _observed_number(prediction, "contact_ms", name, nullable=True, minimum=0)
        rows.append({
            "path": f"{movement}__{LIVE_PATH_LEASE}",
            "collision": contact is not None,
            "collision_ms": contact,
            "gap_px": _observed_number(prediction, "clearance_px", name, nullable=True),
            "wall_room": _edge_room(prediction.get("edge_distances_px"), f"{name}.edge_distances_px"),
            "center_progress": _round1(
                center_distance - math.hypot(end_x - ARENA_CENTER_X, end_y - ARENA_CENTER_Y),
                f"{name}.center_progress",
            ),
        })
    return rows


def _packed_recent_motion(value: Any) -> list[dict[str, Any]]:
    commands = _require_list(value, "recent_commands")
    rows: list[dict[str, Any]] = []
    start = max(0, len(commands) - 2)
    for index, command in enumerate(commands[-2:], start=start):
        command = _require_object(command, f"recent_commands[{index}]")
        rows.append({
            "movement": _enum(command.get("movement"), f"recent_commands[{index}].movement", ACTION_IDS),
            "dx": _round1(command.get("dx"), f"recent_commands[{index}].dx"),
            "dy": _round1(command.get("dy"), f"recent_commands[{index}].dy"),
            "elapsed_ms": _round1(command.get("elapsed_ms"), f"recent_commands[{index}].elapsed_ms", minimum=0),
        })
    return rows


def _packed_hits(value: Any) -> list[dict[str, Any]]:
    hits = _require_list(value, "recent_hits")
    rows: list[dict[str, Any]] = []
    start = max(0, len(hits) - 2)
    for index, hit in enumerate(hits[-2:], start=start):
        hit = _require_object(hit, f"recent_hits[{index}]")
        kind = hit.get("kind")
        if not isinstance(kind, str) or not kind:
            raise RequestValidationError(f"recent_hits[{index}].kind must be a string")
        rows.append({
            "ago_ms": _round1(hit.get("ago_ms"), f"recent_hits[{index}].ago_ms", minimum=0),
            "kind": kind,
            "x": _round1(hit.get("x"), f"recent_hits[{index}].x"),
            "y": _round1(hit.get("y"), f"recent_hits[{index}].y"),
            "vx": _round1(hit.get("vx"), f"recent_hits[{index}].vx"),
            "vy": _round1(hit.get("vy"), f"recent_hits[{index}].vy"),
            "lives_after": _nonnegative_int(hit.get("lives_after"), f"recent_hits[{index}].lives_after"),
        })
    return rows


def build_path_criteria(body: dict[str, Any]) -> dict[str, str]:
    body = _validate_decision_request(body)
    paths = _path_table(body["forecast"].get("candidates"), _packed_player(body["state"].get("player")))
    return {
        row["path"]: (
            f"collision={str(row['collision']).lower()}; collision_ms={row['collision_ms']}; "
            f"gap_px={row['gap_px']}; center_progress={row['center_progress']}; wall_room={row['wall_room']}."
        )
        for row in paths
    }


def pack_model_context(body: dict[str, Any]) -> dict[str, Any]:
    body = _validate_decision_request(body)
    state = body["state"]
    forecast = body["forecast"]
    prefix = _require_object(forecast.get("prefix"), "forecast.prefix")
    assumptions = _require_object(forecast.get("assumptions"), "forecast.assumptions")
    if assumptions.get("enemy_motion") != "current_linear":
        raise RequestValidationError("forecast.assumptions.enemy_motion must be current_linear")
    if assumptions.get("future_spawns_included") is not False:
        raise RequestValidationError("forecast.assumptions.future_spawns_included must be false")
    if assumptions.get("contact_window") != "after_arrival_while_vulnerable":
        raise RequestValidationError("forecast.assumptions.contact_window must be after_arrival_while_vulnerable")
    if assumptions.get("enemy_clearance_window") != "after_arrival":
        raise RequestValidationError("forecast.assumptions.enemy_clearance_window must be after_arrival")

    player = _packed_player(state.get("player"))
    x, y = player["x"], player["y"]
    paths = _path_table(forecast.get("candidates"), player)
    counts = _require_object(state.get("threat_counts"), "threat_counts")
    packed = {
        "player": player,
        "inside_center_region": 360 <= x <= 600 and 230 <= y <= 390,
        "hold_collision": paths[0]["collision"],
        "wait_ms": _observed_number(forecast, "expected_delay_ms", "forecast", minimum=0),
        "wait_collision_ms": _observed_number(prefix, "contact_ms", "forecast.prefix", nullable=True, minimum=0),
        "enemy_count": _nonnegative_int(counts.get("enemies"), "threat_counts.enemies"),
        "hold_gap_px": paths[0]["gap_px"],
    }
    packed_chars = len(_compact_json(packed))
    if packed_chars > MAX_PACKED_STATE_CHARS:
        raise ContextBudgetExceeded(f"packed model state is {packed_chars} chars, limit is {MAX_PACKED_STATE_CHARS}")
    return packed


def build_upstream_payload(run: RunState, packed_state: dict[str, Any], path_criteria: dict[str, str]) -> dict[str, Any]:
    return {
        "model": run.model_identity["configured_model"],
        "instructions": run.prompt_text,
        "state": packed_state,
        "questions": {
            "intent": {
                "type": "choice",
                "instructions": "Classify current intent.",
                "criteria": {intent: INTENT_DESCRIPTIONS[intent] for intent in INTENT_IDS},
            },
            "path": {
                "type": "choice",
                "instructions": (
                    "Survival first. Pick a path with collision=false. "
                    "Among those, favor large gap_px when hold_collision=true or the hold gap_px is below 15. "
                    "It is correct to temporarily move away from center to escape. "
                    "Otherwise favor positive center_progress to return toward center. "
                    "Near center, small movement is preferable to staying in a narrow gap. "
                    "If every path collides, choose the largest collision_ms. "
                    "Never select collision=true to gain center_progress when a collision=false path exists."
                ),
                "criteria": path_criteria,
            },
            "fire": {
                "type": "choice",
                "instructions": "Choose shoot if enemy_count>0, otherwise cease.",
                "criteria": {fire: FIRE_DESCRIPTIONS[fire] for fire in FIRE_IDS},
            },
        },
    }


def _extract_answer(response: Any, name: str, allowed: tuple[str, ...]) -> tuple[str | None, float | None, str | None]:
    if not isinstance(response, dict):
        return None, None, "invalid_root"
    answers = response.get("answers")
    if not isinstance(answers, dict):
        return None, None, "invalid_answers"
    answer = answers.get(name)
    if answer is None:
        return None, None, f"missing_{name}"
    if not isinstance(answer, dict):
        return None, None, f"invalid_{name}_answer"
    choice = answer.get("choice")
    if not isinstance(choice, str):
        return None, None, f"invalid_{name}_choice_type"
    choice = choice.strip().lower()
    if choice not in allowed:
        return None, None, f"unknown_{name}_choice"
    confidence = answer.get("confidence")
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and math.isfinite(confidence):
        confidence_out = round(max(0.0, min(1.0, float(confidence))), 3)
    else:
        confidence_out = None
    return choice, confidence_out, None


def normalize_decision_response(response: Any) -> dict[str, Any]:
    parsed = {
        "intent": _extract_answer(response, "intent", INTENT_IDS),
        "path": _extract_answer(response, "path", PATH_IDS),
        "fire": _extract_answer(response, "fire", FIRE_IDS),
    }
    errors = [error for _, _, error in parsed.values() if error is not None]
    if errors:
        return {
            "intent": None,
            "movement": None,
            "fire": None,
            "lease": None,
            "valid_choice": False,
            "confidence": {"intent": None, "path": None, "movement": None, "fire": None, "lease": None},
            "error": ",".join(errors),
        }
    path = parsed["path"][0]
    assert path is not None
    movement, lease = path.rsplit("__", 1)
    path_confidence = parsed["path"][1]
    return {
        "intent": parsed["intent"][0],
        "movement": movement,
        "fire": parsed["fire"][0],
        "lease": lease,
        "valid_choice": True,
        "confidence": {
            "intent": parsed["intent"][1],
            "path": path_confidence,
            "movement": path_confidence,
            "fire": parsed["fire"][1],
            "lease": path_confidence,
        },
        "error": None,
    }


def _null_decision(
    *,
    body: dict[str, Any],
    decision_id: str,
    api_ok: bool,
    error: str,
    latency_ms: float = 0.0,
    usage: dict[str, int | None] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": body.get("run_id"),
        "epoch": body.get("epoch"),
        "sequence": body.get("sequence"),
        "decision_id": decision_id,
        "intent": None,
        "movement": None,
        "fire": None,
        "lease": None,
        "valid_choice": False,
        "api_ok": api_ok,
        "error": error,
        "latency_ms": round(latency_ms, 1),
        "usage": usage or {"input_tokens": None, "output_tokens": None},
        "confidence": {"intent": None, "path": None, "movement": None, "fire": None, "lease": None},
        "api_token_throughput": None,
    }


def _decision_id(run_id: str, epoch: int, sequence: int) -> str:
    return f"{run_id}-e{epoch}-s{sequence}-{secrets.token_hex(4)}"


def _call_djev(run: RunState, payload: dict[str, Any]) -> UpstreamResult:
    _load_env_file()
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("DJEV_API_KEY", os.environ.get("API_KEY", ""))
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        run.provider_url + "/v1/systemone",
        data=_compact_json(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
            raw_body = response.read().decode("utf-8", errors="replace")
            status = int(response.status)
    except urllib.error.HTTPError as exc:
        raw_body = exc.read().decode("utf-8", errors="replace")
        elapsed_s = max(0.0, time.perf_counter() - started)
        parsed: Any
        parse_error = None
        try:
            parsed = json.loads(raw_body)
        except json.JSONDecodeError as parse_exc:
            parsed = None
            parse_error = f"{type(parse_exc).__name__}: {parse_exc}"
        return UpstreamResult(
            parsed=parsed,
            raw_body=raw_body,
            status=int(exc.code),
            elapsed_s=elapsed_s,
            usage=_usage_from_payload(parsed),
            error=parse_error or f"HTTPError: {exc.code}",
        )
    elapsed_s = max(0.0, time.perf_counter() - started)
    try:
        parsed = json.loads(raw_body)
        parse_error = None
    except json.JSONDecodeError as exc:
        parsed = None
        parse_error = f"{type(exc).__name__}: {exc}"
    return UpstreamResult(
        parsed=parsed,
        raw_body=raw_body,
        status=status,
        elapsed_s=elapsed_s,
        usage=_usage_from_payload(parsed),
        error=parse_error,
    )


def _token_throughput(usage: dict[str, int | None], elapsed_s: float) -> float | None:
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if input_tokens is None or output_tokens is None or elapsed_s <= 0:
        return None
    return round((input_tokens + output_tokens) / elapsed_s, 1)


def handle_decision(body: dict[str, Any]) -> dict[str, Any]:
    body = _validate_decision_request(body)
    run = get_run_state(body["run_id"])
    if not run.upstream_lock.acquire(blocking=False):
        raise ConflictError("decision already in progress for this run", code="decision_in_progress")

    try:
        if run.complete:
            raise ConflictError("run is already complete", code="run_complete")
        decision_id = _decision_id(run.run_id, body["epoch"], body["sequence"])
        server_received_utc = _utc_now()
        server_received_monotonic_ms = round(time.monotonic() * 1000, 3)
        payload: dict[str, Any] | None = None
        try:
            path_criteria = build_path_criteria(body)
            packed_state = pack_model_context(body)
            payload = build_upstream_payload(run, packed_state, path_criteria)
        except ContextBudgetExceeded as exc:
            result = _null_decision(body=body, decision_id=decision_id, api_ok=False, error=exc.code)
            _append_record(
                run,
                {
                    "record_type": "decision_response",
                    "run_id": run.run_id,
                    "decision_id": decision_id,
                    "epoch": body["epoch"],
                    "sequence": body["sequence"],
                    "rawsnapshot": body,
                    "exactactualpayload": None,
                    "exactrequestbody": None,
                    "rawupstreamresponse": None,
                    "times": {"server_received_utc": server_received_utc, "server_received_monotonic_ms": server_received_monotonic_ms},
                    "normalized": result,
                    "error": str(exc),
                    "token_budget": {
                        "packed_state_chars": None,
                        "tokenizer": "unavailable",
                        "max_model_len": MAX_MODEL_LEN,
                        "reserved_output_tokens": RESERVED_OUTPUT_TOKENS,
                    },
                },
                fsync=True,
            )
            return result
        except RequestValidationError:
            _append_record(
                run,
                {
                    "record_type": "decision_validation_failed",
                    "run_id": run.run_id,
                    "decision_id": decision_id,
                    "epoch": body.get("epoch"),
                    "sequence": body.get("sequence"),
                    "rawsnapshot": body,
                    "times": {"server_received_utc": server_received_utc, "server_received_monotonic_ms": server_received_monotonic_ms},
                },
                fsync=True,
            )
            raise

        # Canonical JSONL sorts objects; this string preserves upstream choice-label order.
        # _call_djev serializes the same unmodified payload with _compact_json.
        exact_request_body = _compact_json(payload)
        packed_chars = len(_compact_json(payload["state"]))
        _append_record(
            run,
            {
                "record_type": "decision_request",
                "run_id": run.run_id,
                "decision_id": decision_id,
                "epoch": body["epoch"],
                "sequence": body["sequence"],
                "snapshot_tick": body["snapshot_tick"],
                "rawsnapshot": body,
                "exactactualpayload": payload,
                "exactrequestbody": exact_request_body,
                "prompt_version": run.prompt_version,
                "prompt_hash": run.prompt_hash,
                "context_version": run.context_version,
                "model_identity": run.model_identity,
                "times": {
                    "server_received_utc": server_received_utc,
                    "server_received_monotonic_ms": server_received_monotonic_ms,
                    "client_send_wall_ms": body["client_send_wall_ms"],
                },
                "token_budget": {
                    "packed_state_chars": packed_chars,
                    "tokenizer": "unavailable",
                    "max_model_len": MAX_MODEL_LEN,
                    "reserved_output_tokens": RESERVED_OUTPUT_TOKENS,
                    "target_input_tokens": MAX_MODEL_LEN - RESERVED_OUTPUT_TOKENS,
                },
            },
        )

        upstream_started_utc = _utc_now()
        upstream_started_monotonic_ms = round(time.monotonic() * 1000, 3)
        try:
            upstream = _call_djev(run, payload)
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, UnicodeDecodeError) as exc:
            latency_ms = max(0.0, time.monotonic() * 1000 - upstream_started_monotonic_ms)
            result = _null_decision(
                body=body,
                decision_id=decision_id,
                api_ok=False,
                error=f"{type(exc).__name__}: {exc}",
                latency_ms=latency_ms,
            )
            _append_record(
                run,
                {
                    "record_type": "decision_response",
                    "run_id": run.run_id,
                    "decision_id": decision_id,
                    "epoch": body["epoch"],
                    "sequence": body["sequence"],
                    "rawsnapshot": body,
                    "exactactualpayload": payload,
                    "exactrequestbody": exact_request_body,
                    "rawupstreamresponse": {"status": None, "body": None, "parsed": None, "error": result["error"]},
                    "times": {
                        "server_received_utc": server_received_utc,
                        "upstream_started_utc": upstream_started_utc,
                        "upstream_started_monotonic_ms": upstream_started_monotonic_ms,
                        "latency_ms": result["latency_ms"],
                    },
                    "normalized": result,
                    "model_identity": run.model_identity,
                },
                fsync=True,
            )
            run.invalid_decision_count += 1
            return result

        api_ok = upstream.status is not None and 200 <= upstream.status < 300 and upstream.error is None
        if api_ok:
            normalized = normalize_decision_response(upstream.parsed)
        else:
            normalized = {
                "intent": None,
                "movement": None,
                "fire": None,
                "lease": None,
                "valid_choice": False,
                "confidence": {"intent": None, "path": None, "movement": None, "fire": None, "lease": None},
                "error": upstream.error or f"upstream_status_{upstream.status}",
            }
        if isinstance(upstream.parsed, dict) and isinstance(upstream.parsed.get("model"), str):
            run.model_identity = {**run.model_identity, "response_model": upstream.parsed["model"]}
        throughput = _token_throughput(upstream.usage, upstream.elapsed_s)
        result = {
            "schema_version": SCHEMA_VERSION,
            "run_id": run.run_id,
            "epoch": body["epoch"],
            "sequence": body["sequence"],
            "decision_id": decision_id,
            "intent": normalized["intent"],
            "movement": normalized["movement"],
            "fire": normalized["fire"],
            "lease": normalized["lease"],
            "valid_choice": normalized["valid_choice"],
            "api_ok": api_ok,
            "error": normalized["error"],
            "latency_ms": round(upstream.elapsed_s * 1000, 1),
            "usage": upstream.usage,
            "confidence": normalized["confidence"],
            "api_token_throughput": throughput,
        }
        run.decision_count += 1
        if not result["valid_choice"] or not result["api_ok"]:
            run.invalid_decision_count += 1
        _append_record(
            run,
            {
                "record_type": "decision_response",
                "run_id": run.run_id,
                "decision_id": decision_id,
                "epoch": body["epoch"],
                "sequence": body["sequence"],
                "rawsnapshot": body,
                "exactactualpayload": payload,
                "exactrequestbody": exact_request_body,
                "rawupstreamresponse": {
                    "status": upstream.status,
                    "body": upstream.raw_body,
                    "parsed": upstream.parsed,
                    "error": upstream.error,
                },
                "times": {
                    "server_received_utc": server_received_utc,
                    "upstream_started_utc": upstream_started_utc,
                    "upstream_started_monotonic_ms": upstream_started_monotonic_ms,
                    "latency_ms": result["latency_ms"],
                    "client_send_wall_ms": body["client_send_wall_ms"],
                },
                "usage": upstream.usage,
                "api_token_throughput": throughput,
                "normalized": result,
                "model_identity": run.model_identity,
            },
            fsync=not result["api_ok"] or not result["valid_choice"],
        )
        return result
    finally:
        run.upstream_lock.release()


def _validate_event(event: Any) -> dict[str, Any]:
    event = _require_object(event, "event")
    _nonnegative_int(event.get("event_id"), "event.event_id")
    _nonnegative_int(event.get("epoch"), "event.epoch")
    _integer_or_none(event.get("sequence"), "event.sequence")
    _nonnegative_int(event.get("tick"), "event.tick")
    _finite_number(event.get("sim_ms"), "event.sim_ms", minimum=0)
    _finite_number(event.get("wall_ms"), "event.wall_ms", minimum=0)
    if not isinstance(event.get("type"), str) or not event["type"]:
        raise RequestValidationError("event.type must be a nonempty string")
    if not isinstance(event.get("payload"), dict):
        raise RequestValidationError("event.payload must be an object")
    return event


def _split_event_views(events: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    execution_types = {"command_applied", "command_ended", "neutral_started", "neutral_ended", "shot", "response_received", "response_rejected"}
    return {
        "clientexecution": [event for event in events if event["type"] in execution_types],
        "hits": [event for event in events if event["type"] == "hit"],
        "checkpoints": [event for event in events if event["type"] == "checkpoint"],
    }


def record_run_events(body: dict[str, Any]) -> dict[str, Any]:
    body = _require_schema(body)
    run = get_run_state(body.get("run_id"))
    if run.complete:
        raise ConflictError("run is already complete", code="run_complete")
    raw_events = _require_list(body.get("events"), "events")
    if not raw_events:
        raise RequestValidationError("events must not be empty")
    events = [_validate_event(event) for event in raw_events]

    with run.event_lock:
        temp_last = run.last_event_id
        new_events: list[dict[str, Any]] = []
        new_hashes: dict[int, str] = {}
        for event in events:
            event_id = event["event_id"]
            event_hash = _canonical_json(event)
            if temp_last is not None and event_id <= temp_last:
                if run.event_hashes.get(event_id) != event_hash:
                    raise ConflictError(f"conflicting duplicate event_id {event_id}", code="event_conflict")
                continue
            if temp_last is None:
                if event_id not in {0, 1}:
                    raise ConflictError(f"event gap before first event_id {event_id}", code="event_gap")
            elif event_id != temp_last + 1:
                raise ConflictError(f"event gap: expected {temp_last + 1}, got {event_id}", code="event_gap")
            temp_last = event_id
            new_events.append(event)
            new_hashes[event_id] = event_hash
        if new_events:
            views = _split_event_views(new_events)
            fsync = any(event["type"] in {"hit", "checkpoint", "terminal", "qualification_invalidated"} for event in new_events)
            _append_record(
                run,
                {
                    "record_type": "client_events",
                    "run_id": run.run_id,
                    "event_id_start": new_events[0]["event_id"],
                    "event_id_end": new_events[-1]["event_id"],
                    "events": new_events,
                    **views,
                    "times": {"server_receive_utc": _utc_now()},
                },
                fsync=fsync,
            )
            run.event_hashes.update(new_hashes)
            run.last_event_id = temp_last
            run.event_count += len(new_events)
        return {
            "schema_version": SCHEMA_VERSION,
            "run_id": run.run_id,
            "acked_event_id": run.last_event_id if run.last_event_id is not None else -1,
        }


def _validate_terminal(value: Any) -> dict[str, Any]:
    terminal = _require_object(value, "terminal")
    reason = terminal.get("reason")
    if reason not in {"death", "target", "aborted", "timing_invalid", "trace_error"}:
        raise RequestValidationError("terminal.reason is unknown")
    _nonnegative_int(terminal.get("tick"), "terminal.tick")
    _finite_number(terminal.get("sim_ms"), "terminal.sim_ms", minimum=0)
    _finite_number(terminal.get("wall_ms"), "terminal.wall_ms", minimum=0)
    _nonnegative_int(terminal.get("lives"), "terminal.lives")
    _nonnegative_int(terminal.get("wave"), "terminal.wave")
    _finite_number(terminal.get("score"), "terminal.score", minimum=0)
    violations = _require_list(terminal.get("qualification_violations"), "terminal.qualification_violations")
    for index, violation in enumerate(violations):
        if not isinstance(violation, str):
            raise RequestValidationError(f"terminal.qualification_violations[{index}] must be a string")
    return terminal


def end_run(body: dict[str, Any]) -> dict[str, Any]:
    body = _require_schema(body)
    run = get_run_state(body.get("run_id"))
    last_event_id = _nonnegative_int(body.get("last_event_id"), "last_event_id")
    terminal = _validate_terminal(body.get("terminal"))
    if not run.upstream_lock.acquire(timeout=END_RUN_UPSTREAM_WAIT_S):
        raise ConflictError("decision still in progress for this run", code="decision_in_progress")
    try:
        with run.event_lock:
            expected_last = run.last_event_id if run.last_event_id is not None else 0
            if run.complete:
                raise ConflictError("run is already complete", code="run_complete")
            if last_event_id != expected_last:
                raise ConflictError(f"terminal last_event_id {last_event_id} does not match acked {expected_last}", code="event_gap")
            summary = {
                "status": "complete",
                "terminal_reason": terminal["reason"],
                "last_event_id": expected_last,
                "events": run.event_count,
                "decisions": run.decision_count,
                "invalid_decisions": run.invalid_decision_count,
                "trace_complete": True,
                "sim_ms": terminal["sim_ms"],
                "wall_ms": terminal["wall_ms"],
                "lives": terminal["lives"],
                "wave": terminal["wave"],
                "score": terminal["score"],
                "qualification_violations": terminal["qualification_violations"],
            }
            run.complete = True
            run.terminal = terminal
            _append_record(
                run,
                {
                    "record_type": "run_ended",
                    "run_id": run.run_id,
                    "last_event_id": expected_last,
                    "terminal": terminal,
                    "summary": summary,
                    "times": {"server_receive_utc": _utc_now()},
                },
                fsync=True,
            )
    finally:
        run.upstream_lock.release()
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run.run_id,
        "complete": True,
        "trace_path": str(run.events_path.resolve()),
        "summary": summary,
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

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        self._send(status, json.dumps(payload, allow_nan=False, separators=(",", ":")).encode("utf-8"), "application/json")

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise RequestValidationError("invalid Content-Length") from exc
        if length <= 0:
            raise RequestValidationError("request body is required")
        if length > 4 * 1024 * 1024:
            raise RequestValidationError("request body is too large")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RequestValidationError(f"invalid JSON: {exc}") from exc

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/config":
            self._send_json(200, {"schema_version": SCHEMA_VERSION, "provider": effective_provider_config()})
        elif self.path in {"/", "/space-shooter.html"}:
            self._send(200, HTML_PATH.read_bytes(), "text/html; charset=utf-8")
        elif self.path in STATIC_ASSETS:
            asset_path, content_type = STATIC_ASSETS[self.path]
            self._send(200, asset_path.read_bytes(), content_type)
        elif self.path == "/health":
            self._send(200, b'{"ok":true}', "application/json")
        else:
            self._send_json(404, {"schema_version": SCHEMA_VERSION, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        routes = {
            "/api/run/start": start_run,
            "/api/decision": handle_decision,
            "/api/run/event": record_run_events,
            "/api/run/end": end_run,
        }
        handler = routes.get(self.path)
        if handler is None:
            self._send_json(404, {"schema_version": SCHEMA_VERSION, "error": "not found"})
            return
        try:
            result = handler(self._read_json())
            self._send_json(200, result)
        except ApiError as exc:
            self._send_json(exc.status, {"schema_version": SCHEMA_VERSION, "error": str(exc), "code": exc.code})
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self._send_json(500, {"schema_version": SCHEMA_VERSION, "error": f"{type(exc).__name__}: {exc}", "code": "internal_error"})

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the djev-authoritative space shooter bridge")
    parser.add_argument("--host", default=os.environ.get("SHOOTER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SHOOTER_PORT", "7862")))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Space shooter: http://{args.host}:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
