"""Remote CLI sign-in pages for prospectus.anth.us: ``/cli/discovery``, ``/cli/approve`` and ``/cli/callback``.

One Lambda behind the CRM's HTTP API serves cli-login's own ``ApprovalPages`` (the CSRF cookie, the code-matches
confirmation and the state check live there) and invokes the broker's private operations directly with IAM.

Each CLI login is enrolled like a browser sign-in. On Approve the page asks the CRM accounts BFF's public
login-challenge route for a signed challenge bound to ``sha256hex(T)``, the transaction. The challenge nonce becomes
the Google sign-in's nonce and the signed challenge token is the opaque ``enrollment`` string the broker hands to
the polling CLI. The CLI then posts its tokens, the challenge token and ``loginState = T`` to the BFF's
``/api/saas/identity/resolve``, where central Accounts checks the MAC, nonce, login window, binding and state. The
pages hold no secret and have no access to the accounts service beyond that public route.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from urllib.parse import parse_qsl, urlsplit

from cli_login.broker.pages import ApprovalPages, Page

PROTOCOL_VERSION = 1
KANBUS_API_PATH = "/cyclotron/prospectus/api"
ACCOUNTS_PATH = "/api/saas"
PRIVILEGES = "read and change the Prospectus CRM boards you can open in the browser, as you"
CHALLENGE_SECONDS = 300
UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
NONCE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
CHALLENGE_TOKEN = re.compile(r"^v1\.[a-z0-9]{1,16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$")
ENVIRONMENT = {
    "broker_arn": "CLI_BROKER_ARN",
    "broker_endpoint": "CLI_BROKER_ENDPOINT",
    "public_origin": "CLI_PUBLIC_ORIGIN",
    "issuer": "CLI_ISSUER",
    "client_id": "CLI_CLIENT_ID",
    "oauth_domain": "CLI_OAUTH_DOMAIN",
    "api_url": "CLI_API_URL",
}


class Unavailable(Exception):
    """The accounts service could not issue a usable challenge; nothing is bound."""


def _origin(value: str, name: str) -> str:
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.netloc or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError(f"{name} must be an https origin")
    return f"https://{parts.netloc}"


@dataclass(frozen=True)
class PagesConfig:
    broker_arn: str
    broker_endpoint: str
    public_origin: str
    issuer: str
    client_id: str
    oauth_domain: str
    api_url: str

    def __post_init__(self):
        if not self.broker_arn.startswith("arn:aws:lambda:") or not self.client_id:
            raise ValueError("the pages need the broker function ARN and the CRM client id")
        for name in ("broker_endpoint", "public_origin", "oauth_domain", "api_url"):
            object.__setattr__(self, name, _origin(getattr(self, name), name))
        if not self.issuer.startswith("https://cognito-idp."):
            raise ValueError("the issuer must be the CRM Cognito pool")

    @classmethod
    def from_environment(cls, environ: Mapping[str, str]) -> PagesConfig | None:
        """``None`` when remote sign-in is not configured; every route then answers 503."""
        values = {field: environ.get(variable, "") for field, variable in ENVIRONMENT.items()}
        if not any(values.values()):
            return None
        return cls(**values)

    def environment(self) -> dict[str, str]:
        return {ENVIRONMENT[field]: value for field, value in asdict(self).items()}

    def discovery(self) -> dict:
        accounts = self.api_url + ACCOUNTS_PATH
        return {
            "protocol": PROTOCOL_VERSION,
            "issuer": self.issuer,
            "client_id": self.client_id,
            "oauth_domain": self.oauth_domain,
            "token_endpoint": self.oauth_domain + "/oauth2/token",
            # The broker's target: what the person is shown and what the CLI is bound to.
            "api_endpoint": self.public_origin,
            "kanbus_api_endpoint": self.api_url + KANBUS_API_PATH,
            "accounts_endpoint": accounts,
            "remote_login_endpoint": self.broker_endpoint,
            "remote_callback_uri": self.public_origin + "/cli/callback",
            "enrollment_endpoint": accounts + "/identity/resolve",
        }


def _post_json(url: str, headers: Mapping[str, str], body: str) -> tuple[int, object]:  # pragma: no cover - network
    request = urllib.request.Request(url, data=body.encode(), headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read(65536) or b"null")
    except urllib.error.HTTPError as error:
        return error.code, None


class LoginChallenges:
    """Asks the CRM accounts BFF for a signed login challenge bound to one CLI transaction."""

    def __init__(self, config: PagesConfig, post: Callable[[str, Mapping[str, str], str], tuple[int, object]] = _post_json,
                 *, clock=time.time):
        self.config, self.post, self.clock = config, post, clock

    def prepare(self, transaction: str, described: Mapping) -> tuple[str, str]:
        """``ApprovalPages(prepare=...)``: the OpenID nonce for the sign-in, and the signed challenge as enrollment."""
        digest = hashlib.sha256(transaction.encode()).hexdigest()
        try:
            status, answer = self.post(
                self.config.api_url + ACCOUNTS_PATH + "/identity/login-challenge",
                # The BFF admits only the CRM's own origin; the pages are that origin.
                {"Content-Type": "application/json", "Origin": self.config.public_origin},
                json.dumps({"loginStateDigest": digest}),
            )
        except Exception:  # noqa: BLE001 - any transport failure is the same outage to the person
            raise Unavailable("the login challenge could not be requested") from None
        now = self.clock()
        if (
            status != 200
            or not isinstance(answer, dict)
            or not isinstance(answer.get("challengeId"), str)
            or not UUID4.match(answer["challengeId"])
            or not isinstance(answer.get("nonce"), str)
            or not NONCE.match(answer["nonce"])
            or type(answer.get("expiresAt")) is not int
            or not now < answer["expiresAt"] <= now + CHALLENGE_SECONDS
            # Only a signed challenge carries the transaction binding to the CLI; a stored one would not.
            or not isinstance(answer.get("challengeToken"), str)
            or not CHALLENGE_TOKEN.match(answer["challengeToken"])
        ):
            raise Unavailable("the accounts service answered no usable login challenge")
        return answer["nonce"], answer["challengeToken"]


def lambda_invoker(client, function_arn: str) -> Callable[[dict], Mapping]:
    """Invoke the broker's private operations directly; any failure is ``unavailable`` and says nothing more."""

    def invoke(payload: dict) -> Mapping:
        try:
            answer = client.invoke(FunctionName=function_arn, InvocationType="RequestResponse",
                                   Payload=json.dumps(payload).encode())
            if answer.get("FunctionError"):
                return {"ok": False, "error": "unavailable"}
            result = json.loads(answer["Payload"].read())
            return result if isinstance(result, dict) else {"ok": False, "error": "unavailable"}
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "unavailable"}

    return invoke


