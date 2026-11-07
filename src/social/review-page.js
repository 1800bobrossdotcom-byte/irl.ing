// /review/: the human review queue. Held and reported loops, each with its
// three stills, the AI review and its reports. Child-safety escalations are
// never previewed here.

import { api, at, busy, h, signIn, toast } from "./api.js";
import { REPORT_LABELS } from "./reasons.js";
import { confirmAction } from "./sheet.js";

const main = document.getElementById("main");
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const ACTIONS = [
  { action: "restore", label: "Restore", done: "Restored." },
  { action: "remove", label: "Remove", done: "Removed." },
  { action: "remove_strike", label: "Remove + strike", done: "Removed, with a strike." },
  { action: "escalate", label: "Escalate", done: "Escalated." },
];
const plain = (text) => String(text).replaceAll("_", " ").replace(/:/g, " · ");

function gate(canSignIn, message) {
  const error = h("p", { class: "error", role: "alert" }, message ?? "");
  const button = canSignIn ? h("button", { class: "btn primary", type: "button" }, "Sign in") : null;
  button?.addEventListener("click", () =>
    busy(button, async () => {
      error.textContent = "";
      const failed = await signIn();
      if (failed) return (error.textContent = failed);
      load();
    }),
  );
  main.replaceChildren(h("section", { class: "hello" }, h("h1", {}, "Reviewers only", h("span", { class: "dot" }, ".")), button, error));
}

async function decide(item, { action, done }, buttons) {
  if (
    action === "escalate" &&
    !(await confirmAction({
      title: "Escalate as child safety?",
      note: `The loop is hidden and kept for reporting, and ${at(item.handle)} gets a strike. It can’t be restored here.`,
      action: "Escalate",
    }))
  )
    return;
  for (const b of buttons) b.disabled = true;
  const res = await api("/irl/admin/decide", { id: item.id, action });
  for (const b of buttons) b.disabled = false;
  if (!res.ok) return toast(res.message);
  toast(done);
  load();
}

function moderation(m) {
  if (!m) return null;
  return h(
    "div",
    { class: "ai" },
    h("p", { class: "label" }, "AI review"),
    m.summary ? h("p", {}, m.summary) : null,
    m.flags?.length ? h("ul", { class: "flags" }, m.flags.map((f) => h("li", {}, `${plain(f.category)} · ${f.severity}: ${f.reason}`))) : null,
    m.reasons?.length ? h("p", { class: "muted" }, m.reasons.map(plain).join(", ")) : null,
  );
}

function card(item) {
  const head = h("div", { class: "case-head" }, h("span", { class: "handle" }, item.handle ? at(item.handle) : "Deleted account"), h("span", { class: "muted" }, `${item.status === "held" ? "Held" : "Showing"} · ${day.format(new Date(item.createdAt))}`));
  const buttons = [];
  const button = (spec) => {
    const look = spec.action === "restore" ? "primary" : spec.action === "escalate" ? "ghost danger" : "ghost";
    const b = h("button", { class: `btn small ${look}`, type: "button", onclick: () => decide(item, spec, buttons) }, spec.label);
    buttons.push(b);
    return b;
  };
  if (item.escalated) {
    return h("li", { class: "case escalated", dataset: { id: item.id } }, head, h("p", { class: "escalation" }, "Child-safety escalation"), h("div", { class: "row-actions" }, button(ACTIONS[1])));
  }
  const reports = item.reports ?? [];
  return h(
    "li",
    { class: "case", dataset: { id: item.id } },
    head,
    h(
      "div",
      { class: "stills" },
      (item.frames ?? []).map((src, n) => h("img", { src, alt: ["Start", "Middle", "End"][n], decoding: "async" })),
    ),
    moderation(item.moderation),
    reports.length
      ? h(
          "div",
          { class: "reports" },
          h("p", { class: "label" }, reports.length === 1 ? "1 report" : `${reports.length} reports`),
          h("ul", {}, reports.map((r) => h("li", {}, REPORT_LABELS[r.reason] ?? plain(r.reason), r.note ? h("span", { class: "muted" }, ` — “${r.note}”`) : null))),
        )
      : null,
    h("div", { class: "row-actions" }, ACTIONS.map(button)),
  );
}

async function load() {
  const res = await api("/irl/admin/queue");
  if (res.status === 401) return gate(true);
  if (res.status === 403) return gate(false);
  if (!res.ok) return main.replaceChildren(h("p", { class: "error", role: "alert" }, res.message));
  const { items } = res.body;
  main.replaceChildren(
    h("h1", { class: "sr" }, "Review queue"),
    items.length ? h("ul", { class: "cases", role: "list" }, items.map(card)) : h("p", { class: "end" }, "Nothing to review", h("span", { class: "dot" }, ".")),
  );
}

load();
