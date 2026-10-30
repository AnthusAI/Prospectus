"""The remote CLI sign-in pages on prospectus.anth.us, against an in-process cli-login broker (no AWS, no network)."""

import base64
import hashlib
import json
import uuid
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from cli_login.broker import handler as broker_handler
from cli_login.broker import transactions

from .pages import LoginChallenges, PagesConfig, Unavailable, handle, lambda_invoker

ORIGIN = "https://prospectus.example.test"
API = "https://api.example.test"
AUTH = "https://synthetic.auth.us-east-1.amazoncognito.com"
ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_synthetic"
BROKER_ARN = "arn:aws:lambda:us-east-1:123456789012:function:prospectus-cli-broker"
BROKER_URL = "https://broker.lambda-url.us-east-1.on.aws"
CHALLENGE_TOKEN = "v1.k1." + "p" * 40 + "." + "m" * 43
NONCE = "N" * 43
CHALLENGE_ID = str(uuid.uuid4())  # synthetic, made per run

CONFIG = PagesConfig(
    broker_arn=BROKER_ARN,
    broker_endpoint=BROKER_URL,
    public_origin=ORIGIN,
    issuer=ISSUER,
    client_id="crm-client",
    oauth_domain=AUTH,
    api_url=API,
)


class FakeAccounts:
    """The CRM accounts BFF's public login-challenge route."""

    def __init__(self, status=200, answer=None):
        self.calls = []
        self.status = status
        self.answer = answer if answer is not None else {
            "challengeId": CHALLENGE_ID,
            "nonce": NONCE,
            "expiresAt": 2_000_000_300,
            "challengeToken": CHALLENGE_TOKEN,
        }

    def __call__(self, url, headers, body):
        self.calls.append((url, headers, json.loads(body)))
        return self.status, self.answer


@pytest.fixture
def broker():
    return broker_handler.Broker(
        transactions.MemoryTransactions(),
        broker_handler.BrokerConfig("crm-client", (ORIGIN,), ORIGIN + "/cli/approve", ORIGIN + "/cli/callback"),
    )


def pages(broker, accounts=None):
    accounts = accounts or FakeAccounts()
    challenges = LoginChallenges(CONFIG, accounts, clock=lambda: 2_000_000_000)
    return (lambda event: handle(event, CONFIG, broker.handle, challenges)), accounts


def start(broker):
    _, answer = broker.start(
        {
            "protocol": 1,
            "client_id": "crm-client",
            "target": ORIGIN,
            "code_challenge": "c" * 43,
            "code_challenge_method": "S256",
            "poll_secret_hash": broker_handler.sha256_hex("p"),
            "nonce": "n" * 16,
            "requester": {"host": "cloud-box", "version": "0.3.0", "note": "nightly agent"},
        },
        "198.51.100.1",
    )
    return answer["transaction"]


def event(method, path, *, query=None, form=None, cookies=None, encode=False):
    body = urlencode(form) if form is not None else None
    if body is not None and encode:
        body = base64.b64encode(body.encode()).decode()
    return {
        "version": "2.0",
        "rawPath": path,
        "rawQueryString": urlencode(query or {}),
        "queryStringParameters": query,
        "cookies": [f"{name}={value}" for name, value in (cookies or {}).items()] or None,
        "headers": {"content-type": "application/x-www-form-urlencoded"} if form is not None else {},
        "body": body,
        "isBase64Encoded": encode,
        "requestContext": {"http": {"method": method, "path": path}},
    }


def cookie_jar(response):
    jar = {}
    for line in response.get("cookies", []):
        name, _, rest = line.partition("=")
        jar[name] = rest.split(";", 1)[0]
    return jar


def approve(serve, transaction):
    shown = serve(event("GET", "/cli/approve", query={"t": transaction}))
    csrf = cookie_jar(shown)["__Secure-cli_login_csrf"]
    return serve(event(
        "POST", "/cli/approve",
        form={"t": transaction, "csrf": csrf, "action": "approve", "confirm": "yes"},
        cookies={"__Secure-cli_login_csrf": csrf},
        encode=True,
    ))


