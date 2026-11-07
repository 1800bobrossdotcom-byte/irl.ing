// Report reasons, in plain words. The keys are REPORT_REASONS in
// src/server/social.js (tests/social-screens.test.js keeps the two in step).

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
