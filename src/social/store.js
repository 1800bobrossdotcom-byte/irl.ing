// Small things this browser remembers for one person: an invite code they
// opened before having an account, and loops they reported (hidden from
// their own feed). Storage can be blocked or cleared, so every access is
// guarded and everything works without it.

const INVITE_KEY = "irl.invite";
const HIDDEN_KEY = "irl.hidden";
const MAX_HIDDEN = 300;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: nothing to remember, nothing breaks.
  }
}

/** Remember an invite code until the person has an account to accept it with. */
export const savePendingInvite = (code) => write(INVITE_KEY, code);
export const pendingInvite = () => read(INVITE_KEY);
export const clearPendingInvite = () => write(INVITE_KEY, null);

/** IDs of loops this person reported, so they don't see them again. */
export function hiddenLoops() {
  try {
    const ids = JSON.parse(read(HIDDEN_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

export function hideLoop(id) {
  const ids = [...hiddenLoops(), id].slice(-MAX_HIDDEN);
  write(HIDDEN_KEY, JSON.stringify(ids));
}
