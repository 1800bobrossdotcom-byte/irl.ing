// The Friends view: requests to answer, your friends (and requests you
// sent), adding someone by exact @name, and invite links with a QR code.

import { api, at, busy, dotsIcon, h, toast } from "./api.js";
import { qrSvg } from "./qr.js";
import { choose, confirmAction } from "./sheet.js";

/** onChanged(incomingCount, what) runs after every load and change. */
export function friendsView({ panel, onChanged }) {
  const requests = h("div");
  const list = h("div");
  const blocked = h("div");

  // ---- add by @name ----------------------------------------------------------
  const input = h("input", { id: "add-handle", name: "handle", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: "21", required: true, "aria-describedby": "add-note" });
  const note = h("p", { class: "note", id: "add-note", role: "status" });
  const addButton = h("button", { class: "btn primary", type: "submit" }, "Add");
  const add = h(
    "form",
    { class: "block", novalidate: true },
    h("label", { class: "label", for: "add-handle" }, "Add by @name"),
    h("div", { class: "handle-field" }, h("span", { "aria-hidden": "true" }, "@"), input, addButton),
    note,
  );
  add.addEventListener("submit", (event) => {
    event.preventDefault();
    const handle = input.value.trim().replace(/^@/, "");
    if (!handle) return (note.textContent = "Type their @name.");
    note.textContent = "";
    busy(addButton, async () => {
      const res = await api("/irl/friends/request", { handle });
      if (!res.ok) return (note.textContent = res.message);
      note.textContent = res.body.status === "friends" ? `You and ${at(handle)} are friends.` : `Request sent to ${at(handle)}.`;
      input.value = "";
      await load("added");
    });
  });

  // ---- invite links ------------------------------------------------------------
  const inviteNote = h("p", { class: "note", id: "invite-note", role: "status" });
  const makeInvite = h("button", { class: "btn ghost", type: "button" }, "Make an invite link");
  const invite = h("section", { class: "block", "aria-labelledby": "invite-title" }, h("h2", { class: "label", id: "invite-title" }, "Invite"), makeInvite, inviteNote);
  makeInvite.addEventListener("click", () =>
    busy(makeInvite, async () => {
      inviteNote.textContent = "";
      const res = await api("/irl/invites", {});
      if (!res.ok) return (inviteNote.textContent = res.message);
      makeInvite.replaceWith(inviteCard(res.body.url));
    }),
  );

  function inviteCard(url) {
    const field = h("input", { class: "invite-url", readonly: true, value: url, "aria-label": "Invite link", onfocus: () => field.select() });
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        field.select();
        document.execCommand?.("copy");
      }
      inviteNote.textContent = "Copied.";
    };
    const share = async () => {
      try {
        await navigator.share({ title: "irl.ing", text: "Add me on irl.ing.", url });
      } catch (error) {
        if (error?.name !== "AbortError") copy();
      }
    };
    return h(
      "div",
      { class: "invite-card" },
      field,
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: copy }, "Copy"),
        navigator.share ? h("button", { class: "btn ghost", type: "button", onclick: share }, "Share") : null,
      ),
      inviteNote, // moved up from under the button, next to Copy
      qrSvg(url, "QR code for your invite link"),
    );
  }

  // ---- lists -----------------------------------------------------------------------
  async function respond(handle, accept, button) {
    await busy(button, async () => {
      const res = await api("/irl/friends/respond", { handle, accept });
      if (!res.ok) return toast(res.message);
      toast(accept ? `You and ${at(handle)} are friends.` : "Declined.");
      await load(accept ? "accepted" : "declined");
    });
  }

  async function menu(handle) {
    const name = at(handle);
    const choice = await choose({
      title: name,
      options: [
        { label: `Remove ${name}`, value: "remove" },
        { label: `Block ${name}`, value: "block", danger: true },
      ],
    });
    if (!choice) return;
    const ask =
      choice === "remove"
        ? { title: `Remove ${name}?`, note: "You’ll stop seeing each other’s loops.", action: "Remove" }
        : { title: `Block ${name}?`, note: "You won’t see each other’s loops, and they can’t add you.", action: `Block ${name}` };
    if (!(await confirmAction(ask))) return;
    const res = await api(choice === "remove" ? "/irl/friends/remove" : "/irl/block", { handle });
    if (!res.ok) return toast(res.message);
    toast(choice === "remove" ? `Removed ${name}.` : `Blocked ${name}.`);
    await load(choice === "remove" ? "removed" : "blocked");
  }

  function render({ friends, incoming, outgoing }) {
    requests.replaceChildren(
      incoming.length
        ? h(
            "section",
            { class: "block", "aria-labelledby": "requests-title" },
            h("h2", { class: "label", id: "requests-title" }, "Requests"),
            h(
              "ul",
              { class: "rows", role: "list" },
              incoming.map((f) => {
                const accept = h("button", { class: "btn small primary", type: "button", "aria-label": `Accept ${at(f.handle)}`, onclick: () => respond(f.handle, true, accept) }, "Accept");
                const decline = h("button", { class: "btn small ghost", type: "button", "aria-label": `Decline ${at(f.handle)}`, onclick: () => respond(f.handle, false, decline) }, "Decline");
                return h("li", { class: "row" }, h("span", { class: "handle" }, at(f.handle)), h("span", { class: "row-actions" }, accept, decline));
              }),
            ),
          )
        : "",
    );
    const rows = [
      ...friends.map((f) =>
        h(
          "li",
          { class: "row" },
          h("span", { class: "handle" }, at(f.handle)),
          h("button", { class: "more", type: "button", "aria-label": `Options for ${at(f.handle)}`, "aria-haspopup": "dialog", onclick: () => menu(f.handle) }, dotsIcon()),
        ),
      ),
      ...outgoing.map((f) => h("li", { class: "row" }, h("span", { class: "handle" }, at(f.handle)), h("span", { class: "muted" }, "Pending"))),
    ];
    list.replaceChildren(
      h(
        "section",
        { class: "block", "aria-labelledby": "friends-title" },
        h("h2", { class: "label", id: "friends-title" }, "Friends"),
        rows.length ? h("ul", { class: "rows", role: "list" }, rows) : h("p", { class: "empty" }, "No friends yet."),
      ),
    );
  }

  function renderBlocked(people) {
    blocked.replaceChildren(
      people.length
        ? h(
            "section",
            { class: "block", "aria-labelledby": "blocked-title" },
            h("h2", { class: "label", id: "blocked-title" }, "Blocked"),
            h(
              "ul",
              { class: "rows", role: "list" },
              people.map((p) => {
                const unblock = h("button", { class: "btn ghost", type: "button" }, "Unblock");
                unblock.addEventListener("click", () =>
                  busy(unblock, async () => {
                    const res = await api("/irl/unblock", { handle: p.handle });
                    if (!res.ok) return toast(res.message);
                    toast(`Unblocked ${at(p.handle)}.`);
                    await load("unblocked");
                  }),
                );
                return h("li", { class: "row" }, h("span", { class: "handle" }, at(p.handle)), unblock);
              }),
            ),
          )
        : "",
    );
  }

  async function load(what) {
    const [res, blocks] = await Promise.all([api("/irl/friends"), api("/irl/blocks")]);
    if (!res.ok) {
      requests.replaceChildren(h("p", { class: "error", role: "alert" }, res.message));
      return;
    }
    render(res.body);
    renderBlocked(blocks.ok ? blocks.body.blocked : []);
    onChanged?.(res.body.incoming.length, what);
  }

  panel.replaceChildren(requests, add, invite, list, blocked);
  return { load };
}
