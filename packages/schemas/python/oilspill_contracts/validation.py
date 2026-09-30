"""Dependency-free validation for the canonical JSON Schema subset."""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Never, cast
from urllib.parse import urlparse

JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject = dict[str, JsonValue]

_SCHEMA_PATH = Path(__file__).parents[2] / "schema" / "contracts.schema.json"
_SCHEMA = cast(JsonObject, json.loads(_SCHEMA_PATH.read_text(encoding="utf-8")))


class ContractValidationError(ValueError):
    """Raised when a payload violates a shared contract."""


def _fail(path: str, message: str) -> Never:
    raise ContractValidationError(f"{path}: {message}")


def _object(value: JsonValue, path: str) -> JsonObject:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    return value


def _resolve(reference: str) -> JsonObject:
    definitions = _object(_SCHEMA.get("$defs"), "$defs")
    result = definitions.get(reference.rsplit("/", 1)[-1])
    return _object(result, reference)


def _validate_node(rule: JsonObject, value: JsonValue, path: str) -> None:
    reference = rule.get("$ref")
    if isinstance(reference, str):
        _validate_node(_resolve(reference), value, path)
        return
    if "const" in rule and value != rule["const"]:
        _fail(path, f"must equal {rule['const']!r}")
    allowed = rule.get("enum")
    if isinstance(allowed, list) and value not in allowed:
        _fail(path, "contains an unsupported value")
    alternatives = rule.get("oneOf")
    if isinstance(alternatives, list):
        matches = 0
        for raw_option in alternatives:
            try:
                _validate_node(_object(raw_option, path), value, path)
                matches += 1
            except ContractValidationError:
                pass
        if matches != 1:
            _fail(path, "must match exactly one allowed shape")
        return

    expected = rule.get("type")
    if expected == "null":
        if value is not None:
            _fail(path, "must be null")
        return
    if expected == "string":
        if not isinstance(value, str):
            _fail(path, "must be a string")
        minimum_length = rule.get("minLength")
        maximum_length = rule.get("maxLength")
        if isinstance(minimum_length, int) and len(value) < minimum_length:
            _fail(path, f"must contain at least {minimum_length} characters")
        if isinstance(maximum_length, int) and len(value) > maximum_length:
            _fail(path, f"must contain at most {maximum_length} characters")
        pattern = rule.get("pattern")
        if isinstance(pattern, str) and re.fullmatch(pattern, value) is None:
            _fail(path, "does not match the required pattern")
        if rule.get("format") == "date-time":
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                _fail(path, "must be a canonical ISO 8601 UTC timestamp")
            canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if canonical != value:
                _fail(path, "must be a canonical ISO 8601 UTC timestamp")
        if rule.get("format") == "uri" and not urlparse(value).scheme:
            _fail(path, "must be an absolute URI")
        return
    if expected in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            _fail(path, "must be a finite number")
        if not math.isfinite(value):
            _fail(path, "must be a finite number")
        numeric = value
        if expected == "integer" and not isinstance(value, int):
            _fail(path, "must be an integer")
        minimum = rule.get("minimum")
        maximum = rule.get("maximum")
        if isinstance(minimum, (int, float)) and numeric < minimum:
            _fail(path, f"must be at least {minimum}")
        if isinstance(maximum, (int, float)) and numeric > maximum:
            _fail(path, f"must be at most {maximum}")
        return
    if expected == "boolean":
        if not isinstance(value, bool):
            _fail(path, "must be a boolean")
        return
    if expected == "array":
        if not isinstance(value, list):
            _fail(path, "must be an array")
        items = value
        minimum_items = rule.get("minItems")
        maximum_items = rule.get("maxItems")
        if isinstance(minimum_items, int) and len(items) < minimum_items:
            _fail(path, f"must contain at least {minimum_items} items")
        if isinstance(maximum_items, int) and len(items) > maximum_items:
            _fail(path, f"must contain at most {maximum_items} items")
        prefix_items = rule.get("prefixItems")
        item_rule = rule.get("items")
        for index, item in enumerate(items):
            selected: JsonValue = item_rule
            if isinstance(prefix_items, list) and index < len(prefix_items):
                selected = prefix_items[index]
            if selected is not None:
                _validate_node(_object(selected, path), item, f"{path}[{index}]")
        return
    if expected == "object":
        record = _object(value, path)
        required = rule.get("required")
        if isinstance(required, list):
            for field in required:
                if isinstance(field, str) and field not in record:
                    _fail(f"{path}.{field}", "is required")
        properties = _object(rule.get("properties", {}), path)
        if rule.get("additionalProperties") is False:
            for field in record:
                if field not in properties:
                    _fail(f"{path}.{field}", "is not an allowed property")
        for field, property_rule in properties.items():
            if field in record:
                _validate_node(
                    _object(property_rule, path), record[field], f"{path}.{field}"
                )


