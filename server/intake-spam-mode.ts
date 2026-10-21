/** The intake spam deployment flag. Kept free of the rules file so infrastructure can import it. */
export type SpamLabelling = "shadow" | "label";

/** Absent or empty means "shadow": score and store only, no labels and no follow-up change. */
export function spamLabellingForMode(value: string | undefined): SpamLabelling {
  if (value === undefined || value === "" || value === "shadow") return "shadow";
  if (value === "label") return "label";
  throw new Error(`Unknown spam labelling mode ${value}`);
}
