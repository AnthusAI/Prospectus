"""Specs for the prospectus command (features/prospectus-cli.feature). A fake API and session; no network, no tokens."""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from cli_login.errors import AuthError

from . import auth, cli
from .api import BillingAPI

DISCOVERY = auth.Discovery(
    site="https://prospectus.anth.us",
    issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
    client_id="client",
    oauth_domain="https://example.auth.us-east-1.amazoncognito.com",
    token_endpoint="https://example.auth.us-east-1.amazoncognito.com/oauth2/token",
    api_endpoint="https://prospectus.anth.us",
    accounts_endpoint="https://api.example.com/api/saas",
    enrollment_endpoint="https://api.example.com/api/saas/identity/resolve",
    remote_login_endpoint="https://broker.example.com",
    remote_callback_uri="https://prospectus.anth.us/cli/callback",
)
DATA_PARADE = {"id": "acct-dp", "name": "Data Parade", "mode": "invoiced", "billable": True}
DATA_LAKE = {"id": "acct-dl", "name": "Data Lake Co", "billable": False}
KESTREL = {"id": "acct-k", "name": "Kestrel", "billable": False}


def invoice(number, balance, account="acct-dp", total=None, status="issued"):
    return {
        "id": f"inv-{number}",
        "accountId": account,
        "number": number,
        "issuedAt": "2026-10-31",
        "dueAt": "2026-11-30",
        "status": status,
        "totalCents": total or balance,
        "balanceCents": balance,
        "lineItems": [{"description": "Monthly retainer", "quantity": 1, "unitAmountCents": total or balance, "period": "October 2026"}],
        "revision": 3,
    }