def _rings(geometry: JsonObject) -> list[list[JsonValue]]:
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list):
        return []
    if geometry.get("type") == "Polygon":
        return cast(list[list[JsonValue]], coordinates)
    polygons = cast(list[list[list[JsonValue]]], coordinates)
    return [ring for polygon in polygons for ring in polygon]


def _validate_geometry(geometry: JsonObject) -> None:
    for ring in _rings(geometry):
        if ring[0] != ring[-1]:
            _fail("$.geometry", "GeoJSON linear rings must be closed")


def _validate_job(value: JsonObject) -> None:
    state = value.get("state")
    if not isinstance(state, str):
        return
    state_timestamp = f"{state}_at"
    if value.get(state_timestamp) is None:
        _fail(f"$.{state_timestamp}", "is required for the current state")
    previous: datetime | None = None
    for field in (
        "discovered_at",
        "queued_at",
        "preprocessing_at",
        "inferencing_at",
        "ready_for_review_at",
    ):
        raw_timestamp = value.get(field)
        if not isinstance(raw_timestamp, str):
            continue
        current = datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00"))
        if previous is not None and current < previous:
            _fail(f"$.{field}", "transition timestamps must be monotonic")
        previous = current
    prerequisites = {
        "queued": ["queued_at"],
        "preprocessing": ["queued_at", "preprocessing_at"],
        "inferencing": ["queued_at", "preprocessing_at", "inferencing_at"],
        "ready_for_review": [
            "queued_at",
            "preprocessing_at",
            "inferencing_at",
            "ready_for_review_at",
        ],
    }
    for field in prerequisites.get(state, []):
        if value.get(field) is None:
            _fail(f"$.{field}", f"is required in {state} state")
    if state == "failed":
        if value.get("failure") is None:
            _fail("$.failure", "is required in failed state")
    elif value.get("failure") is not None or value.get("failed_at") is not None:
        _fail("$.failure", "is only allowed in failed state")


_ASSET_MEDIA_TYPES = {
    "context_webp": "image/webp",
    "detail_webp": "image/webp",
    "probability_cog": "image/tiff; application=geotiff",
    "mask_cog": "image/tiff; application=geotiff",
    "report_json": "application/json",
}


def validate_contract(model_name: str, value: JsonValue) -> None:
    """Validate a payload against its canonical schema and semantic rules."""

    definition = _object(
        _object(_SCHEMA.get("$defs"), "$defs").get(model_name), model_name
    )
    _validate_node(definition, value, "$")
    record = _object(value, "$")
    if model_name == "AOI":
        _validate_geometry(_object(record.get("geometry"), "$.geometry"))
    elif model_name == "Scene":
        _validate_geometry(_object(record.get("footprint"), "$.footprint"))
    elif model_name == "Candidate":
        _validate_geometry(_object(record.get("geometry"), "$.geometry"))
    elif model_name == "ProcessingJob":
        _validate_job(record)
    elif model_name == "CandidateAsset":
        if _ASSET_MEDIA_TYPES.get(str(record.get("asset_type"))) != record.get(
            "media_type"
        ):
            _fail("$.media_type", "does not match the versioned asset layout")
    elif model_name == "AlertDelivery":
        delivered = record.get("state") == "delivered"
        if delivered != (record.get("delivered_at") is not None):
            _fail("$.delivered_at", "must be set exactly when delivery is complete")
