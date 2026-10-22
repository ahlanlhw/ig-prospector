// Sprill — local message drafting (M0).
//
// Template-based, deterministic drafts that follow the spec's rules: concise,
// reference ONE truthful visible detail, explain relevance, ask ONE question,
// no fake familiarity, no unsupported claims. At M1 this is swapped for the
// Gemini drafter (same signature) via the Cloud Function backend.

const OBJECTIVES = {
  networking: "connect",
  sales: "explore working together",
  partnership: "explore a partnership",
  affiliate: "explore an affiliate collaboration",
  creator: "explore a collaboration",
};

// Pull one truthful, specific detail we actually observed.
function truthfulDetail(p, icp) {
  const kws = (icp && icp.keywords ? icp.keywords : []).map((k) => k.toLowerCase());
  const bio = (p.bio || "").toLowerCase();
  const hitKw = kws.find((k) => k && bio.includes(k));
  if (hitKw) return `your work in ${hitKw}`;
  if (p.category) return `what you're doing in ${p.category}`;
  if (p.linkInBio) return `your links in bio`;
  if (typeof p.followers === "number" && p.followers > 0) return `your Instagram presence`;
  return `your profile`;
}

export function buildDraft(profile, icp, objective = "networking", opts = {}) {
  const senderName = (opts.businessName || "").trim();
  const detail = truthfulDetail(profile, icp);
  const intent = OBJECTIVES[objective] || OBJECTIVES.networking;
  // Fall back to the handle, the way renderTemplate's {first_name} already did.
  // With no display name this produced a bare "Hi" and the draft opened "Hi —
  // came across your links in bio", which reads as a broken mail-merge to the
  // person receiving it. A handle is a real thing to call someone; an em dash
  // with nothing in front of it is not.
  const name = profile.displayName && profile.displayName !== profile.username
    ? profile.displayName.split(" ")[0]
    : (profile.username || "");
  const greeting = name ? `Hi ${name}` : "Hi";
  const signoff = senderName ? `\n\n— ${senderName}` : "";

  // One detail, one reason, one question. Kept under ~500 chars.
  const text =
    `${greeting} — came across ${detail} and wanted to reach out. ` +
    `I think there may be a good reason for us to ${intent}. ` +
    `Would you be open to a quick chat this week?${signoff}`;

  return text.trim();
}

export const OBJECTIVE_OPTIONS = [
  { value: "networking", label: "Networking opener" },
  { value: "sales", label: "Sales discovery" },
  { value: "partnership", label: "Partnership" },
  { value: "affiliate", label: "Affiliate invite" },
  { value: "creator", label: "Creator collab" },
];
