import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/** One list email. Every list email carries the RFC 8058 one-click unsubscribe headers. */
export interface ListEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  /** The HTTPS unsubscribe URL for List-Unsubscribe; required, so no list email can omit it. */
  unsubscribeUrl: string;
  /** RFC 2919 List-Id, for example "Papyrus <papyrus-newsletter-v1.news.apyr.us>". */
  listId: string;
}
export type ListMailer = (email: ListEmail) => Promise<void>;

/** The headers every list email carries (RFC 2369, RFC 8058, RFC 2919). */
export function listHeaders(email: Pick<ListEmail, "unsubscribeUrl" | "listId">) {
  if (!/^https:\/\/[^\s<>]+$/.test(email.unsubscribeUrl))
    throw new Error("A list email needs an HTTPS unsubscribe URL.");
  return [
    { Name: "List-Unsubscribe", Value: `<${email.unsubscribeUrl}>` },
    { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    { Name: "List-Id", Value: email.listId },
  ];
}

/** Sends through SES v2 with the newsletter configuration set, so SES applies its bounce and complaint suppression. */
export function sesListMailer(
  configurationSet: string,
  client: Pick<SESv2Client, "send"> = new SESv2Client({ region: "us-east-1", maxAttempts: 2 }),
): ListMailer {
  return async (email) => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: email.from,
        Destination: { ToAddresses: [email.to] },
        ConfigurationSetName: configurationSet,
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: email.text, Charset: "UTF-8" },
              Html: { Data: email.html, Charset: "UTF-8" },
            },
            Headers: listHeaders(email),
          },
        },
      }),
    );
  };
}
