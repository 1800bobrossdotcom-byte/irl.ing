// /i/<code>: someone shared an invite. Signed in, one tap makes you friends.
// Signed out, the code is kept on this device while you make an @name (or
// sign in, which accepts it straight away).

import { api, at, authClient, busy, h, signIn, whoAmI } from "./api.js";
import { clearPendingInvite, savePendingInvite } from "./store.js";

const $ = (id) => document.getElementById(id);
const EXPIRED = "This invite has expired.";

const code = location.pathname.match(/^\/i\/([A-Za-z0-9_-]{1,32})\/?$/)?.[1] ?? new URLSearchParams(location.search).get("code") ?? "";

function headline(text) {
  const title = $("title");
  title.replaceChildren(text.replace(/\.$/, ""), h("span", { class: "dot" }, "."));
  document.title = `irl.ing — ${text}`;
}

function done(inviter) {
  clearPendingInvite();
  headline(`You and ${at(inviter.handle)} are friends.`);
  $("actions").replaceChildren(h("a", { class: "btn primary", href: "/friends/" }, "Open your feed"));
  $("error").textContent = "";
  $("title").focus();
}

function ownInvite() {
  clearPendingInvite();
  $("actions").replaceChildren(h("p", {}, "That’s your own invite."), h("a", { class: "btn ghost", href: "/friends/" }, "Open your feed"));
}

async function accept() {
  const res = await api("/irl/invites/accept", { code });
  if (!res.ok) {
    $("error").textContent = res.status === 404 ? EXPIRED : res.message;
    return;
  }
  done(res.body.friend);
}

async function start() {
  if (!code) return headline(EXPIRED);
  const [lookup, who] = await Promise.all([api(`/irl/invite?code=${encodeURIComponent(code)}`), whoAmI()]);
  if (!lookup.ok) {
    if (lookup.status === 404) {
      clearPendingInvite();
      return headline(EXPIRED);
    }
    headline("Invite");
    $("error").textContent = lookup.message;
    return;
  }
  const { inviter } = lookup.body;
  const name = at(inviter.handle);
  headline(`${name} invited you.`);
  const actions = $("actions");

  if (who.me) {
    if (who.me.handle === inviter.handle) return ownInvite();
    const add = h("button", { class: "btn primary", type: "button" }, `Add ${name}`);
    add.addEventListener("click", () => busy(add, accept));
    actions.replaceChildren(add);
    return;
  }
  if (!who.signedOut) {
    $("error").textContent = who.message; // accounts aren't reachable
    return;
  }

  savePendingInvite(code);
  authClient(); // load the passkey helper while they decide
  const make = h("a", { class: "btn rec", href: `/loops/?invite=${encodeURIComponent(code)}` }, "Make your @name");
  const signInButton = h("button", { class: "btn ghost", type: "button" }, "Sign in");
  signInButton.addEventListener("click", () =>
    busy(signInButton, async () => {
      $("error").textContent = "";
      const error = await signIn();
      if (error) return ($("error").textContent = error);
      const now = await whoAmI();
      if (now.me?.handle === inviter.handle) return ownInvite();
      await accept();
    }),
  );
  actions.replaceChildren(make, signInButton);
}

start();