def _response(page: Page) -> dict:
    # HTTP API payload 2.0: several Set-Cookie headers go in ``cookies``, never folded into one header.
    headers, cookies = {}, []
    for name, value in page.headers:
        if name.lower() == "set-cookie":
            cookies.append(value)
        else:
            headers[name] = value
    return {"statusCode": page.status, "headers": headers, "cookies": cookies, "body": page.body}


def _json(status: int, body: object) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        "body": json.dumps(body),
    }


def _cookies(event: Mapping) -> dict[str, str]:
    jar = {}
    for line in event.get("cookies") or []:
        name, _, value = line.partition("=")
        jar.setdefault(name.strip(), value.strip())
    return jar


def _form(event: Mapping) -> dict[str, str]:
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8", "replace")
    return dict(parse_qsl(body[:8192]))


def handle(event: Mapping, config: PagesConfig | None, invoke: Callable[[dict], Mapping],
           challenges: LoginChallenges | None) -> dict:
    if config is None or challenges is None:
        return _json(503, {"error": "remote_sign_in_unavailable"})
    path = event.get("rawPath", "")
    method = ((event.get("requestContext") or {}).get("http") or {}).get("method", "")
    query = event.get("queryStringParameters") or {}
    if path == "/cli/discovery":
        return _json(200, config.discovery()) if method == "GET" else _json(405, {"error": "method_not_allowed"})
    pages = ApprovalPages(
        invoke,
        authorize_endpoint=config.oauth_domain + "/oauth2/authorize",
        product="Prospectus",
        privileges=PRIVILEGES,
        identity_provider="Google",
        prepare=challenges.prepare,
    )
    if path == "/cli/approve":
        if method not in ("GET", "POST"):
            return _json(405, {"error": "method_not_allowed"})
        return _response(pages.approve(method, query, _form(event) if method == "POST" else {}, _cookies(event)))
    if path == "/cli/callback":
        return _response(pages.callback(query, _cookies(event))) if method == "GET" else _json(405, {"error": "method_not_allowed"})
    return _json(404, {"error": "not_found"})


_config: PagesConfig | None = None
_invoke: Callable[[dict], Mapping] | None = None


def lambda_handler(event, context):  # pragma: no cover - wiring only; ``handle`` is specified directly
    global _config, _invoke
    if _invoke is None:
        import os

        _config = PagesConfig.from_environment(os.environ)
        if _config:
            import boto3

            _invoke = lambda_invoker(boto3.client("lambda"), _config.broker_arn)
        else:
            _invoke = lambda payload: {"ok": False, "error": "unavailable"}
    return handle(event, _config, _invoke, LoginChallenges(_config) if _config else None)