def test_discovery_names_the_crm_client_the_broker_and_the_enrollment_route(broker):
    serve, _ = pages(broker)
    answer = serve(event("GET", "/cli/discovery"))
    assert answer["statusCode"] == 200
    assert answer["headers"]["Cache-Control"] == "no-store"
    assert json.loads(answer["body"]) == {
        "protocol": 1,
        "issuer": ISSUER,
        "client_id": "crm-client",
        "oauth_domain": AUTH,
        "token_endpoint": AUTH + "/oauth2/token",
        "api_endpoint": ORIGIN,
        "kanbus_api_endpoint": API + "/cyclotron/prospectus/api",
        "accounts_endpoint": API + "/api/saas",
        "remote_login_endpoint": BROKER_URL,
        "remote_callback_uri": ORIGIN + "/cli/callback",
        "enrollment_endpoint": API + "/api/saas/identity/resolve",
    }


def test_the_approval_page_shows_the_code_and_binds_nothing(broker):
    serve, accounts = pages(broker)
    transaction = start(broker)
    shown = serve(event("GET", "/cli/approve", query={"t": transaction}))
    assert shown["statusCode"] == 200
    assert broker.describe({"transaction": transaction})["matching_code"] in shown["body"]
    assert "cloud-box" in shown["body"] and "nightly agent" in shown["body"]
    assert "Approve" in shown["body"] and "Deny" in shown["body"]
    assert "frame-ancestors 'none'" in shown["headers"]["Content-Security-Policy"]
    assert "__Secure-cli_login_csrf" in cookie_jar(shown)
    assert accounts.calls == []
    assert broker.describe({"transaction": transaction})["ok"] is True


