export type IntakeContactMode = "synthetic-only" | "real-contacts";

export interface IntakeContactPolicy {
  mode: IntakeContactMode;
  noticeVersion: string;
  siteId: string;
  formId: string;
  emailPattern: RegExp;
  emailRejectionMessage: string;
  staleNoticeMessage: string;
}

export const SYNTHETIC_CONTACT_POLICY: IntakeContactPolicy = {
  mode: "synthetic-only",
  noticeVersion: "synthetic-demo-v1",
  siteId: "anthus-prospectus-evaluation",
  formId: "synthetic-demo-v1",
  emailPattern: /^[^\s@]+@(?:[a-z0-9-]+\.)+invalid$/,
  emailRejectionMessage: "Use a synthetic email ending in .invalid for this local demo.",
  staleNoticeMessage: "Reload the form to read the current demo notice.",
};

export const REAL_CONTACT_POLICY: IntakeContactPolicy = {
  mode: "real-contacts",
  noticeVersion: "contact-v1",
  siteId: "anthus-website",
  formId: "engage-contact-v1",
  emailPattern: /^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/,
  emailRejectionMessage: "Enter a valid email address so we can reply.",
  staleNoticeMessage: "Reload the form to read the current privacy notice.",
};

export function intakeContactPolicyForMode(mode: string | undefined): IntakeContactPolicy {
  if (mode === undefined || mode === "" || mode === SYNTHETIC_CONTACT_POLICY.mode) return SYNTHETIC_CONTACT_POLICY;
  if (mode === REAL_CONTACT_POLICY.mode) return REAL_CONTACT_POLICY;
  throw new Error(`Unknown intake contact mode ${mode}`);
}
