// Report reasons, in plain words. Shared by the screens and the server
// (src/server/social.js accepts exactly these keys).

export const REPORT_LABELS = {
  child_safety: "Child safety",
  sexual: "Sexual content",
  violence: "Violence",
  self_harm: "Self-harm",
  hate: "Hate",
  harassment: "Harassment",
  privacy: "Privacy",
  scam: "Scam",
  other: "Something else",
};

export const REPORT_REASONS = Object.keys(REPORT_LABELS);
