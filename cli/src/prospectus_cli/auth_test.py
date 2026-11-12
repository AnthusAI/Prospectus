"""Specs for signing the prospectus command in (features/prospectus-cli.feature, "Signing in"). No network."""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from cli_login.errors import AuthError

from . import auth
from .cli_test import DISCOVERY, Response

DOCUMENT = {
    "protocol": 1,
    "issuer": DISCOVERY.issuer,
    "client_id": DISCOVERY.client_id,
    "oauth_domain": DISCOVERY.oauth_domain,
    "token_endpoint": DISCOVERY.token_endpoint,
    "api_endpoint": DISCOVERY.api_endpoint,
    "accounts_endpoint": DISCOVERY.accounts_endpoint + "/",
    "enrollment_endpoint": DISCOVERY.enrollment_endpoint,
    "remote_login_endpoint": DISCOVERY.remote_login_endpoint,
    "remote_callback_uri": DISCOVERY.remote_callback_uri,
}
TOKENS = {"access_token": "access", "id_token": "identity", "refresh_token": "refresh"}


class Opener:
    def __init__(self, answer=None, status=None, error=None):
        self.answer, self.status, self.error = answer, status, error
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        if self.status:
            raise urllib.error.HTTPError(request.full_url, self.status, "no", {}, io.BytesIO(json.dumps(self.error or {}).encode()))
        return Response(self.answer)


def test_discovery_reads_the_sites_document():
    opener = Opener(DOCUMENT)
    discovery = auth.discover("https://prospectus.anth.us/", opener=opener)
    assert opener.requests[0].full_url == "https://prospectus.anth.us/cli/discovery"
    assert discovery == DISCOVERY
    target = discovery.target()
    assert target.key == "prospectus.anth.us" and target.namespace == "prospectus"
    assert target.broker_endpoint == DISCOVERY.remote_login_endpoint


def test_a_site_without_cli_sign_in_says_so():
    with pytest.raises(AuthError, match="did not publish its CLI sign-in"):
        auth.discover("https://prospectus.anth.us", opener=Opener(status=404))
    with pytest.raises(AuthError, match="does not understand"):
        auth.discover("https://prospectus.anth.us", opener=Opener({"protocol": 2}))


def test_enrollment_posts_the_tokens_and_challenge_to_accounts():
    opener = Opener({"person": {"id": "person-1"}})
    auth.enroll(DISCOVERY, TOKENS, "T.N", "v1.challenge", opener=opener)
    [request] = opener.requests
    assert request.full_url == DISCOVERY.enrollment_endpoint and request.get_method() == "POST"
    assert json.loads(request.data) == {"challengeToken": "v1.challenge", "idToken": "identity", "loginState": "T.N"}
    assert request.get_header("Authorization") == "Bearer access"
    assert request.get_header("Origin") == "https://prospectus.anth.us"
    assert "refresh" not in request.data.decode()


def test_a_login_without_a_challenge_cannot_be_enrolled():
    opener = Opener({})
    with pytest.raises(AuthError, match="could not be enrolled"):
        auth.enroll(DISCOVERY, TOKENS, "T.N", None, opener=opener)
    assert opener.requests == []


def test_a_refused_enrollment_says_why():
    with pytest.raises(AuthError, match=r"\(challenge_replay\): this sign-in was already used\. Nothing was saved\."):
        auth.enroll(DISCOVERY, TOKENS, "T.N", "v1.c", opener=Opener(status=401, error={"error": "challenge_replay"}))
    with pytest.raises(AuthError, match=r"\(unavailable\)"):
        auth.enroll(DISCOVERY, TOKENS, "T.N", "v1.c", opener=Opener(status=502, error={"error": "<script>"}))


class MemoryStore:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value):
        self.values[key] = value

    def delete(self, key):
        self.values.pop(key, None)


def test_login_enrolls_before_anything_is_stored(monkeypatch):
    calls = {}

    def fake_remote_login(target, store_token_set, *, enroll, out, note, expected_email):
        calls.update(target=target, note=note, expected_email=expected_email)
        out("To approve this sign-in, open https://prospectus.anth.us/cli/approve?t=x and check the code BCDF-GHJK.")
        enroll(TOKENS, "T.N", "v1.challenge")
        return {"subject": "sub", "label": "ryan@example.com"}

    monkeypatch.setattr(auth, "remote_login", fake_remote_login)
    opener = Opener({"person": {"id": "person-1"}})
    session = auth.ProspectusSession(DISCOVERY, store=MemoryStore(), opener=opener)
    printed = []
    result = session.login(expected_email="ryan@example.com", note="billing agent", out=printed.append)
    assert result == {"subject": "sub", "label": "ryan@example.com"}
    assert calls["expected_email"] == "ryan@example.com" and calls["note"] == "billing agent"
    assert calls["target"].api_endpoint == "https://prospectus.anth.us"
    assert [request.full_url for request in opener.requests] == [DISCOVERY.enrollment_endpoint]
    assert "cli/approve" in printed[0]


def test_a_failed_enrollment_fails_the_login(monkeypatch):
    def fake_remote_login(target, store_token_set, *, enroll, **options):
        enroll(TOKENS, "T.N", "v1.challenge")
        store_token_set({"never": "reached"})

    monkeypatch.setattr(auth, "remote_login", fake_remote_login)
    store = MemoryStore()
    session = auth.ProspectusSession(DISCOVERY, store=store, opener=Opener(status=401, error={"error": "login_state"}))
    with pytest.raises(AuthError, match="login_state"):
        session.login()
    assert store.values == {}


def test_signed_out_status_and_headers():
    session = auth.ProspectusSession(DISCOVERY, store=MemoryStore())
    assert session.status() == {"signed_in": False, "site": "https://prospectus.anth.us"}
    with pytest.raises(AuthError):
        session.headers()
