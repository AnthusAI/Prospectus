/**
 * The invoice PDF, rendered from the issued ledger record. It uses pdf-lib, a pure-JavaScript library with no native
 * code, no headless browser and no font or file reads at runtime (the standard Helvetica fonts are built in), so it
 * bundles into the same Lambda as the rest of the service. The output is deterministic for a given record: the
 * creation date is the issue date and nothing random is embedded.
 */
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFPage,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
} from "pdf-lib";
import { deriveInvoice } from "./balances";
import { linksIn } from "./issuer";
import { fail, type LedgerInvoice } from "./model";
import { formatUsd, lineTotalCents } from "./money";

export interface InvoiceBillTo {
  name: string;
  addressLines: string[];
}

const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.45);
const LINK = rgb(0.05, 0.25, 0.7);

/** Standard fonts take WinAnsi text; anything else prints as a question mark rather than failing the render. */
const printable = (value: string) => value.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of printable(text).split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A draft has no PDF: it has no number and has not been issued. */
export async function renderInvoicePdf(invoice: LedgerInvoice, billTo?: InvoiceBillTo): Promise<Uint8Array> {
  if (invoice.lifecycle === "draft" || !invoice.number || !invoice.issueDate || !invoice.issuer)
    fail(409, "invoice_not_issued", "A draft invoice has no PDF.");
  const issuer = invoice.issuer;
  const document = await PDFDocument.create();
  document.setTitle(`Invoice ${invoice.number}`);
  document.setProducer("Prospectus billing");
  document.setCreator("Prospectus billing");
  const issuedAt = new Date(`${invoice.issueDate}T00:00:00Z`);
  document.setCreationDate(issuedAt);
  document.setModificationDate(issuedAt);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = document.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  const right = PAGE.width - MARGIN;
  const room = (needed: number) => {
    if (y - needed >= MARGIN) return;
    page = document.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };
  const write = (value: string, x: number, size = 10, font = regular, color = INK) =>
    page.drawText(printable(value), { x, y, size, font, color });
  const writeRight = (value: string, edge: number, size = 10, font = regular, color = INK) =>
    page.drawText(printable(value), {
      x: edge - font.widthOfTextAtSize(printable(value), size),
      y,
      size,
      font,
      color,
    });
  const paragraph = (value: string, x: number, width: number, size = 10, font = regular, color = INK) => {
    for (const line of wrap(value, font, size, width)) {
      room(size + 4);
      write(line, x, size, font, color);
      y -= size + 4;
    }
  };

  // Header: the issuer on the left, the invoice identity on the right.
  const top = y;
  write(issuer.legalName, MARGIN, 14, bold);
  y -= 18;
  for (const line of issuer.addressLines) paragraph(line, MARGIN, 280);
  paragraph(issuer.billingEmail, MARGIN, 280, 10, regular, MUTED);
  if (issuer.taxId) paragraph(`Tax ID ${issuer.taxId}`, MARGIN, 280, 10, regular, MUTED);
  const leftBottom = y;
  y = top;
  writeRight("INVOICE", right, 20, bold);
  y -= 24;
  const facts: [string, string][] = [
    ["Invoice number", invoice.number],
    ["Issued", invoice.issueDate],
    ["Due", invoice.dueDate ?? invoice.issueDate],
    ...(invoice.period ? ([["Period", invoice.period]] as [string, string][]) : []),
    ...(invoice.lifecycle === "void" ? ([["Status", "VOID"]] as [string, string][]) : []),
  ];
  for (const [label, value] of facts) {
    writeRight(value, right, 10, bold);
    writeRight(`${label}  `, right - bold.widthOfTextAtSize(printable(value), 10), 10, regular, MUTED);
    y -= 14;
  }
  y = Math.min(y, leftBottom) - 14;

  if (billTo) {
    write("BILL TO", MARGIN, 8, bold, MUTED);
    y -= 12;
    paragraph(billTo.name, MARGIN, 300, 10, bold);
    for (const line of billTo.addressLines) paragraph(line, MARGIN, 300);
    y -= 10;
  }

  // Line items.
  const columns = { quantity: right - 190, unit: right - 100, amount: right };
  room(40);
  page.drawLine({
    start: { x: MARGIN, y: y + 12 },
    end: { x: right, y: y + 12 },
    thickness: 0.8,
    color: INK,
  });
  write("Description", MARGIN, 9, bold, MUTED);
  writeRight("Qty", columns.quantity, 9, bold, MUTED);
  writeRight("Unit price", columns.unit, 9, bold, MUTED);
  writeRight("Amount", columns.amount, 9, bold, MUTED);
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.4, color: MUTED });
  y -= 14;
  for (const item of invoice.lineItems) {
    const lines = wrap(
      item.description + (item.period ? ` (${item.period})` : ""),
      regular,
      10,
      columns.quantity - MARGIN - 50,
    );
    room(lines.length * 14 + 6);
    writeRight(String(item.quantity), columns.quantity);
    writeRight(formatUsd(item.unitAmountCents), columns.unit);
    writeRight(formatUsd(lineTotalCents(item.quantity, item.unitAmountCents)), columns.amount);
    for (const line of lines) {
      write(line, MARGIN);
      y -= 14;
    }
    y -= 2;
  }
  page.drawLine({
    start: { x: MARGIN, y: y + 6 },
    end: { x: right, y: y + 6 },
    thickness: 0.4,
    color: MUTED,
  });
  y -= 10;

  // Totals. Tax is not collected, so the total is the subtotal.
  const figures = deriveInvoice(invoice);
  const totals: [string, string, boolean][] = [
    ["Subtotal", formatUsd(invoice.subtotalCents), false],
    ["Total", formatUsd(invoice.totalCents), true],
    ...(figures.allocatedCents !== 0
      ? ([["Payments received", `-${formatUsd(figures.allocatedCents)}`, false]] as [
          string,
          string,
          boolean,
        ][])
      : []),
    ...(figures.creditsCents !== 0
      ? ([["Credits", `-${formatUsd(figures.creditsCents)}`, false]] as [string, string, boolean][])
      : []),
    ["Balance due", formatUsd(figures.balanceCents), true],
  ];
  for (const [label, value, strong] of totals) {
    room(18);
    writeRight(value, right, 10, strong ? bold : regular);
    writeRight(label, columns.unit - 30, 10, strong ? bold : regular, MUTED);
    y -= 16;
  }
  y -= 12;

  // Payment methods, copied from the issuer record at issue. Links are https only and clickable.
  const methods = (invoice.paymentMethods ?? []).filter((method) => method.offered);
  if (methods.length) {
    room(40);
    write("HOW TO PAY", MARGIN, 8, bold, MUTED);
    y -= 14;
    for (const method of methods) {
      paragraph(method.label, MARGIN, right - MARGIN, 10, bold);
      for (const line of wrap(method.instructions, regular, 10, right - MARGIN - 12)) {
        room(14);
        const link = linksIn(line).find((candidate) => /^https:\/\//i.test(candidate));
        write(line, MARGIN + 12, 10, regular, link ? LINK : INK);
        if (link) addLink(document, page, regular, printable(line), link, MARGIN + 12, y);
        y -= 14;
      }
      y -= 4;
    }
  }
  if (issuer.footerNote) {
    y -= 6;
    paragraph(issuer.footerNote, MARGIN, right - MARGIN, 9, regular, MUTED);
  }
  return document.save({ useObjectStreams: false });
}

/** A clickable URI annotation over exactly the link, not the whole line. Trailing punctuation is not part of it. */
function addLink(
  document: PDFDocument,
  page: PDFPage,
  font: PDFFont,
  line: string,
  found: string,
  x: number,
  y: number,
) {
  const url = found.replace(/[.,;:)\]]+$/, "");
  const at = line.indexOf(url);
  if (at < 0 || !/^https:\/\/[^\s/]+/i.test(url)) return;
  const left = x + font.widthOfTextAtSize(line.slice(0, at), 10);
  const reference = document.context.register(
    document.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [left, y - 2, left + font.widthOfTextAtSize(url, 10), y + 10],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }),
  );
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) existing.push(reference);
  else page.node.set(PDFName.of("Annots"), document.context.obj([reference]));
}