class Response(io.BytesIO):
    def __init__(self, body, kind="application/json"):
        super().__init__(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.headers = {"Content-Type": kind}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeServer:
    """Answers the operator routes from a small in-memory ledger and keeps every request it saw."""

    def __init__(self, invoices=(), refuse=None):
        self.invoices = {item["number"]: item for item in invoices}
        self.requests = []
        self.refuse = refuse

    def open(self, request, timeout=None):
        path = request.full_url.removeprefix(DISCOVERY.accounts_endpoint)
        body = json.loads(request.data) if request.data else None
        self.requests.append((request.get_method(), path, body, dict(request.header_items())))
        if self.refuse:
            status, value = self.refuse
            raise urllib.error.HTTPError(request.full_url, status, "refused", {}, io.BytesIO(json.dumps(value).encode()))
        if path == "/operator/billing/accounts":
            return Response({"accounts": [DATA_PARADE, DATA_LAKE, KESTREL]})
        if path == "/operator/billing/access":
            return Response({"permissions": ["accounts:admin:read", "accounts:admin:billing"]})
        if path.startswith("/operator/billing/invoices/") and path.count("/") == 4:
            number = path.rsplit("/", 1)[1]
            if number not in self.invoices:
                raise urllib.error.HTTPError(request.full_url, 404, "missing", {}, io.BytesIO(b'{"error":"invoice_missing","message":"Invoice not found."}'))
            return Response({"invoice": self.invoices[number], "account": DATA_PARADE})
        if path in ("/operator/accounts/acct-dp/invoices", "/operator/billing/invoices"):
            return Response({"invoices": list(self.invoices.values())})
        if path == "/operator/accounts/acct-dp/payments" and request.get_method() == "POST":
            return Response({"payment": {"id": "pay-1", "unallocatedCents": 0, **body}})
        raise AssertionError(f"unexpected request {request.get_method()} {path}")

    def writes(self):
        return [entry for entry in self.requests if entry[0] == "POST"]


class FakeSession:
    def __init__(self, signed_in=True):
        self.signed_in = signed_in
        self.logged_out = False

    def headers(self):
        if not self.signed_in:
            raise AuthError("Not signed in. Run `prospectus login`.")
        return {"content-type": "application/json", "Authorization": "Bearer access-token"}

    def status(self):
        if not self.signed_in:
            return {"signed_in": False, "site": DISCOVERY.site}
        return {"signed_in": True, "label": "ryan@example.com", "subject": "sub", "site": DISCOVERY.site}

    def logout(self):
        self.logged_out = True
        return {"local_session_removed": True, "remote_revocation": "confirmed"}


def run(argv, server=None, session=None, answer=None):
    server = server or FakeServer()
    session = session or FakeSession()
    out, err, files = [], [], {}

    def ask(prompt):
        out.append(prompt)
        if answer is None:
            raise cli.UsageError("This would change billing records. Pass --yes to confirm without a terminal.")
        return answer

    ids = iter(f"op-{n}" for n in range(1, 100))
    runtime = cli.Runtime(
        out=out.append,
        err=err.append,
        ask=ask,
        discover=lambda: DISCOVERY,
        session_factory=lambda discovery: session,
        api_factory=lambda discovery, s: BillingAPI(discovery.accounts_endpoint, s.headers, opener=server, new_id=lambda: next(ids)),
        write_file=lambda path, data: files.__setitem__(path, data),
        today=lambda: "2026-11-12",
    )
    code = cli.main(argv, runtime)
    return code, "\n".join(out), "\n".join(err), server, files


# Amounts ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("text", ["10000", "10,000.00", "$10,000", " 10000.0 "])
def test_amounts_are_dollars_read_exactly(text):
    assert cli.parse_cents(text) == 1_000_000


@pytest.mark.parametrize("text", ["10.001", "0", "-5", "ten", "1e4", ""])
def test_bad_amounts_are_refused(text):
    with pytest.raises(cli.UsageError):
        cli.parse_cents(text)


# Recording payments ----------------------------------------------------------------------------------------------


def test_recording_a_payment_and_applying_it_to_an_invoice():
    server = FakeServer([invoice("202610-001", 1_000_000)])
    code, out, err, server, _ = run(
        ["billing", "payment", "record", "--account", "Data Parade", "--amount", "10000", "--method", "melio",
         "--received", "2026-11-10", "--apply", "202610-001", "--yes"],
        server,
    )
    assert code == 0, err
    [(method, path, body, headers)] = server.writes()
    assert path == "/operator/accounts/acct-dp/payments"
    assert body == {
        "operationId": "op-1",
        "accountId": "acct-dp",
        "amountCents": 1_000_000,
        "method": "melio",
        "receivedAt": "2026-11-10",
        "allocations": [{"invoiceId": "inv-202610-001", "amountCents": 1_000_000}],
    }
    assert headers["Authorization"] == "Bearer access-token"
    assert "$10,000.00 by Melio, received 2026-11-10" in out
    assert "Recorded $10,000.00 from Data Parade; applied $10,000.00 to 202610-001." in out
    assert "access-token" not in out + err


def test_a_payment_split_across_two_invoices():
    server = FakeServer([invoice("202610-001", 500_000), invoice("202611-001", 1_000_000)])
    code, out, err, server, _ = run(
        ["billing", "payment", "record", "--account", "acct-dp", "--amount", "10000", "--method", "check",
         "--reference", "1042", "--apply", "202610-001=4000", "--apply", "202611-001=6000", "--yes"],
        server,
    )
    assert code == 0, err
    body = server.writes()[0][2]
    assert body["allocations"] == [
        {"invoiceId": "inv-202610-001", "amountCents": 400_000},
        {"invoiceId": "inv-202611-001", "amountCents": 600_000},
    ]
    assert body["reference"] == "1042"
    assert body["receivedAt"] == "2026-11-12"  # today when --received is left out


def test_applying_more_than_an_invoice_owes_is_refused_before_sending():
    server = FakeServer([invoice("202610-001", 500_000)])
    code, _, err, server, _ = run(
        ["billing", "payment", "record", "--account", "Data Parade", "--amount", "10000", "--method", "melio",
         "--apply", "202610-001=6000", "--yes"],
        server,
    )
    assert code == 2
    assert "more than the $5,000.00 left on 202610-001" in err
    assert server.writes() == []


def test_writes_are_confirmed_before_they_are_sent():
    server = FakeServer([invoice("202610-001", 1_000_000)])
    argv = ["billing", "payment", "record", "--account", "Data Parade", "--amount", "10000", "--method", "melio"]
    code, out, err, server, _ = run(argv, server)
    assert code == 2 and "Pass --yes" in err and server.writes() == []
    code, out, err, server, _ = run(argv, FakeServer(), answer="n")
    assert code == 2 and "Nothing was sent." in err and server.writes() == []
    code, out, err, server, _ = run(argv, FakeServer(), answer="y")
    assert code == 0 and len(server.writes()) == 1
    assert "$10,000.00 left to apply later" in out


def test_an_account_must_name_exactly_one():
    code, _, err, server, _ = run(["billing", "invoices", "--account", "Data"])
    assert code == 2 and "matches more than one account" in err and "acct-dl" in err
    code, _, err, _, _ = run(["billing", "invoices", "--account", "Nobody"])
    assert code == 2 and "No account is named 'Nobody'" in err


def test_refusals_come_back_in_the_servers_words():
    server = FakeServer(refuse=(403, {"error": "forbidden", "message": "Billing writes need accounts:admin:billing."}))
    code, _, err, _, _ = run(["billing", "accounts"], server)
    assert code == 1 and err == "Billing writes need accounts:admin:billing."


def test_an_unenrolled_session_is_told_to_sign_in_again():
    server = FakeServer(refuse=(401, {"error": "reenrollment_required"}))
    code, _, err, _, _ = run(["billing", "accounts"], server)
    assert code == 1 and "Run `prospectus login` again." in err


def test_commands_need_a_session():
    code, _, err, server, _ = run(["billing", "invoices"], session=FakeSession(signed_in=False))
    assert code == 1 and "prospectus login" in err and server.requests == []


# Reading ---------------------------------------------------------------------------------------------------------


def test_listing_invoices_with_balances():
    server = FakeServer([invoice("202610-001", 0, total=1_000_000, status="paid"), invoice("202611-001", 1_000_000)])
    code, out, err, _, _ = run(["billing", "invoices", "--account", "Data Parade"], server)
    assert code == 0, err
    assert out.splitlines()[0].split() == ["INVOICE", "ACCOUNT", "ISSUED", "DUE", "STATUS", "TOTAL", "BALANCE"]
    assert "202610-001  Data Parade  2026-10-31  2026-11-30  paid    $10,000.00  $0.00" in out
    code, out, _, _, _ = run(["billing", "invoices", "--account", "Data Parade", "--status", "issued", "--json"], server)
    assert [item["number"] for item in json.loads(out)] == ["202611-001"]


def test_showing_and_saving_an_invoice():
    server = FakeServer([invoice("202610-001", 1_000_000)])
    code, out, _, _, _ = run(["billing", "invoice", "show", "202610-001"], server)
    assert code == 0
    assert "Invoice 202610-001 to Data Parade" in out and "Monthly retainer (October 2026)" in out


# Session ---------------------------------------------------------------------------------------------------------


def test_status_reads_only_the_local_session():
    code, out, _, server, _ = run(["auth", "status"])
    assert code == 0 and out == "Signed in to https://prospectus.anth.us as ryan@example.com." and server.requests == []
    code, out, _, _, _ = run(["auth", "status"], session=FakeSession(signed_in=False))
    assert code == 1 and "Run `prospectus login`" in out


def test_whoami_asks_the_server():
    code, out, _, _, _ = run(["whoami"])
    assert code == 0 and out == "ryan@example.com on https://prospectus.anth.us: accounts:admin:read, accounts:admin:billing."


def test_logout_removes_and_revokes_the_session():
    session = FakeSession()
    code, out, _, _, _ = run(["logout"], session=session)
    assert code == 0 and session.logged_out and out == "Signed out (revoked)."
