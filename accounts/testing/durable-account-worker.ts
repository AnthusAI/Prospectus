/** Disposable local process fixture. Directory input contains synthetic Persons only. */
import { DurableAccountsService } from "../durable-accounts";
import { VirtuusAccountFiles } from "../identity-files";
import type { Context, Person } from "../model";
let text = "";
for await (const chunk of process.stdin) text += chunk;
try {
  const message = JSON.parse(text),
    people: Record<string, Person> = message.people;
  const directory = {
    resolve: async (context: Context) => people[context.human.subject] ?? null,
    get: async (id: string) => Object.values(people).find((person) => person.id === id) ?? null,
  };
  const service = new DurableAccountsService(
    new VirtuusAccountFiles(message.root),
    directory,
    () => "2030-03-17T17:46:40.000Z",
  );
  const value =
    message.op === "create"
      ? await service.create(message.context, message.name, message.requestId)
      : message.op === "member"
        ? await service.setMembership(
            message.context,
            message.accountId,
            message.personId,
            message.role,
            message.status,
          )
        : await service.authorize(message.context, message.accountId, message.operation);
  process.stdout.write(JSON.stringify({ value }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      error: { code: error && typeof error === "object" && "code" in error ? error.code : "unavailable" },
    }),
  );
}
