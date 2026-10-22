// Sprill — template rendering with merge fields.
// Supported fields: {first_name} {name} {handle} {followers} {category}
// {topic} {business} {link}

export const MERGE_FIELDS = [
  "{first_name}", "{name}", "{handle}", "{followers}",
  "{category}", "{topic}", "{business}", "{link}",
];

// Pick a truthful "topic" for the prospect from ICP overlap → category → fallback.
export function topicFor(profile, icp) {
  const kws = (icp && icp.keywords ? icp.keywords : []).map((k) => String(k).toLowerCase());
  const bio = (profile.bio || "").toLowerCase();
  const hit = kws.find((k) => k && bio.includes(k));
  if (hit) return hit;
  if (profile.category) return profile.category;
  return "your work";
}

export function renderTemplate(body, profile, opts = {}) {
  const first = (profile.displayName && profile.displayName !== profile.username)
    ? profile.displayName.split(/\s+/)[0]
    : (profile.username || "there");
  const map = {
    "{first_name}": first,
    "{name}": profile.displayName || profile.username || "",
    "{handle}": "@" + (profile.username || ""),
    "{followers}": profile.followers != null ? String(profile.followers) : "",
    "{category}": profile.category || "creator",
    "{topic}": opts.topic || topicFor(profile, opts.icp || {}),
    "{business}": opts.business || "",
    "{link}": profile.linkInBio || (profile.links && profile.links[0]) || "",
  };
  let out = String(body || "");
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out.trim();
}
