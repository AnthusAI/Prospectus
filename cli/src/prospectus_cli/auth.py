"""Signing the ``prospectus`` command in: cli-login's remote sign-in, enrolled with Accounts, kept in the secure store.

This follows the Papyrus newsroom CLI (``papyrus login --remote``) and the Cyclotron lab (``cyclotron login``). The
shared ``cli-login`` library owns the OAuth exchange, token checks, renewal, locking, secure storage and logout.
Prospectus adds only what is its own:

- reading ``/cli/discovery`` on the site;
- enrolling each login at the Accounts identity service the way a browser sign-in is enrolled. The approval page
  asks Accounts for a challenge bound to the transaction, and the CLI posts its tokens with that challenge and
  ``loginState = transaction`` to ``identity/resolve``. Until then the operator routes answer
  ``401 reenrollment_required``.

Nothing here prints or stores a token outside the library's secure store.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from cli_login.errors import AuthError, OAuthError  # noqa: F401 (re-exported for the command)
from cli_login.remote import RemoteLoginError, remote_login
from cli_login.session import Session
from cli_login.target import Target

DEFAULT_SITE = "https://prospectus.anth.us"
NAMESPACE = "prospectus"
LOGIN_COMMAND = "prospectus login"
MAX_BYTES = 256 * 1024
TIMEOUT = 20

ENROLLMENT_REASONS = {
    "challenge_replay": "this sign-in was already used",
    "challenge_invalid": "the sign-in challenge was not valid",
    "challenge_expired": "the approval took too long; start again",
    "login_state": "the sign-in did not match its approval",
    "invalid_human": "the identity evidence did not match the session",
    "unavailable": "Accounts is unavailable; try again in a moment",
}


def site() -> str:
    """The site to sign in to. ``PROSPECTUS_URL`` points the command at another deployment."""
    return (os.environ.get("PROSPECTUS_URL") or DEFAULT_SITE).rstrip("/")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # never follow a redirect with a bearer token
        return None


def default_opener():
    return urllib.request.build_opener(_NoRedirect())


@dataclass(frozen=True)
class Discovery:
    """What ``/cli/discovery`` publishes. Nothing secret."""

    site: str
    issuer: str
    client_id: str
    oauth_domain: str
    token_endpoint: str
    api_endpoint: str
    accounts_endpoint: str
    enrollment_endpoint: str
    remote_login_endpoint: str | None
    remote_callback_uri: str | None

    @property
    def key(self) -> str:
        return self.site.split("://", 1)[1].split("/", 1)[0]

    def target(self) -> Target:
        return Target(
            issuer=self.issuer,
            client_id=self.client_id,
            oauth_domain=self.oauth_domain,
            token_endpoint=self.token_endpoint,
            api_endpoint=self.api_endpoint,
            key=self.key,
            namespace=NAMESPACE,
            # Prospectus signs the CLI in only through the broker; its callback is the site's own page.
            callback_uri=self.remote_callback_uri or self.site + "/cli/callback",
            broker_endpoint=self.remote_login_endpoint,
            remote_callback_uri=self.remote_callback_uri,
        )


def _read_json(response) -> Any:
    return json.loads(response.read(MAX_BYTES + 1)[:MAX_BYTES] or b"null")


def discover(base: str | None = None, *, opener=None) -> Discovery:
    base = (base or site()).rstrip("/")
    opener = opener or default_opener()
    request = urllib.request.Request(base + "/cli/discovery", headers={"Accept": "application/json"})
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            value = _read_json(response)
    except urllib.error.HTTPError as error:
        raise AuthError(f"{base} did not publish its CLI sign-in (HTTP {error.code}).") from None
    except (OSError, ValueError):
        raise AuthError(f"Could not reach {base} to find its CLI sign-in. Check the connection and try again.") from None
    if not isinstance(value, dict) or value.get("protocol") != 1:
        raise AuthError(f"{base} publishes a CLI sign-in this version of prospectus does not understand.")
    try:
        return Discovery(
            site=base,
            issuer=value["issuer"],
            client_id=value["client_id"],
            oauth_domain=value["oauth_domain"],
            token_endpoint=value["token_endpoint"],
            api_endpoint=value["api_endpoint"],
            accounts_endpoint=value["accounts_endpoint"].rstrip("/"),
            enrollment_endpoint=value["enrollment_endpoint"],
            remote_login_endpoint=value.get("remote_login_endpoint"),
            remote_callback_uri=value.get("remote_callback_uri"),
        )
    except (KeyError, AttributeError):
        raise AuthError(f"{base} publishes an incomplete CLI sign-in document.") from None


def enrollment_failure(code: object) -> AuthError:
    code = code if isinstance(code, str) and code.replace("_", "").isalnum() and len(code) <= 60 else "unavailable"
    reason = ENROLLMENT_REASONS.get(code, "Accounts refused the enrollment")
    return AuthError(f"This login could not be enrolled with Prospectus ({code}): {reason}. Nothing was saved.")


def enroll(discovery: Discovery, tokens: Mapping[str, Any], transaction: str, enrollment: str | None, *, opener=None) -> None:
    """Enroll one remote login at Accounts. Raises on any failure, so the library stores nothing."""
    if not enrollment:
        # The approval page always asks Accounts for a challenge. Without one the login cannot be enrolled, and an
        # unenrolled session would only be refused later.
        raise enrollment_failure("challenge_invalid")
    access, identity = tokens.get("access_token"), tokens.get("id_token")
    if not isinstance(access, str) or not isinstance(identity, str):
        raise enrollment_failure("invalid_request")
    request = urllib.request.Request(
        discovery.enrollment_endpoint,
        method="POST",
        data=json.dumps({"challengeToken": enrollment, "idToken": identity, "loginState": transaction}).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "Bearer " + access,
            "Origin": discovery.site,
        },
    )
    try:
        with (opener or default_opener()).open(request, timeout=TIMEOUT) as response:
            _read_json(response)
    except urllib.error.HTTPError as error:
        try:
            code = json.loads(error.read(MAX_BYTES)).get("error")
        except (ValueError, AttributeError, OSError):
            code = None
        raise enrollment_failure(code) from None
    except (OSError, ValueError):
        raise enrollment_failure("unavailable") from None


class ProspectusSession:
    """The signed-in session for one site: the shared ``cli_login.Session`` plus Prospectus enrollment."""

    def __init__(self, discovery: Discovery, *, store=None, provider=None, clock=time.time, opener=None, http=None):
        self.discovery = discovery
        self.opener = opener
        self.http = http
        self._session = Session(
            discovery.target(),
            store=store,
            provider=provider,
            clock=clock,
            login_command=LOGIN_COMMAND,
            identity_provider="Google",
            api_token="access",
            authorization_scheme="Bearer",
        )

    def login(self, *, expected_email: str | None = None, note: str | None = None, out: Callable[[str], None] = print) -> dict:
        if not self.discovery.remote_login_endpoint:
            raise AuthError(f"{self.discovery.site} does not publish a remote sign-in broker.")
        options: dict[str, Any] = {"out": out, "note": note, "expected_email": expected_email}
        if self.http is not None:
            options["http"] = self.http
        try:
            result = remote_login(
                self._session.target,
                self._session.store_token_set,
                enroll=lambda tokens, transaction, enrollment: enroll(
                    self.discovery, tokens, transaction, enrollment, opener=self.opener
                ),
                **options,
            )
        except RemoteLoginError as error:
            raise AuthError(f"{error} Start again with `{LOGIN_COMMAND}`.") from error
        return {"subject": result["subject"], "label": result["label"]}

    def headers(self) -> dict:
        """The bearer header for the operator API, renewed when needed. Raises AuthError when signed out."""
        return self._session.headers(self.discovery.api_endpoint)

    def status(self) -> dict:
        return self._session.status() | {"site": self.discovery.site}

    def logout(self) -> dict:
        return self._session.logout()


def line_buffered(stream=sys.stdout) -> None:
    """Show the approval URL at once even when stdout is a pipe or a file."""
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure:
        try:
            reconfigure(line_buffering=True)
        except (ValueError, OSError):
            pass
