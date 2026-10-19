/** Backfills membership markers for canonical accounts published before the index existed.
 * Default is a read-only count. Writes only create-only markers; account documents are never changed.
 */
import { DurableAccountsService } from "../accounts/durable-accounts";
import { VirtuusS3AccountFiles } from "../accounts/identity-files";
const bucket = process.env.PROSPECTUS_ACCOUNTS_BUCKET ?? "",
  owner = process.env.PROSPECTUS_ACCOUNTS_OWNER ?? "";
const requestedArguments = process.argv.slice(2);
if (requestedArguments.some((argument) => argument !== "--write"))
  throw new Error("Only --write is supported.");
const writeRequested = requestedArguments.includes("--write");
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[0-9]{12}$/.test(owner))
  throw new Error(
    "Set PROSPECTUS_ACCOUNTS_BUCKET and PROSPECTUS_ACCOUNTS_OWNER to the deployed central accounts bucket and its AWS account.",
  );
if (writeRequested && process.env.PROSPECTUS_MEMBERSHIP_INDEX_APPROVAL !== `${owner}/${bucket}`)
  throw new Error("Set PROSPECTUS_MEMBERSHIP_INDEX_APPROVAL=<owner>/<bucket> to approve marker writes.");
const files = new VirtuusS3AccountFiles({
  enabled: true,
  bucket,
  region: "us-east-1",
  expectedOwner: owner,
  tenant: "prospectus-central",
});
const personDirectoryUnusedByRebuild = {
  resolve: async () => {
    throw new Error("Rebuild never resolves people.");
  },
  get: async () => {
    throw new Error("Rebuild never resolves people.");
  },
};
const service = new DurableAccountsService(files, personDirectoryUnusedByRebuild);
try {
  if (writeRequested)
    console.log(JSON.stringify({ mode: "write", ...(await service.rebuildMembershipIndex()) }));
  else {
    const accounts = await service.allAccounts();
    console.log(
      JSON.stringify({
        mode: "read-only",
        accounts: accounts.length,
        activeMemberships: accounts.reduce(
          (total, document) =>
            total + Object.values(document.memberships).filter((member) => member.status === "active").length,
          0,
        ),
      }),
    );
  }
} finally {
  files.close();
}
