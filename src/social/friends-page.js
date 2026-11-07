// /friends/: sign in, then the feed, your loops and your friends.

import { api, at, authClient, busy, h, signIn, toast, whoAmI } from "./api.js";
import { loopList } from "./feed.js";
import { friendsView } from "./friends.js";
import { stopLoop } from "./player.js";
import { clearPendingInvite, pendingInvite } from "./store.js";

const $ = (id) => document.getElementById(id);
const TABS = ["feed", "mine", "friends"];

function signedOut(message) {
  $("signed-out").hidden = false;
  const button = $("sign-in");
  if (message) {
    // Accounts aren't reachable (switched off, or the server is down): say so.
    button.hidden = true;
    $("sign-in-error").textContent = message;
    return;
  }
  authClient(); // load the passkey helper while they read
  button.addEventListener("click", () =>
    busy(button, async () => {
      $("sign-in-error").textContent = "";
      const error = await signIn();
      if (error) return ($("sign-in-error").textContent = error);
      location.reload();
    }),
  );
}

/** An invite opened before this person had an account: offer it now. */
async function offerPendingInvite(me, reload) {
  const code = pendingInvite();
  if (!code) return;
  const res = await api(`/irl/invite?code=${encodeURIComponent(code)}`);
  const inviter = res.body.inviter;
  if (!res.ok || !inviter || inviter.handle === me.handle) {
    if (res.status !== 429 && res.status !== 0) clearPendingInvite();
    return;
  }
  const notice = $("invite-notice");
  const name = at(inviter.handle);
  const add = h("button", { class: "btn primary small", type: "button" }, `Add ${name}`);
  add.addEventListener("click", () =>
    busy(add, async () => {
      const accepted = await api("/irl/invites/accept", { code });
      if (!accepted.ok) return toast(accepted.message);
      clearPendingInvite();
      notice.hidden = true;
      toast(`You and ${name} are friends.`);
      reload();
    }),
  );
  notice.replaceChildren(h("p", {}, `${name} invited you.`), add);
  notice.hidden = false;
}

function signedIn(me) {
  $("me").hidden = false;
  $("me-handle").textContent = at(me.handle);
  $("app").hidden = false;

  const badge = $("badge");
  const showRequests = (count) => {
    badge.hidden = !count;
    badge.replaceChildren(String(count), h("span", { class: "sr" }, count === 1 ? " request" : " requests"));
  };
  const views = {};
  const reloadLoops = () => {
    views.feed.load();
    if (views.mine.loaded) views.mine.load();
  };
  views.feed = loopList({ panel: $("feed-panel"), kind: "feed", onChanged: (what) => (what === "blocked" ? views.friends.load() : reloadLoops()) });
  views.mine = loopList({ panel: $("mine-panel"), kind: "mine", onChanged: reloadLoops });
  views.friends = friendsView({
    panel: $("friends-panel"),
    onChanged: (count, what) => {
      showRequests(count);
      if (what && what !== "added" && what !== "declined") views.feed.load();
    },
  });

  function show() {
    const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "feed";
    stopLoop();
    for (const name of TABS) {
      const link = document.querySelector(`.tabs a[href="#${name}"]`);
      $(`${name}-panel`).hidden = name !== tab;
      if (name === tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (tab === "mine" && !views.mine.loaded) views.mine.load();
    if (tab === "friends" && opened) views.friends.load(); // requests may have come in
  }
  let opened = false;
  addEventListener("hashchange", show);
  show();
  opened = true;
  views.feed.load();
  views.friends.load();
  offerPendingInvite(me, () => {
    views.friends.load();
    views.feed.load();
  });
}

const { me, signedOut: out, message } = await whoAmI();
$("boot").remove();
if (me) signedIn(me);
else signedOut(out ? null : message);
