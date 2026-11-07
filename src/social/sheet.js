// One bottom sheet (a modal <dialog>) for every menu and confirmation on a
// page. It keeps focus inside while open, closes on Escape or a tap outside,
// and hands focus back to whatever opened it.

import { h } from "./api.js";

let dialog = null;
let settle = null;

function sheet() {
  if (dialog) return dialog;
  dialog = h("dialog", { class: "sheet", "aria-labelledby": "sheet-title" });
  // The close event arrives a task later; by then a follow-up sheet (say,
  // report reasons after "Report") may already be open, and must stay so.
  dialog.addEventListener("close", () => dialog.open || finish(null));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close(); // the backdrop
  });
  document.body.append(dialog);
  return dialog;
}

function finish(value) {
  const done = settle;
  settle = null;
  done?.(value);
}

/** Show a list of choices. Resolves to the chosen option's value, or null. */
export function choose({ title, note, options }) {
  const d = sheet();
  finish(null); // a sheet that was already open is answered with "nothing"
  const opener = document.activeElement;
  const pick = (value) => {
    finish(value);
    d.close();
  };
  d.replaceChildren(
    ...[
      h("h2", { id: "sheet-title" }, title),
      note && h("p", { class: "sheet-note" }, note),
      h(
        "div",
        { class: "sheet-options" },
        options.map((o) => h("button", { type: "button", class: o.danger ? "danger" : "", onclick: () => pick(o.value) }, o.label)),
      ),
      h("button", { type: "button", class: "sheet-cancel", onclick: () => pick(null) }, "Cancel"),
    ].filter(Boolean),
  );
  return new Promise((resolve) => {
    settle = (value) => {
      if (opener?.isConnected) opener.focus();
      resolve(value);
    };
    if (!d.open) d.showModal();
    d.querySelector(".sheet-options button")?.focus();
  });
}

/** Ask before something that can't be undone. Resolves true to go ahead. */
export async function confirmAction({ title, note, action }) {
  return (await choose({ title, note, options: [{ label: action, value: true, danger: true }] })) === true;
}
