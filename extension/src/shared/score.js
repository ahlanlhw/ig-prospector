// Sprill — local fit scoring (M0).
//
// Deterministic keyword-overlap scorer against the user's ICP. Transparent by
// design: every score carries the evidence that produced it. At M1 this is
// replaced by the Gemini classifier (same shape: { score, reasons, concerns }),
// so the panel UI doesn't change.

export function computeScore(profile, icp) {
  // Thin data (e.g. a handle scanned from a followers list with no bio) can't
  // be scored honestly — flag it for enrichment instead of a misleading number.
  const hasText = !!(profile.bio || profile.category || (profile.links && profile.links.length));
  if (!hasText) {
    return {
      score: null,
      band: "Needs enrich",
      reasons: [],
      concerns: ["No bio captured yet — open/enrich the profile to score it"],
    };
  }

  const keywords = (icp && icp.keywords ? icp.keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);

  const haystacks = {
    bio: (profile.bio || "").toLowerCase(),
    name: (profile.displayName || "").toLowerCase(),
    category: (profile.category || "").toLowerCase(),
    links: (profile.links || []).join(" ").toLowerCase(),
  };

  const reasons = [];
  const concerns = [];
  let matches = 0;

  for (const kw of keywords) {
    const where = [];
    for (const [field, text] of Object.entries(haystacks)) {
      if (text && text.includes(kw)) where.push(field);
    }
    if (where.length) {
      matches += 1;
      reasons.push(`Matches "${kw}" (${where.join(", ")})`);
    }
  }

  // Base scoring: reward keyword coverage, lightly reward reachability + reach.
  let score = 0;
  if (keywords.length) {
    score += Math.round((matches / keywords.length) * 70); // up to 70 for ICP fit
  } else {
    score += 35; // no ICP set yet — neutral midpoint
    concerns.push("No ICP keywords set — add them in Settings for real ranking");
  }

  // Contactability (up to 15)
  const reachable =
    (profile.linkInBio ? 1 : 0) +
    ((profile.emails || []).length ? 1 : 0) +
    ((profile.links || []).length ? 1 : 0) +
    ((profile.publicContactButtons || []).length ? 1 : 0);
  score += Math.min(15, reachable * 5);
  if (reachable) reasons.push("Has a public contact path");
  else concerns.push("No public contact found");

  // Commercial intent from bio phrases ("DM for business enquiries", etc.)
  if (profile.businessSignals && profile.businessSignals.length) {
    score += Math.min(12, profile.businessSignals.length * 6);
    reasons.push(`Business intent: ${profile.businessSignals.slice(0, 2).join(", ")}`);
  }

  // Reach / authority (up to 15), gentle log curve
  const f = profile.followers || 0;
  if (f > 0) {
    const reach = Math.min(15, Math.round((Math.log10(f + 1) / 6) * 15));
    score += reach;
  }

  // Data confidence penalty if we barely extracted anything.
  //
  // Keyed on bio+category since 0.18.0, previously bio+followers.
  //
  // To be clear about what this is NOT: it is not load-bearing for the Explore
  // embed scan. That was the worry when it was written, and it was wrong — an
  // Explore lead carries a follower count and nothing else, so it never reaches
  // this line at all. `hasText` at the top of this function gates on
  // bio||category||links and ignores followers entirely, so those leads take the
  // early return and come back "Needs enrich" either way. Verified, not assumed.
  //
  // The change is worth keeping on its own terms. This line is only reachable
  // when there IS a category or a link, and in that window `followers` was the
  // wrong thing to consult: a follower count is a number about an account, not
  // text extracted FROM it, so letting it stand in for "we read enough" meant a
  // lead with a link and a follower count but no bio and no category looked
  // fine. bio and category are what actually feed the DM and the fit judgement.
  if (!profile.bio && !profile.category) {
    concerns.push("Thin data extracted — open the profile to enrich");
  }

  score = Math.max(0, Math.min(100, score));

  let band = "Low fit";
  if (score >= 75) band = "High fit";
  else if (score >= 50) band = "Medium fit";

  return { score, band, reasons, concerns };
}
