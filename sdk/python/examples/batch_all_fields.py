import hashlib
import json
import os
from datetime import datetime, timedelta, timezone

from sudo_log import SudoworkLogClient


def required_env(name):
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def iso(offset_seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


def sha256(value):
    return hashlib.sha256(str(value).strip().encode("utf-8")).hexdigest()


TENANT_ID = required_env("SUDO_LOG_TENANT_ID")
PRODUCT = required_env("SUDO_LOG_PRODUCT")
ENVIRONMENT = os.getenv("SUDO_LOG_ENVIRONMENT", "production")

client = SudoworkLogClient(
    base_url=required_env("SUDO_LOG_BASE_URL"),
    api_key=required_env("SUDO_LOG_API_KEY"),
    tenant_id=TENANT_ID,
    product=PRODUCT,
    environment=ENVIRONMENT,
    default_tags={
        "sdk": "python",
        "source": "sdk-example",
    },
    default_attributes={
        "sdk_language": "python",
        "example": "batch-all-fields",
    },
)

logs = [
    {
        "timestamp": iso(),
        "tenant_id": TENANT_ID,
        "product": PRODUCT,
        "topic": "error",
        "environment": ENVIRONMENT,
        "level": "error",
        "component": "PythonSdkExample",
        "version": "1.2.3-python",
        "platform": "linux",
        "arch": "x86_64",
        "login_mode": "sso",
        "user_identifier": "python-user@example.invalid",
        "user_identifier_hash": sha256("python-user@example.invalid"),
        "user_id": "python-user-001",
        "user_id_hash": sha256("python-user-001"),
        "device_id": "python-device-001",
        "device_id_hash": sha256("python-device-001"),
        "session_id": "python-session-001",
        "conversation_id": "python-conversation-001",
        "trace_id": "python-trace-001",
        "message": "python sdk example log covers all batch fields",
        "error": {
            "name": "PythonExampleError",
            "message": "fake python sdk error",
            "stack": "PythonExampleError: fake python sdk error\n    at run_example (/app/src/python_example.py:10)",
        },
        "error_name": "PythonExampleFallbackError",
        "error_message": "fake python fallback error message",
        "stack_trace": "PythonExampleFallbackError: fake fallback stack\n    at fallback (/app/src/python_example.py:20)",
        "tags": {
            "feature": "sdk-example",
            "provider": "fake-provider",
            "plan": "enterprise",
            "scenario": "all-fields",
        },
        "attributes": {
            "route": "/sdk/python/example",
            "http_status": 503,
            "retryable": True,
            "order_id": "fake-python-order-001",
            "payload_shape": {"covered": True, "language": "python"},
        },
    },
    {
        "timestamp": iso(-1),
        "topic": "error",
        "level": "error",
        "component": "PythonSdkExample",
        "user_identifier": "python-secondary-user@example.invalid",
        "message": "python sdk secondary error example log",
        "error": {
            "name": "PythonSecondaryExampleError",
            "message": "fake secondary python sdk error",
            "stack": "PythonSecondaryExampleError: fake secondary python sdk error\n    at secondary (/app/src/python_example.py:30)",
        },
        "tags": {
            "feature": "sdk-example",
            "scenario": "secondary-error",
            "provider": "fake-provider",
        },
        "attributes": {
            "route": "/sdk/python/secondary",
            "http_status": 500,
            "cache_hit": False,
        },
    },
    {
        "timestamp": iso(-2),
        "topic": "error",
        "level": "error",
        "component": "PythonSdkExample",
        "user_identifier": "python-tertiary-user@example.invalid",
        "message": "python sdk tertiary error example log",
        "error": {
            "name": "PythonTertiaryExampleError",
            "message": "fake tertiary python sdk error",
            "stack": "PythonTertiaryExampleError: fake tertiary python sdk error\n    at tertiary (/app/src/python_example.py:40)",
        },
        "tags": {
            "feature": "sdk-example",
            "scenario": "tertiary-error",
            "provider": "fake-provider",
        },
        "attributes": {
            "route": "/sdk/python/tertiary",
            "http_status": 409,
            "warning_code": "fake-conflict",
        },
    },
]

response = client.send_batch(logs)
print(json.dumps({"language": "python", "response": response}, indent=2))
