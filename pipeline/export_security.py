"""
Export pipeline_report.json to AIRTA Systems security assessment import API.

Default:
  POST /api/v2/security-assessments/import
  Body: results[], test_id, severity, assessment_reasoning (see security-assessment-export.md)

Legacy compliance import (opt-in):
  Set GENBOUNTY_EXPORT_SCHEMA=legacy
  POST /api/v2/imported-reports/company

Required env vars:
  GENBOUNTY_HOST, GENBOUNTY_API_KEY, GENBOUNTY_USER_ID
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

LEGACY_IMPORT_PATH = "/api/v2/imported-reports/company"
SECURITY_IMPORT_PATH = "/api/v2/security-assessments/import"
DEFAULT_EXPORT_BATCH_SIZE = 25
MAX_EXPORT_BATCH_SIZE = 2500
DEFAULT_EXPORT_BATCH_DELAY_SECONDS = 2.0
DEFAULT_EXPORT_MAX_RETRIES = 6
DEFAULT_EXPORT_RETRY_BASE_SECONDS = 5.0
ASSESSMENT_TYPE = "security"

VALID_SEVERITIES = frozenset({
    "indeterminate",
    "informational",
    "low",
    "medium",
    "high",
    "critical",
})

# Ordered list for UI/CLI (highest severity first).
EXPORT_RISK_LEVELS = (
    "critical",
    "high",
    "medium",
    "low",
    "informational",
    "indeterminate",
)

_LEGACY_SEVERITY_ALIASES = {
    "mitigated": "low",
    "compliant": "low",
}


def export_schema() -> str:
    """Return ``legacy`` or ``security`` from env."""
    value = (os.getenv("GENBOUNTY_EXPORT_SCHEMA") or "security").strip().lower()
    return value if value in ("legacy", "security") else "security"


def _coerce_positive_int(value: object, default: int, *, minimum: int = 1, maximum: int | None = None) -> int:
    parsed: int | None
    if isinstance(value, bool):
        parsed = None
    elif isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
    else:
        parsed = None
    if parsed is None or parsed < minimum:
        parsed = default
    if maximum is not None:
        parsed = min(parsed, maximum)
    return parsed


def _coerce_non_negative_float(value: object, default: float) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        parsed = float(value)
        return parsed if parsed >= 0 else default
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
            return parsed if parsed >= 0 else default
        except ValueError:
            pass
    return default


def export_batch_size() -> int:
    """Results per POST; default 25 to avoid Cloudflare/API rate limits."""
    return _coerce_positive_int(
        os.getenv("GENBOUNTY_EXPORT_BATCH_SIZE"),
        DEFAULT_EXPORT_BATCH_SIZE,
        minimum=1,
        maximum=MAX_EXPORT_BATCH_SIZE,
    )


def export_batch_delay_seconds() -> float:
    """Pause between export batches (and between multi-report exports)."""
    return _coerce_non_negative_float(
        os.getenv("GENBOUNTY_EXPORT_DELAY_SECONDS"),
        DEFAULT_EXPORT_BATCH_DELAY_SECONDS,
    )


def export_max_retries() -> int:
    return _coerce_positive_int(
        os.getenv("GENBOUNTY_EXPORT_MAX_RETRIES"),
        DEFAULT_EXPORT_MAX_RETRIES,
        minimum=1,
        maximum=20,
    )


def export_retry_base_seconds() -> float:
    return _coerce_non_negative_float(
        os.getenv("GENBOUNTY_EXPORT_RETRY_BASE_SECONDS"),
        DEFAULT_EXPORT_RETRY_BASE_SECONDS,
    ) or 1.0


def split_export_batches(results: list[dict], batch_size: int | None = None) -> list[list[dict]]:
    size = batch_size if batch_size is not None else export_batch_size()
    size = _coerce_positive_int(size, DEFAULT_EXPORT_BATCH_SIZE, minimum=1, maximum=MAX_EXPORT_BATCH_SIZE)
    return [results[i : i + size] for i in range(0, len(results), size)]


def _is_rate_limited_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        token in text
        for token in (
            "429",
            "rate limit",
            "too many requests",
            "cloudflare",
            "resource_exhausted",
            "temporarily unavailable",
            "503",
        )
    )


def import_path() -> str:
    override = (os.getenv("GENBOUNTY_IMPORT_PATH") or "").strip()
    if override:
        return override if override.startswith("/") else f"/{override}"
    return SECURITY_IMPORT_PATH if export_schema() == "security" else LEGACY_IMPORT_PATH


def normalize_severity(value: object, default: str | None = None) -> str:
    if isinstance(value, str):
        normalized = _LEGACY_SEVERITY_ALIASES.get(value.strip().lower(), value.strip().lower())
        if normalized in VALID_SEVERITIES:
            return normalized
    if default:
        normalized_default = default.strip().lower()
        if normalized_default in VALID_SEVERITIES:
            return normalized_default
    return "indeterminate"


def normalize_export_risk_levels(levels: object) -> set[str] | None:
    """Parse UI/CLI risk level filter. None means export all severities."""
    if levels is None:
        return None
    if isinstance(levels, str):
        parts = [p.strip() for p in levels.replace(",", " ").split() if p.strip()]
        levels = parts
    if not isinstance(levels, (list, tuple, set, frozenset)):
        return None
    out: set[str] = set()
    for raw in levels:
        if isinstance(raw, str) and raw.strip():
            level = normalize_severity(raw.strip())
            if level in VALID_SEVERITIES:
                out.add(level)
    return out or None


def filter_results_by_risk_levels(
    results: list[dict],
    risk_levels: set[str] | None,
    *,
    default_severity: str | None = None,
) -> list[dict]:
    if not risk_levels:
        return results
    return [
        item
        for item in results
        if normalize_severity(item.get("risk_level"), default_severity) in risk_levels
    ]


def _attack_blocked(severity: str) -> bool:
    return severity in ("low", "informational")


def _normalize_timestamp(value: object) -> object:
    if not isinstance(value, str) or not value.strip():
        return value
    text = value.strip()
    for fmt in ("%Y-%m-%dT%H-%M-%S", "%Y-%m-%d_%H-%M-%S"):
        try:
            return datetime.strptime(text, fmt).isoformat(timespec="milliseconds") + "Z"
        except ValueError:
            pass
    return text


def _strip_nulls(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_strip_nulls(v) for v in value]
    return value


def _normalize_experts_summary(items: object, *, legacy: bool) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if legacy:
            level = normalize_severity(item.get("risk_level") or item.get("severity"))
            reasoning = str(item.get("reasoning") or item.get("justification") or "").strip()
            row: dict[str, Any] = {"risk_level": level}
            if reasoning:
                row["reasoning"] = reasoning
            out.append(row)
            continue
        level = normalize_severity(item.get("risk_level") or item.get("severity"))
        reasoning = str(item.get("reasoning") or item.get("justification") or "").strip()
        row = {"severity": level}
        if reasoning:
            row["reasoning"] = reasoning
        framework = item.get("framework") or item.get("playbook")
        if framework:
            row["framework"] = framework
        out.append(row)
    return out


def _infer_strategy_from_source(source_file: object) -> str | None:
    if not isinstance(source_file, str) or not source_file.strip():
        return None
    lower = source_file.replace("\\", "/").lower()
    if "/multi-shot/" in lower:
        return "multi_shot"
    if "/zero-shot/" in lower:
        return "zero_shot"
    return None


def _normalize_turn_record(turn: object) -> dict[str, Any] | None:
    if not isinstance(turn, dict):
        return None
    turn_num = turn.get("turn")
    if turn_num is None:
        return None
    try:
        turn_index = int(turn_num)
    except (TypeError, ValueError):
        return None
    return {
        "turn": turn_index,
        "prompt": str(turn.get("prompt") or ""),
        "response": str(turn.get("response") or ""),
    }


def _normalize_turns_list(turns: object) -> list[dict[str, Any]] | None:
    if not isinstance(turns, list) or not turns:
        return None
    out: list[dict[str, Any]] = []
    for item in turns:
        row = _normalize_turn_record(item)
        if row is not None:
            out.append(row)
    return out or None


def _multiturn_export_fields(item: dict, *, source_file: object = None) -> dict[str, Any]:
    """Map strategy and multi-turn conversation fields for API export."""
    out: dict[str, Any] = {}
    strategy = item.get("strategy")
    if isinstance(strategy, str) and strategy.strip():
        out["strategy"] = strategy.strip()
    else:
        inferred = _infer_strategy_from_source(source_file)
        if inferred:
            out["strategy"] = inferred
    prior_turns = _normalize_turns_list(item.get("prior_turns"))
    if prior_turns:
        out["prior_turns"] = prior_turns
    turns = _normalize_turns_list(item.get("turns"))
    if turns:
        out["turns"] = turns
    return out


def _legacy_optional_result_fields(item: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in ("description", "expected_behavior", "ok", "status", "error", "response_html"):
        if key in item and item[key] is not None:
            out[key] = item[key]
    return out


def _security_optional_result_fields(item: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in ("vector_type", "description", "status", "error", "response_html"):
        if key in item and item[key] is not None:
            out[key] = item[key]
    return out


def _optional_result_fields(item: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in (
        "vector_type",
        "artifact_path",
        "description",
        "expected_behavior",
        "ok",
        "status",
        "error",
        "response_html",
    ):
        if key in item and item[key] is not None:
            out[key] = item[key]
    return out


def build_legacy_export_result(
    item: dict,
    *,
    default_severity: str | None = None,
    source_file: object = None,
) -> dict[str, Any]:
    """Map pipeline row to imported-reports/company schema."""
    risk_level = normalize_severity(item.get("risk_level"), default_severity)
    mandate = item.get("mandate") or item.get("category") or ""
    result: dict[str, Any] = {
        "id": item.get("id", ""),
        "mandate": mandate,
        "prompt": item.get("prompt", ""),
        "response": item.get("response", ""),
        "risk_level": risk_level,
        "judge_reasoning": item.get("judge_reasoning", ""),
    }
    result.update(_legacy_optional_result_fields(item))
    result.update(_multiturn_export_fields(item, source_file=source_file))
    if item.get("experts_summary"):
        result["experts_summary"] = _normalize_experts_summary(item["experts_summary"], legacy=True)
    return result


def _legacy_framework(data: dict) -> str:
    return (
        str(data.get("playbook") or data.get("framework") or data.get("playbook_id") or "")
        .strip()
        or "security_assessment"
    )


def build_legacy_export_payload(
    data: dict,
    results: list[dict] | None = None,
    *,
    default_severity: str | None = None,
) -> dict[str, Any]:
    rows = results if results is not None else data.get("adversarial_results", [])
    source_file = data.get("source_file")
    payload: dict[str, Any] = {
        "timestamp": _normalize_timestamp(data.get("timestamp", "")),
        "framework": _legacy_framework(data),
        "source_file": data.get("source_file", ""),
        "run_log_dir": data.get("run_log_dir", ""),
        "adversarial_results": [
            build_legacy_export_result(
                item,
                default_severity=default_severity,
                source_file=source_file,
            )
            for item in rows
        ],
    }
    compliance_log = data.get("compliance_log") or data.get("attack_log")
    if compliance_log:
        payload["compliance_log"] = compliance_log
    return _strip_nulls(payload)


_NO_RESPONSE_PLACEHOLDER = "[no response captured]"


def normalize_export_response(item: dict) -> str:
    """API requires a non-empty response string."""
    raw = item.get("response")
    if raw is not None and str(raw).strip():
        return str(raw).strip()
    err = item.get("error")
    if err is not None and str(err).strip():
        return f"[run error] {str(err).strip()}"
    if item.get("ok") is False:
        return "[no response captured — target returned no output]"
    return _NO_RESPONSE_PLACEHOLDER


def _load_run_log_responses(run_log_dir: object) -> dict[str, str]:
    if not isinstance(run_log_dir, str) or not run_log_dir.strip():
        return {}
    path = Path(run_log_dir) / "run_log.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, str] = {}
    for entry in data.get("entries") or []:
        eid = str(entry.get("id") or "").strip()
        resp = entry.get("response")
        if eid and resp is not None and str(resp).strip():
            out[eid] = str(resp).strip()
    return out


def _load_suite_index(source_file: object) -> list[dict]:
    if not isinstance(source_file, str) or not source_file.strip():
        return []
    path = Path(source_file)
    if not path.is_file():
        return []
    try:
        from pipeline.convert_log import build_suite_prompt_index

        suite = json.loads(path.read_text(encoding="utf-8"))
        return build_suite_prompt_index(suite)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return []


def enrich_results_for_export(data: dict, results: list[dict]) -> list[dict]:
    """Fill missing category/test_id/response from suite and run log when possible."""
    index = _load_suite_index(data.get("source_file"))
    run_log_responses = _load_run_log_responses(data.get("run_log_dir"))
    from pipeline.convert_log import resolve_suite_match

    playbook = str(data.get("playbook") or data.get("framework") or "Security").strip()
    fallback_category = playbook or "Uncategorized"
    enriched: list[dict] = []
    for i, item in enumerate(results):
        row = dict(item)
        category = str(row.get("category") or row.get("mandate") or "").strip()
        matched = resolve_suite_match(row, index, position=i) if index else None
        if matched:
            if not category:
                category = str(matched.get("category") or matched.get("mandate") or "").strip()
            if not row.get("description") and matched.get("description"):
                row["description"] = matched["description"]
            tid = str(row.get("id") or "").strip()
            if tid.startswith(("entry-", "batch-")) and matched.get("id"):
                row["id"] = matched["id"]
        row["category"] = category or fallback_category

        if not str(row.get("response") or "").strip():
            tid = str(row.get("id") or "").strip()
            if tid and tid in run_log_responses:
                row["response"] = run_log_responses[tid]

        if not row.get("strategy"):
            inferred = _infer_strategy_from_source(data.get("source_file"))
            if inferred:
                row["strategy"] = inferred

        enriched.append(row)
    return enriched


def build_security_export_result(
    item: dict,
    *,
    default_severity: str | None = None,
    source_file: object = None,
) -> dict[str, Any]:
    """Map pipeline row to security-assessments/import schema."""
    severity = normalize_severity(item.get("risk_level"), default_severity)
    ok = item.get("ok")
    if ok is None:
        ok = True
    category = str(item.get("category") or item.get("mandate") or "").strip() or "Uncategorized"
    reasoning = str(item.get("judge_reasoning") or "").strip() or "No assessment reasoning recorded."
    result: dict[str, Any] = {
        "test_id": item.get("id", ""),
        "prompt": item.get("prompt", ""),
        "ok": bool(ok),
        "category": category,
        "response": normalize_export_response(item),
        "severity": severity,
        "assessment_reasoning": reasoning,
        "attack_blocked": _attack_blocked(severity),
    }
    result.update(_security_optional_result_fields(item))
    result.update(_multiturn_export_fields(item, source_file=source_file))
    if item.get("experts_summary"):
        result["experts_summary"] = _normalize_experts_summary(item["experts_summary"], legacy=False)
    return result


def build_security_export_payload(
    data: dict,
    results: list[dict] | None = None,
    *,
    default_severity: str | None = None,
) -> dict[str, Any]:
    raw_rows = results if results is not None else data.get("adversarial_results", [])
    rows = enrich_results_for_export(data, raw_rows) if export_schema() == "security" else raw_rows
    source_file = data.get("source_file")
    payload: dict[str, Any] = {
        "assessment_type": ASSESSMENT_TYPE,
        "timestamp": _normalize_timestamp(data.get("timestamp", "")),
        "playbook": data.get("playbook", data.get("framework", "")),
        "playbook_id": data.get("playbook_id", ""),
        "source_file": data.get("source_file", ""),
        "run_log_dir": data.get("run_log_dir", ""),
        "attack_log": data.get("attack_log", data.get("compliance_log", "")),
        "results": [
            build_security_export_result(
                item,
                default_severity=default_severity,
                source_file=source_file,
            )
            for item in rows
        ],
    }
    rollup = data.get("category_rollup")
    if isinstance(rollup, dict) and rollup:
        payload["category_rollup"] = {
            key: normalize_severity(value, default_severity)
            for key, value in rollup.items()
        }
    return _strip_nulls(payload)


def build_export_payload(
    data: dict,
    results: list[dict] | None = None,
    *,
    default_severity: str | None = None,
    schema: str | None = None,
) -> dict[str, Any]:
    mode = schema or export_schema()
    if mode == "security":
        return build_security_export_payload(data, results, default_severity=default_severity)
    return build_legacy_export_payload(data, results, default_severity=default_severity)


def _build_url(host: str, path: str | None = None) -> str:
    host = host.strip().rstrip("/")
    if not host.startswith(("http://", "https://")):
        host = "https://" + host
    return host + (path or import_path())


def _format_http_error(status: int, error_body: dict | str) -> str:
    if isinstance(error_body, dict):
        message = error_body.get("message") or error_body.get("error") or json.dumps(error_body)
        details = error_body.get("errors") or error_body.get("details") or error_body.get("validation")
        if details:
            detail_text = json.dumps(details, ensure_ascii=False)
            if len(detail_text) > 1200:
                detail_text = detail_text[:1200] + "…"
            return f"HTTP {status}: {message} - {detail_text}"
        return f"HTTP {status}: {message}"
    text = str(error_body)
    if len(text) > 1500:
        text = text[:1500] + "…"
    return f"HTTP {status}: {text}"


def _post_json(url: str, api_key: str, user_id: str, payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "X-User-Id": user_id,
            "User-Agent": "AIRTA-Black-Box/SecurityExporter/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        try:
            error_body = json.loads(body_text)
        except Exception:
            raise RuntimeError(_format_http_error(e.code, body_text)) from e
        raise RuntimeError(_format_http_error(e.code, error_body)) from e


def _post_json_with_retry(
    url: str,
    api_key: str,
    user_id: str,
    payload: dict,
    *,
    max_retries: int | None = None,
    retry_base_seconds: float | None = None,
) -> dict:
    attempts = max_retries if max_retries is not None else export_max_retries()
    base_delay = retry_base_seconds if retry_base_seconds is not None else export_retry_base_seconds()
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return _post_json(url, api_key, user_id, payload)
        except Exception as exc:
            last_error = exc
            if not _is_rate_limited_error(exc) or attempt >= attempts - 1:
                raise
            wait = base_delay * (2 ** attempt)
            print(
                f"[*] Rate limited (attempt {attempt + 1}/{attempts}) - "
                f"waiting {wait:.1f}s before retry..."
            )
            time.sleep(wait)
    if last_error:
        raise last_error
    raise RuntimeError("Export POST failed without error detail")


def _coerce_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _extract_summary(resp: dict, batch_size: int) -> dict[str, int]:
    summary = resp.get("summary")
    if not isinstance(summary, dict):
        summary = {}
    data = resp.get("data")
    if not isinstance(data, dict):
        data = {}

    failed = _coerce_int(summary.get("failed"))
    if failed is None:
        failed = _coerce_int(resp.get("failed"))
    if failed is None:
        errors = resp.get("errors")
        failed = len(errors) if isinstance(errors, list) else 0

    total = _coerce_int(summary.get("total"))
    if total is None:
        total = _coerce_int(resp.get("total"))
    if total is None:
        total = batch_size

    created = _coerce_int(summary.get("created"))
    if created is None:
        created = _coerce_int(resp.get("created"))
    if created is None:
        created = _coerce_int(resp.get("inserted"))
    if created is None:
        created = _coerce_int(resp.get("imported"))
    if created is None:
        created = _coerce_int(data.get("importedCount"))
    if created is None:
        created = max(0, total - failed)

    return {"total": total, "created": created, "failed": failed}


def export_pipeline_report(
    report_path: Path,
    *,
    host: str,
    api_key: str,
    user_id: str,
    default_level: str | None = None,
    risk_levels: list[str] | set[str] | None = None,
    batch_size: int | None = None,
    batch_delay_seconds: float | None = None,
) -> list[dict]:
    data = json.loads(report_path.read_text(encoding="utf-8"))
    results: list[dict] = data.get("adversarial_results", [])
    if export_schema() == "security":
        results = enrich_results_for_export(data, results)

    allowed_levels = normalize_export_risk_levels(risk_levels)
    if allowed_levels is not None:
        before = len(results)
        results = filter_results_by_risk_levels(results, allowed_levels, default_severity=default_level)
        label = ", ".join(level for level in EXPORT_RISK_LEVELS if level in allowed_levels)
        print(f"[*] Risk level filter ({label}): {len(results)}/{before} result(s)")

    if not results:
        if allowed_levels is not None:
            print("[-] No results match the selected risk levels.")
        else:
            print("[-] No assessment results found in report (adversarial_results empty).")
        return []

    schema = export_schema()
    path = import_path()
    url = _build_url(host, path)
    total = len(results)
    size = batch_size if batch_size is not None else export_batch_size()
    delay = export_batch_delay_seconds() if batch_delay_seconds is None else max(0.0, float(batch_delay_seconds))
    batches = split_export_batches(results, size)

    print(
        f"[*] Exporting {total} result(s) in {len(batches)} batch(es) "
        f"({size} per batch, {delay:.1f}s delay, schema={schema}) to {url}"
    )

    responses: list[dict] = []
    for idx, batch in enumerate(batches, 1):
        print(f"[*] Sending batch {idx}/{len(batches)} ({len(batch)} item(s))...")
        payload = build_export_payload(data, batch, default_severity=default_level, schema=schema)

        try:
            resp = _post_json_with_retry(url, api_key, user_id, payload)
        except Exception as e:
            print(f"[!] Batch {idx} failed: {e}")
            responses.append({
                "batch": idx,
                "error": str(e),
                "summary": {"total": len(batch), "created": 0, "failed": len(batch)},
            })
            if idx < len(batches) and delay > 0:
                print(f"[*] Waiting {delay:.1f}s before next batch...")
                time.sleep(delay)
            continue

        success = resp.get("success", False)
        summary = _extract_summary(resp, len(batch))
        errors = resp.get("errors", [])
        resp["summary"] = summary

        if success:
            print(
                f"[+] Batch {idx} accepted - "
                f"total={summary.get('total', '?')}, "
                f"created={summary.get('created', '?')}, "
                f"failed={summary.get('failed', '?')}"
            )
        else:
            err_code = resp.get("error", "unknown")
            print(f"[!] Batch {idx} returned success=false: {err_code}")

        if errors:
            print(f"    {len(errors)} import error(s):")
            for err in errors[:10]:
                print(f"      index={err.get('index')}, id={err.get('id')}: {err.get('message')}")
            if len(errors) > 10:
                print(f"      ... and {len(errors) - 10} more.")

        resp["batch"] = idx
        responses.append(resp)

        if idx < len(batches) and delay > 0:
            print(f"[*] Waiting {delay:.1f}s before next batch...")
            time.sleep(delay)

    created_total = sum(r.get("summary", {}).get("created", 0) for r in responses if "summary" in r)
    failed_total = sum(r.get("summary", {}).get("failed", 0) for r in responses if "summary" in r)
    print(
        f"\n[+] Export complete - "
        f"{created_total} created, {failed_total} failed across {len(batches)} batch(es)."
    )
    return responses
