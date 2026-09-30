"""Cross-runtime contract fixtures for the generated Python consumer."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import cast

import pytest

PYTHON_MODELS = Path("packages/schemas/python").resolve()
sys.path.insert(0, str(PYTHON_MODELS))

from oilspill_contracts import ContractValidationError, validate_contract  # noqa: E402

JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]


def _fixture(name: str) -> JsonValue:
    path = Path("data/fixtures/contracts") / name
    return cast(JsonValue, json.loads(path.read_text(encoding="utf-8")))


def test_representative_payloads_validate() -> None:
    valid = cast(dict[str, JsonValue], _fixture("valid.json"))
    for model_name, payload in valid.items():
        validate_contract(model_name, payload)


def test_invalid_payloads_are_rejected() -> None:
    fixtures = cast(list[dict[str, JsonValue]], _fixture("invalid.json"))
    for fixture in fixtures:
        model_name = fixture["model"]
        if not isinstance(model_name, str):
            pytest.fail("invalid fixture model name")
        with pytest.raises(ContractValidationError, match=r"^\$"):
            validate_contract(model_name, fixture["payload"])