def test_approving_binds_a_login_challenge_for_this_transaction(broker):
    serve, accounts = pages(broker)
    transaction = start(broker)
    answer = approve(serve, transaction)
    assert answer["statusCode"] == 303
    [(url, headers, body)] = accounts.calls
    assert url == API + "/api/saas/identity/login-challenge"
    assert headers["Origin"] == ORIGIN
    assert body == {"loginStateDigest": hashlib.sha256(transaction.encode()).hexdigest()}
    location = urlsplit(answer["headers"]["Location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == AUTH + "/oauth2/authorize"
    query = {key: values[0] for key, values in parse_qs(location.query).items()}
    assert query["nonce"] == NONCE
    assert query["client_id"] == "crm-client"
    assert query["redirect_uri"] == ORIGIN + "/cli/callback"
    assert query["identity_provider"] == "Google"
    assert query["code_challenge"] == "c" * 43
    assert query["state"].startswith(transaction + ".")
    # Bound: nobody else can approve this transaction now.
    assert broker.describe({"transaction": transaction})["ok"] is False


@pytest.mark.parametrize("status,answer", [
    (503, {"error": "unavailable"}),
    (429, {"message": "Too Many Requests"}),
    (200, {"challengeId": CHALLENGE_ID, "nonce": NONCE, "expiresAt": 2_000_000_300}),  # unsigned: refused
    (200, {"challengeId": "not-a-uuid", "nonce": NONCE, "expiresAt": 2_000_000_300, "challengeToken": CHALLENGE_TOKEN}),
    (200, {"challengeId": CHALLENGE_ID, "nonce": "short", "expiresAt": 2_000_000_300, "challengeToken": CHALLENGE_TOKEN}),
    (200, {"challengeId": CHALLENGE_ID, "nonce": NONCE, "expiresAt": 1_999_999_999, "challengeToken": CHALLENGE_TOKEN}),
    (200, {"challengeId": CHALLENGE_ID, "nonce": NONCE, "expiresAt": 2_000_000_300, "challengeToken": "forged"}),
])
def test_an_unusable_challenge_binds_nothing(broker, status, answer):
    serve, _ = pages(broker, FakeAccounts(status, answer))
    transaction = start(broker)
    response = approve(serve, transaction)
    assert response["statusCode"] == 503
    assert "unavailable" in response["body"]
    assert broker.describe({"transaction": transaction})["ok"] is True


def test_the_callback_completes_and_the_cli_collects_the_code_nonce_and_enrollment(broker):
    serve, _ = pages(broker)
    transaction = start(broker)
    redirect = approve(serve, transaction)
    nonce_cookie = cookie_jar(redirect)["__Secure-cli_login_nonce"]
    state = parse_qs(urlsplit(redirect["headers"]["Location"]).query)["state"][0]
    done = serve(event("GET", "/cli/callback", query={"state": state, "code": "auth-code"},
                       cookies={"__Secure-cli_login_nonce": nonce_cookie}))
    assert done["statusCode"] == 200
    assert "approved" in done["body"]
    status, collected = broker.poll({"transaction": transaction, "poll_secret": "p"}, "198.51.100.1")
    assert status == 200
    assert collected["code"] == "auth-code"
    assert collected["nonce"] == NONCE
    assert collected["enrollment"] == CHALLENGE_TOKEN


def test_a_callback_from_another_browser_completes_nothing(broker):
    serve, _ = pages(broker)
    transaction = start(broker)
    redirect = approve(serve, transaction)
    state = parse_qs(urlsplit(redirect["headers"]["Location"]).query)["state"][0]
    answer = serve(event("GET", "/cli/callback", query={"state": state, "code": "auth-code"},
                         cookies={"__Secure-cli_login_nonce": "someone-else"}))
    assert answer["statusCode"] == 400
    status, _ = broker.poll({"transaction": transaction, "poll_secret": "p"}, "198.51.100.1")
    assert status == 400


def test_deny_is_recorded_for_the_waiting_cli(broker):
    serve, accounts = pages(broker)
    transaction = start(broker)
    shown = serve(event("GET", "/cli/approve", query={"t": transaction}))
    csrf = cookie_jar(shown)["__Secure-cli_login_csrf"]
    answer = serve(event("POST", "/cli/approve", form={"t": transaction, "csrf": csrf, "action": "deny"},
                         cookies={"__Secure-cli_login_csrf": csrf}))
    assert answer["statusCode"] == 200
    assert accounts.calls == []
    _, polled = broker.poll({"transaction": transaction, "poll_secret": "p"}, "198.51.100.1")
    assert polled["error"] == "access_denied"


@pytest.mark.parametrize("method,path,status", [
    ("GET", "/cli/enroll", 404),
    ("GET", "/cli/", 404),
    ("GET", "/api/saas/accounts", 404),
    ("DELETE", "/cli/approve", 405),
    ("POST", "/cli/discovery", 405),
    ("POST", "/cli/callback", 405),
])
def test_only_the_three_pages_are_served(broker, method, path, status):
    serve, _ = pages(broker)
    assert serve(event(method, path))["statusCode"] == status


def test_an_unconfigured_deployment_serves_nothing(broker):
    answer = handle(event("GET", "/cli/discovery"), None, broker.handle, None)
    assert answer["statusCode"] == 503
    assert PagesConfig.from_environment({}) is None


def test_configuration_requires_https_everywhere():
    with pytest.raises(ValueError):
        PagesConfig.from_environment({**CONFIG.environment(), "CLI_PUBLIC_ORIGIN": "http://prospectus.example.test"})
    assert PagesConfig.from_environment(CONFIG.environment()) == CONFIG


class FakeLambda:
    def __init__(self, payload, error=None):
        self.payload, self.error, self.calls = payload, error, []

    def invoke(self, **arguments):
        self.calls.append(arguments)

        class Body:
            def read(inner):
                return json.dumps(self.payload).encode()

        answer = {"StatusCode": 200, "Payload": Body()}
        if self.error:
            answer["FunctionError"] = self.error
        return answer


def test_the_broker_is_invoked_directly_and_a_failure_answers_unavailable():
    client = FakeLambda({"ok": True, "matching_code": "BCDF-GHJK"})
    invoke = lambda_invoker(client, BROKER_ARN)
    assert invoke({"operation": "describe", "transaction": "t"}) == {"ok": True, "matching_code": "BCDF-GHJK"}
    assert client.calls[0]["FunctionName"] == BROKER_ARN
    assert client.calls[0]["InvocationType"] == "RequestResponse"
    assert lambda_invoker(FakeLambda({"errorMessage": "boom"}, error="Unhandled"), BROKER_ARN)({"operation": "describe"}) == {
        "ok": False,
        "error": "unavailable",
    }


def test_challenge_errors_name_no_service_detail():
    challenges = LoginChallenges(CONFIG, FakeAccounts(500, {"error": "internal detail"}), clock=lambda: 2_000_000_000)
    with pytest.raises(Unavailable) as raised:
        challenges.prepare("T" * 22, {})
    assert "internal detail" not in str(raised.value)
