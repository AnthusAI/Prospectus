"""The ``prospectus`` command: sign in, then work with billing as you do in the console.

    prospectus login [--as EMAIL] [--note TEXT]
    prospectus auth status | prospectus whoami | prospectus logout
    prospectus billing accounts | invoices | payments | engagements
    prospectus billing invoice show|pdf|write-off NUMBER
    prospectus billing payment record|allocate ...

Every command takes ``--json`` for machine-readable output. Writes print what they will send and ask first; agents
pass ``--yes``. Nothing here prints a token.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Callable

from cli_login.errors import AuthError, OAuthError

from . import auth
from .api import APIError, BillingAPI

METHODS = {
    "bank_transfer": "Bank transfer",
    "check": "Check",
    "venmo": "Venmo",
    "melio": "Melio",
    "cash": "Cash",
    "other": "Other",
}
ALL_METHODS = METHODS | {"stripe_card": "Card, through Stripe", "stripe_bank": "Bank, through Stripe"}
STATUSES = ("draft", "issued", "partially_paid", "paid", "void", "uncollectible")
MAX_CENTS = 100_000_000_00


class UsageError(Exception):
    """A mistake in what was asked for. Nothing was sent."""


# Formatting ------------------------------------------------------------------------------------------------------


def dollars(cents: int | None) -> str:
    if cents is None:
        return "—"
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def parse_cents(text: str) -> int:
    """US dollars to integer cents, exactly: "10000", "10,000.00" and "$10,000" are all 1000000."""
    cleaned = text.strip().replace(",", "")
    if cleaned.startswith("$"):
        cleaned = cleaned[1:]
    if not re.fullmatch(r"\d+(\.\d{1,2})?", cleaned):
        raise UsageError(f"{text!r} is not a dollar amount. Use a positive amount like 10000 or 10,000.00.")
    try:
        cents = int((Decimal(cleaned) * 100).to_integral_exact())
    except InvalidOperation:
        raise UsageError(f"{text!r} is not a dollar amount.") from None
    if cents <= 0:
        raise UsageError("An amount must be more than $0.00.")
    if cents > MAX_CENTS:
        raise UsageError(f"{text!r} is larger than any amount Prospectus records.")
    return cents


def parse_date(text: str) -> str:
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        raise UsageError(f"{text!r} is not a date. Use YYYY-MM-DD.") from None


def table(rows: list[list[str]], headers: list[str]) -> str:
    if not rows:
        return ""
    widths = [max(len(str(row[i])) for row in [headers, *rows]) for i in range(len(headers))]
    lines = ["  ".join(str(value).ljust(widths[i]) for i, value in enumerate(row)).rstrip() for row in [headers, *rows]]
    return "\n".join(lines)


def status_label(status: str) -> str:
    return {"partially_paid": "partly paid", "uncollectible": "written off"}.get(status, status)


# Runtime ---------------------------------------------------------------------------------------------------------


@dataclass
class Runtime:
    """What the commands need from the outside world, so specs can replace every piece."""

    out: Callable[[str], None] = print
    err: Callable[[str], None] = field(default=lambda text: print(text, file=sys.stderr))
    ask: Callable[[str], str] | None = None
    discover: Callable[[], auth.Discovery] = auth.discover
    session_factory: Callable[[auth.Discovery], Any] = auth.ProspectusSession
    api_factory: Callable[[auth.Discovery, Any], BillingAPI] | None = None
    write_file: Callable[[str, bytes], None] | None = None
    today: Callable[[], str] = lambda: date.today().isoformat()

    def __post_init__(self):
        if self.ask is None:
            self.ask = _terminal_ask
        if self.api_factory is None:
            self.api_factory = lambda discovery, session: BillingAPI(discovery.accounts_endpoint, session.headers)
        if self.write_file is None:
            self.write_file = _write_file


def _terminal_ask(prompt: str) -> str:
    if not sys.stdin.isatty():
        raise UsageError("This would change billing records. Pass --yes to confirm without a terminal.")
    return input(prompt)


def _write_file(path: str, data: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(data)


class Context:
    def __init__(self, runtime: Runtime, args: argparse.Namespace):
        self.runtime = runtime
        self.args = args
        self._discovery: auth.Discovery | None = None
        self._session = None
        self._api: BillingAPI | None = None

    @property
    def discovery(self) -> auth.Discovery:
        if self._discovery is None:
            self._discovery = self.runtime.discover()
        return self._discovery

    @property
    def session(self):
        if self._session is None:
            self._session = self.runtime.session_factory(self.discovery)
        return self._session

    @property
    def api(self) -> BillingAPI:
        if self._api is None:
            self._api = self.runtime.api_factory(self.discovery, self.session)
        return self._api

    def emit(self, value: Any, text: str) -> None:
        if getattr(self.args, "json", False):
            self.runtime.out(json.dumps(value, indent=2, sort_keys=True))
        elif text:
            self.runtime.out(text)

    def confirm(self, summary: str) -> None:
        self.runtime.out(summary)
        if getattr(self.args, "yes", False):
            return
        answer = self.runtime.ask("Send this to Prospectus? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            raise UsageError("Nothing was sent.")

    def account(self, name_or_id: str) -> dict:
        accounts = self.api.accounts()
        for account in accounts:
            if account["id"] == name_or_id:
                return account
        wanted = name_or_id.strip().casefold()
        exact = [account for account in accounts if account["name"].casefold() == wanted]
        if len(exact) == 1:
            return exact[0]
        partial = exact or [account for account in accounts if wanted in account["name"].casefold()]
        if len(partial) == 1:
            return partial[0]
        if not partial:
            raise UsageError(f"No account is named {name_or_id!r}. `prospectus billing accounts` lists them.")
        names = "\n".join(f"  {account['name']}  {account['id']}" for account in partial)
        raise UsageError(f"{name_or_id!r} matches more than one account. Name one by its ID:\n{names}")

    def invoice(self, number: str) -> dict:
        return self.api.invoice(number)["invoice"]


# Commands --------------------------------------------------------------------------------------------------------


def cmd_login(ctx: Context) -> int:
    auth.line_buffered()
    result = ctx.session.login(expected_email=ctx.args.expect_email, note=ctx.args.note, out=ctx.runtime.out)
    ctx.emit(result, "")  # the library has already printed who signed in
    return 0


def cmd_status(ctx: Context) -> int:
    status = ctx.session.status()
    if not status.get("signed_in"):
        ctx.emit(status, f"Not signed in to {status['site']}. Run `prospectus login`.")
        return 1
    ctx.emit(status, f"Signed in to {status['site']} as {status['label']}.")
    return 0


def cmd_whoami(ctx: Context) -> int:
    status = ctx.session.status()
    if not status.get("signed_in"):
        raise AuthError("Not signed in. Run `prospectus login`.")
    permissions = ctx.api.access()
    value = {"label": status["label"], "site": status["site"], "permissions": permissions}
    held = ", ".join(permissions) if permissions else "no billing permissions"
    ctx.emit(value, f"{status['label']} on {status['site']}: {held}.")
    return 0


def cmd_logout(ctx: Context) -> int:
    result = ctx.session.logout()
    revoked = {"confirmed": "revoked", "unconfirmed": "revocation not confirmed", "not_needed": "nothing to revoke"}
    ctx.emit(result, f"Signed out ({revoked.get(result.get('remote_revocation'), 'signed out')}).")
    return 0


def cmd_accounts(ctx: Context) -> int:
    accounts = sorted(ctx.api.accounts(), key=lambda account: account["name"].casefold())
    rows = [[account["name"], account.get("mode") or "not billable", account["id"]] for account in accounts]
    ctx.emit(accounts, table(rows, ["ACCOUNT", "BILLING", "ID"]) or "No accounts.")
    return 0


def _names(ctx: Context) -> dict[str, str]:
    return {account["id"]: account["name"] for account in ctx.api.accounts()}


def cmd_invoices(ctx: Context) -> int:
    account = ctx.account(ctx.args.account) if ctx.args.account else None
    invoices = ctx.api.invoices(account["id"] if account else None)
    if ctx.args.status:
        invoices = [invoice for invoice in invoices if invoice["status"] == ctx.args.status]
    names = {account["id"]: account["name"]} if account else _names(ctx)
    invoices.sort(key=lambda invoice: (invoice.get("issuedAt") or "9999", invoice.get("number") or ""))
    rows = [
        [
            invoice.get("number") or "draft",
            names.get(invoice["accountId"], invoice["accountId"]),
            invoice.get("issuedAt") or "—",
            invoice.get("dueAt") or "—",
            status_label(invoice["status"]),
            dollars(invoice["totalCents"]),
            dollars(invoice["balanceCents"]),
        ]
        for invoice in invoices
    ]
    ctx.emit(invoices, table(rows, ["INVOICE", "ACCOUNT", "ISSUED", "DUE", "STATUS", "TOTAL", "BALANCE"]) or "No invoices.")
    return 0


def cmd_invoice_show(ctx: Context) -> int:
    answer = ctx.api.invoice(ctx.args.number)
    invoice, account = answer["invoice"], answer.get("account") or {}
    lines = [
        f"Invoice {invoice.get('number') or 'draft'} to {account.get('name', invoice['accountId'])}",
        f"  Status   {status_label(invoice['status'])}" + (f" on {invoice['paidAt']}" if invoice.get("paidAt") else ""),
        f"  Issued   {invoice.get('issuedAt') or '—'}    Due {invoice.get('dueAt') or '—'}",
        f"  Total    {dollars(invoice['totalCents'])}    Balance {dollars(invoice['balanceCents'])}",
        "",
    ]
    for item in invoice.get("lineItems", []):
        quantity = item.get("quantity", 1)
        dates = f" ({item['period']})" if item.get("period") else ""
        amount = quantity * item.get("unitAmountCents", 0)
        lines.append(f"  {item.get('description', '')}{dates}  {quantity} × {dollars(item.get('unitAmountCents'))} = {dollars(amount)}")
    ctx.emit(answer, "\n".join(lines))
    return 0


def cmd_invoice_pdf(ctx: Context) -> int:
    data = ctx.api.invoice_pdf(ctx.args.number)
    path = ctx.args.output or f"invoice-{ctx.args.number}.pdf"
    ctx.runtime.write_file(path, data)
    ctx.emit({"path": path, "bytes": len(data)}, f"Saved {path}.")
    return 0


def cmd_write_off(ctx: Context) -> int:
    invoice = ctx.invoice(ctx.args.number)
    ctx.confirm(
        f"Write off invoice {invoice['number']}: {dollars(invoice['balanceCents'])} still owed.\n  Reason: {ctx.args.reason}"
    )
    result = ctx.api.write_off(invoice["id"], ctx.args.reason, invoice["revision"])
    ctx.emit(result, f"Wrote off {result.get('number', invoice['number'])}.")
    return 0


def cmd_payments(ctx: Context) -> int:
    account = ctx.account(ctx.args.account) if ctx.args.account else None
    payments = ctx.api.payments(account["id"] if account else None)
    names = {account["id"]: account["name"]} if account else _names(ctx)
    payments.sort(key=lambda payment: payment["receivedAt"])
    rows = [
        [
            payment["receivedAt"],
            names.get(payment["accountId"], payment["accountId"]),
            ALL_METHODS.get(payment["method"], payment["method"]) + (f" {payment['reference']}" if payment.get("reference") else ""),
            dollars(payment["amountCents"]),
            dollars(payment["unallocatedCents"]),
            payment["id"],
        ]
        for payment in payments
    ]
    ctx.emit(payments, table(rows, ["RECEIVED", "ACCOUNT", "METHOD", "AMOUNT", "UNAPPLIED", "ID"]) or "No payments.")
    return 0


def cmd_engagements(ctx: Context) -> int:
    account = ctx.account(ctx.args.account) if ctx.args.account else None
    engagements = ctx.api.engagements(account["id"] if account else None)
    names = {account["id"]: account["name"]} if account else _names(ctx)
    rows = []
    for engagement in engagements:
        price = (
            f"{dollars(engagement['monthlyAmountCents'])}/month"
            if engagement.get("monthlyAmountCents") is not None
            else dollars(engagement.get("packagePriceCents"))
        )
        last = engagement.get("lastInvoiced")
        rows.append(
            [
                names.get(engagement["accountId"], engagement["accountId"]),
                engagement["name"],
                engagement["status"],
                price,
                f"{last['invoiceNumber']} ({last['issueDate']})" if last else "never",
                engagement.get("uninvoicedMonth") or "—",
            ]
        )
    ctx.emit(engagements, table(rows, ["ACCOUNT", "ENGAGEMENT", "STATUS", "PRICE", "LAST INVOICED", "TO INVOICE"]) or "No engagements.")
    return 0


def _allocations(ctx: Context, account_id: str, specs: list[str], available: int) -> list[dict]:
    """``NUMBER`` (its whole balance, up to what is left) or ``NUMBER=AMOUNT``, in order."""
    allocations, left = [], available
    for spec in specs:
        number, _, amount = spec.partition("=")
        invoice = ctx.invoice(number.strip())
        if invoice["accountId"] != account_id:
            raise UsageError(f"Invoice {invoice['number']} belongs to another account.")
        if invoice["balanceCents"] <= 0:
            raise UsageError(f"Invoice {invoice['number']} has nothing left to pay.")
        cents = parse_cents(amount) if amount else min(invoice["balanceCents"], left)
        if cents > invoice["balanceCents"]:
            raise UsageError(f"{dollars(cents)} is more than the {dollars(invoice['balanceCents'])} left on {invoice['number']}.")
        if cents > left or cents <= 0:
            raise UsageError(f"The payment has only {dollars(left)} left to apply to {invoice['number']}.")
        left -= cents
        allocations.append({"invoiceId": invoice["id"], "amountCents": cents, "number": invoice["number"], "balance": invoice["balanceCents"]})
    return allocations


def _applied_text(allocations: list[dict]) -> str:
    return "\n".join(
        f"  Apply {dollars(item['amountCents'])} to {item['number']} (balance {dollars(item['balance'])})" for item in allocations
    )


def cmd_payment_record(ctx: Context) -> int:
    args = ctx.args
    cents = parse_cents(args.amount)
    received = parse_date(args.received) if args.received else ctx.runtime.today()
    account = ctx.account(args.account)
    allocations = _allocations(ctx, account["id"], args.apply or [], cents)
    unapplied = cents - sum(item["amountCents"] for item in allocations)
    summary = [
        f"Record a payment from {account['name']}:",
        f"  {dollars(cents)} by {METHODS[args.method]}, received {received}"
        + (f", reference {args.reference}" if args.reference else ""),
    ]
    if allocations:
        summary.append(_applied_text(allocations))
    if unapplied:
        summary.append(f"  {dollars(unapplied)} left to apply later")
    ctx.confirm("\n".join(summary))
    payment = ctx.api.record_payment(
        account["id"],
        {
            "amountCents": cents,
            "method": args.method,
            "receivedAt": received,
            **({"reference": args.reference} if args.reference else {}),
            **({"note": args.note} if args.note else {}),
            "allocations": [{"invoiceId": item["invoiceId"], "amountCents": item["amountCents"]} for item in allocations],
        },
    )
    applied = ", ".join(f"{dollars(item['amountCents'])} to {item['number']}" for item in allocations)
    ctx.emit(payment, f"Recorded {dollars(cents)} from {account['name']}" + (f"; applied {applied}." if applied else "."))
    return 0


def cmd_payment_allocate(ctx: Context) -> int:
    payment = ctx.api.payment(ctx.args.payment_id)
    if payment["unallocatedCents"] <= 0:
        raise UsageError("That payment is already fully applied.")
    allocations = _allocations(ctx, payment["accountId"], ctx.args.apply, payment["unallocatedCents"])
    ctx.confirm(f"Apply part of the {dollars(payment['amountCents'])} payment received {payment['receivedAt']}:\n{_applied_text(allocations)}")
    result = ctx.api.allocate(
        payment["id"], [{"invoiceId": item["invoiceId"], "amountCents": item["amountCents"]} for item in allocations]
    )
    ctx.emit(result, f"Applied. {dollars(result['unallocatedCents'])} of the payment is left to apply.")
    return 0


# Parser ----------------------------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="print JSON instead of text")
    writes = argparse.ArgumentParser(add_help=False)
    writes.add_argument("--yes", "-y", action="store_true", help="send without asking (for agents)")

    root = argparse.ArgumentParser(prog="prospectus", description="Work with Prospectus from the command line.", parents=[common])
    commands = root.add_subparsers(dest="command", required=True, metavar="COMMAND")

    login = commands.add_parser("login", parents=[common], help="sign in by approving in a browser on any device")
    login.add_argument("--remote", action="store_true", help=argparse.SUPPRESS)  # every login is remote; kept for habit
    login.add_argument("--as", "--expect-email", dest="expect_email", metavar="EMAIL", help="refuse a sign-in by anyone else")
    login.add_argument("--note", help="shown on the approval page, such as which agent is asking")
    login.set_defaults(run=cmd_login)
    commands.add_parser("logout", parents=[common], help="sign out and revoke the session").set_defaults(run=cmd_logout)
    commands.add_parser("whoami", parents=[common], help="who you are and what Prospectus lets you do").set_defaults(run=cmd_whoami)
    auth_parser = commands.add_parser("auth", help="the local session")
    auth_commands = auth_parser.add_subparsers(dest="auth_command", required=True, metavar="COMMAND")
    auth_commands.add_parser("status", parents=[common], help="who is signed in on this machine").set_defaults(run=cmd_status)

    billing = commands.add_parser("billing", help="invoices, payments and engagements")
    sub = billing.add_subparsers(dest="billing_command", required=True, metavar="COMMAND")
    sub.add_parser("accounts", parents=[common], help="accounts and how they pay").set_defaults(run=cmd_accounts)

    invoices = sub.add_parser("invoices", parents=[common], help="list invoices with balances")
    invoices.add_argument("--account", help="account name or ID")
    invoices.add_argument("--status", choices=STATUSES)
    invoices.set_defaults(run=cmd_invoices)

    payments = sub.add_parser("payments", parents=[common], help="list payments")
    payments.add_argument("--account", help="account name or ID")
    payments.set_defaults(run=cmd_payments)

    engagements = sub.add_parser("engagements", parents=[common], help="list engagements and what is waiting to invoice")
    engagements.add_argument("--account", help="account name or ID")
    engagements.set_defaults(run=cmd_engagements)

    invoice = sub.add_parser("invoice", help="one invoice")
    invoice_commands = invoice.add_subparsers(dest="invoice_command", required=True, metavar="COMMAND")
    show = invoice_commands.add_parser("show", parents=[common], help="an invoice's lines and balance")
    show.add_argument("number")
    show.set_defaults(run=cmd_invoice_show)
    pdf = invoice_commands.add_parser("pdf", parents=[common], help="save an invoice's PDF")
    pdf.add_argument("number")
    pdf.add_argument("-o", "--output", metavar="FILE")
    pdf.set_defaults(run=cmd_invoice_pdf)
    write_off = invoice_commands.add_parser("write-off", parents=[common, writes], help="write off what is still owed")
    write_off.add_argument("number")
    write_off.add_argument("--reason", required=True)
    write_off.set_defaults(run=cmd_write_off)

    payment = sub.add_parser("payment", help="record or apply a payment")
    payment_commands = payment.add_subparsers(dest="payment_command", required=True, metavar="COMMAND")
    record = payment_commands.add_parser("record", parents=[common, writes], help="record money that arrived outside Stripe")
    record.add_argument("--account", required=True, help="account name or ID")
    record.add_argument("--amount", required=True, help="US dollars, such as 10000 or 10,000.00")
    record.add_argument("--method", required=True, choices=sorted(METHODS))
    record.add_argument("--received", metavar="YYYY-MM-DD", help="the day the money arrived (default today)")
    record.add_argument("--reference", help="check number or transfer ID")
    record.add_argument("--note")
    record.add_argument(
        "--apply", action="append", metavar="NUMBER[=AMOUNT]", help="apply to an invoice; repeat to split. No amount applies its balance"
    )
    record.set_defaults(run=cmd_payment_record)
    allocate = payment_commands.add_parser("allocate", parents=[common, writes], help="apply what is left of a payment")
    allocate.add_argument("payment_id")
    allocate.add_argument("apply", nargs="+", metavar="NUMBER[=AMOUNT]")
    allocate.set_defaults(run=cmd_payment_allocate)
    return root


def main(argv: list[str] | None = None, runtime: Runtime | None = None) -> int:
    runtime = runtime or Runtime()
    args = parser().parse_args(argv)
    ctx = Context(runtime, args)
    try:
        return args.run(ctx)
    except UsageError as error:
        runtime.err(str(error))
        return 2
    except APIError as error:
        runtime.err(str(error))
        return 1
    except (AuthError, OAuthError) as error:
        runtime.err(str(error))
        return 1
    except KeyboardInterrupt:
        runtime.err("Stopped. Nothing more was sent.")
        return 130


def entry() -> None:  # pragma: no cover - console script
    sys.exit(main())
