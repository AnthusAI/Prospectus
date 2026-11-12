"""The operator billing API, as the console calls it: the Accounts BFF's ``/operator/...`` routes with a bearer token.

The server checks ``accounts:admin:billing`` (writes) and ``accounts:admin:read`` (reads) on every call. Every write
carries a client-generated operation ID, so a retried command never records anything twice.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

from .auth import MAX_BYTES, TIMEOUT, default_opener

PDF_MAX_BYTES = 20 * 1024 * 1024


class APIError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


def _message(status: int, value: Any) -> tuple[str, str | None]:
    code = value.get("error") or value.get("code") if isinstance(value, dict) else None
    message = value.get("message") if isinstance(value, dict) else None
    if code == "reenrollment_required":
        return "This session is not enrolled with Prospectus. Run `prospectus login` again.", code
    if isinstance(message, str) and message:
        return message, code if isinstance(code, str) else None
    if status == 401:
        return "Prospectus did not accept this session. Run `prospectus login` again.", code
    if status == 403:
        return "You do not have access to billing.", code
    if status == 409:
        return "Someone changed this record. Look at it again before retrying.", code
    return f"Prospectus answered HTTP {status}. Try again in a moment.", code


class BillingAPI:
    def __init__(self, base: str, headers: Callable[[], dict], *, opener=None, new_id: Callable[[], str] | None = None):
        self.base = base.rstrip("/")
        self.headers = headers
        self.opener = opener or default_opener()
        self.new_id = new_id or (lambda: str(uuid.uuid4()))

    def _send(self, path: str, method: str = "GET", body: Any = None, accept: str = "application/json") -> Any:
        headers = dict(self.headers())
        headers["Accept"] = accept
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        else:
            headers.pop("content-type", None)
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=TIMEOUT) as response:
                limit = PDF_MAX_BYTES if accept == "application/pdf" else MAX_BYTES
                raw = response.read(limit + 1)[:limit]
                kind = response.headers.get("Content-Type", "") if getattr(response, "headers", None) else ""
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read(MAX_BYTES) or b"null")
            except (ValueError, OSError):
                value = None
            message, code = _message(error.code, value)
            raise APIError(error.code, message, code) from None
        except (OSError, ValueError):
            raise APIError(503, "Could not reach Prospectus. Check the connection and try again.") from None
        if accept == "application/pdf" and "json" not in kind:
            return raw
        try:
            return json.loads(raw or b"null")
        except ValueError:
            raise APIError(502, "Prospectus sent an answer this command could not read.") from None

    def _write(self, path: str, body: dict) -> Any:
        return self._send(path, "POST", {"operationId": self.new_id(), **body})

    # Reads
    def access(self) -> list[str]:
        return self._send("/operator/billing/access").get("permissions", [])

    def accounts(self) -> list[dict]:
        return self._send("/operator/billing/accounts")["accounts"]

    def invoices(self, account_id: str | None = None) -> list[dict]:
        if account_id:
            return self._send(f"/operator/accounts/{_part(account_id)}/invoices")["invoices"]
        return self._send("/operator/billing/invoices")["invoices"]

    def invoice(self, reference: str) -> dict:
        return self._send(f"/operator/billing/invoices/{_part(reference)}")

    def invoice_pdf(self, reference: str) -> bytes:
        value = self._send(f"/operator/billing/invoices/{_part(reference)}/pdf", accept="application/pdf")
        if isinstance(value, dict):
            return base64.b64decode(value.get("base64", ""))
        return value

    def payments(self, account_id: str | None = None) -> list[dict]:
        if account_id:
            return self._send(f"/operator/accounts/{_part(account_id)}/payments")["payments"]
        return self._send("/operator/billing/payments")["payments"]

    def payment(self, payment_id: str) -> dict:
        return self._send(f"/operator/billing/payments/{_part(payment_id)}")["payment"]

    def engagements(self, account_id: str | None = None) -> list[dict]:
        if account_id:
            return self._send(f"/operator/accounts/{_part(account_id)}/engagements")["engagements"]
        return self._send("/operator/billing/engagements")["engagements"]

    # Writes
    def record_payment(self, account_id: str, payment: dict) -> dict:
        return self._write(f"/operator/accounts/{_part(account_id)}/payments", {"accountId": account_id, **payment})[
            "payment"
        ]

    def allocate(self, payment_id: str, allocations: list[dict]) -> dict:
        return self._write(f"/operator/billing/payments/{_part(payment_id)}/allocations", {"allocations": allocations})[
            "payment"
        ]

    def write_off(self, invoice_id: str, reason: str, expected_revision: int) -> dict:
        return self._write(
            f"/operator/billing/invoices/{_part(invoice_id)}/write-off",
            {"reason": reason, "expectedRevision": expected_revision},
        )["invoice"]


def _part(value: str) -> str:
    return urllib.parse.quote(value, safe="")
