/** Link only a verified Google identity to an explicitly invited local member. */
export function createAdmissionHandler(operations) {
  return async (event) => {
    const deny = () => { throw new Error("Google admission requires an explicitly invited Prospectus member."); };
    if (event.region !== "us-east-1" || !/^us-east-1_[A-Za-z0-9]+$/.test(event.userPoolId ?? "")) deny();
    const pool = await operations.describePool(event.userPoolId);
    if (pool.Name !== "prospectus-cyclotron-members") deny();
    if (event.triggerSource === "PreSignUp_AdminCreateUser") return event;
    if (event.triggerSource !== "PreSignUp_ExternalProvider") deny();
    const attributes = event.request?.userAttributes ?? {};
    const email = String(attributes.email ?? "").trim().toLowerCase();
    const subject = /^(?:Google|google)_([A-Za-z0-9_-]{1,255})$/.exec(event.userName ?? "")?.[1];
    if (!subject || attributes.email_verified !== "true" || !/^[^\s"\\@]+@[^\s"\\@]+\.[^\s"\\@]+$/.test(email)) deny();
    const matches = await operations.findUsers(event.userPoolId, email);
    if (matches.PaginationToken || matches.Users?.length !== 1) deny();
    const member = matches.Users[0];
    const storedEmail = member.Attributes?.find(attribute => attribute.Name === "email")?.Value?.toLowerCase();
    if (!member.Enabled || !member.Username || member.UserStatus === "EXTERNAL_PROVIDER" || storedEmail !== email) deny();
    const groups = await operations.listGroups(event.userPoolId, member.Username);
    if (!groups.Groups?.some(group => group.GroupName === "prospectus-members")) deny();
    await operations.link(event.userPoolId, member.Username, subject);
    // Preserve the existing member's aliases and group. Do not auto-verify a new
    // profile, create users, add memberships, or log identity attributes.
    return event;
  };
}
