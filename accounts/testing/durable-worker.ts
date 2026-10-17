/** One-shot synthetic worker, deliberately killable at protocol boundaries. */
import { DurableGoogleIdentities } from "../durable-google-identities";
import { VirtuusIdentityFiles, VirtuusS3IdentityFiles } from "../identity-files";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const message = JSON.parse(input);
  const repository = new DurableGoogleIdentities(
    message.s3 ? new VirtuusS3IdentityFiles(message.s3) : new VirtuusIdentityFiles(message.root),
    async (phase, point) => {
      if (message.fault?.phase === phase && message.fault?.point === point) process.exit(86);
    },
  );
  const value =
    message.op === "issue"
      ? await repository.issue(message.value)
      : message.op === "associate"
        ? await repository.associate(message.value)
        : message.op === "recover"
          ? await repository.recover(message.value)
          : null;
  process.stdout.write(JSON.stringify({ value }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      error: { code: error && typeof error === "object" && "code" in error ? error.code : "unavailable" },
    }),
  );
}
