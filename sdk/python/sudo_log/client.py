from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, MutableMapping, Sequence, TypedDict

DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_MAX_RETRIES = 2
MAX_BATCH_SIZE = 50


class LogEvent(TypedDict, total=False):
    timestamp: str | int | float
    tenant_id: str
    product: str
    topic: str
    environment: str
    level: str
    component: str
    version: str
    platform: str
    arch: str
    login_mode: str
    user_identifier: str
    user_identifier_hash: str
    user_id: str
    user_id_hash: str
    device_id: str
    device_id_hash: str
    session_id: str
    conversation_id: str
    trace_id: str
    message: str
    error: Mapping[str, Any]
    error_name: str
    error_message: str
    stack_trace: str
    tags: Mapping[str, str | int | float | bool]
    attributes: Mapping[str, Any]


class BatchResponse(TypedDict, total=False):
    success: bool
    accepted: bool
    received: int
    event_ids: list[str]
    error: str


@dataclass
class SudoworkLogError(Exception):
    message: str
    status: int = 0
    body: Any = None

    def __str__(self) -> str:
        return self.message


def _normalize_base_url(base_url: str) -> str:
    return str(base_url or "").rstrip("/")


def _merge_mapping(left: Mapping[str, Any] | None = None, right: Mapping[str, Any] | None = None) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    if isinstance(left, Mapping):
        merged.update(left)
    if isinstance(right, Mapping):
        merged.update(right)
    return merged


def _is_retryable_status(status: int) -> bool:
    return 500 <= status <= 599


class SudoworkLogClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        tenant_id: str,
        product: str,
        environment: str = "production",
        api_key_header: str = "X-API-Key",
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_tags: Mapping[str, str | int | float | bool] | None = None,
        default_attributes: Mapping[str, Any] | None = None,
    ) -> None:
        self.base_url = _normalize_base_url(base_url)
        self.api_key = api_key
        self.tenant_id = tenant_id
        self.product = product
        self.environment = environment
        self.api_key_header = api_key_header
        self.timeout = timeout
        self.max_retries = max_retries
        self.default_tags = _merge_mapping(default_tags)
        self.default_attributes = _merge_mapping(default_attributes)

        if not self.base_url:
            raise SudoworkLogError("base_url is required")
        if not self.api_key:
            raise SudoworkLogError("api_key is required")
        if not self.tenant_id:
            raise SudoworkLogError("tenant_id is required")
        if not self.product:
            raise SudoworkLogError("product is required")

    def endpoint(self) -> str:
        return f"{self.base_url}/v1/logs/batch"

    def with_defaults(self, log: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(log, Mapping):
            raise SudoworkLogError("log must be a mapping")
        if log.get("tenant_id") and log.get("tenant_id") != self.tenant_id:
            raise SudoworkLogError(f"log tenant_id does not match client tenant_id: {log.get('tenant_id')}")
        if log.get("product") and log.get("product") != self.product:
            raise SudoworkLogError(f"log product does not match client product: {log.get('product')}")

        result: dict[str, Any] = dict(log)
        result["tenant_id"] = self.tenant_id
        result["product"] = self.product
        result["environment"] = result.get("environment") or self.environment
        result["tags"] = _merge_mapping(self.default_tags, result.get("tags"))
        result["attributes"] = _merge_mapping(self.default_attributes, result.get("attributes"))
        return result

    def send_batch(self, logs: Sequence[Mapping[str, Any]], *, timeout: float | None = None, max_retries: int | None = None) -> BatchResponse:
        if not isinstance(logs, Sequence) or isinstance(logs, (str, bytes, bytearray)):
            raise SudoworkLogError("logs must be a sequence")
        if len(logs) == 0:
            raise SudoworkLogError("logs must not be empty")
        if len(logs) > MAX_BATCH_SIZE:
            raise SudoworkLogError(f"logs must contain no more than {MAX_BATCH_SIZE} entries")

        payload = json.dumps({"logs": [self.with_defaults(log) for log in logs]}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint(),
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                self.api_key_header: self.api_key,
            },
        )

        attempts = self.max_retries if max_retries is None else max_retries
        request_timeout = self.timeout if timeout is None else timeout
        last_error: SudoworkLogError | None = None

        for attempt in range(attempts + 1):
            try:
                with urllib.request.urlopen(request, timeout=request_timeout) as response:
                    body = response.read().decode("utf-8")
                    data: MutableMapping[str, Any] = json.loads(body) if body else {}
                    if data.get("success") is False:
                        raise SudoworkLogError(str(data.get("error") or "Sudowork Log request failed"), response.status, data)
                    return data  # type: ignore[return-value]
            except urllib.error.HTTPError as exc:
                body_text = exc.read().decode("utf-8", errors="replace")
                try:
                    body = json.loads(body_text) if body_text else {}
                except json.JSONDecodeError:
                    body = {"raw": body_text}
                error = SudoworkLogError(str(body.get("error") or f"Sudowork Log request failed with {exc.code}"), exc.code, body)
                if _is_retryable_status(exc.code) and attempt < attempts:
                    last_error = error
                    time.sleep(0.2 * (2**attempt))
                    continue
                raise error from exc
            except urllib.error.URLError as exc:
                error = SudoworkLogError("Sudowork Log request failed", body={"reason": str(exc.reason)})
                if attempt < attempts:
                    last_error = error
                    time.sleep(0.2 * (2**attempt))
                    continue
                raise error from exc

        raise last_error or SudoworkLogError("Sudowork Log request failed")

    def log(self, log: Mapping[str, Any], *, timeout: float | None = None, max_retries: int | None = None) -> BatchResponse:
        return self.send_batch([log], timeout=timeout, max_retries=max_retries)
