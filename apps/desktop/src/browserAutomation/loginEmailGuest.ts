import { ipcRenderer } from "electron";
import { BROWSER_IPC_CHANNELS } from "../ipcChannels";
import { isLoginEmail } from "./loginEmail";

function loginField(target: EventTarget | undefined): target is HTMLInputElement {
  if (
    !(target instanceof HTMLInputElement) ||
    (target.type !== "email" && target.type !== "text") ||
    target.disabled ||
    target.readOnly ||
    target.multiple ||
    target.autocomplete === "off" ||
    target.form?.autocomplete === "off"
  )
    return false;
  const tokens = target.autocomplete.split(/\s+/u);
  if (tokens.includes("username")) return true;
  if (target.autocomplete && target.autocomplete !== "on" && !tokens.includes("email"))
    return false;
  if (target.type !== "email" && !tokens.includes("email")) return false;
  return Boolean(target.form?.querySelector('input[type="password"]'));
}

if (
  window === window.top &&
  window.isSecureContext &&
  (location.protocol === "https:" || location.protocol === "http:")
) {
  const edited = new WeakMap<HTMLFormElement, { field: HTMLInputElement; value: string }>();
  window.addEventListener(
    "input",
    (event) => {
      const field = event.composedPath()[0];
      if (event.isTrusted && loginField(field) && field.form) {
        if (isLoginEmail(field.value)) edited.set(field.form, { field, value: field.value });
        else edited.delete(field.form);
      }
    },
    true,
  );
  window.addEventListener(
    "submit",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof HTMLFormElement)) return;
      const edit = edited.get(event.target);
      if (
        !edit ||
        !loginField(edit.field) ||
        edit.field.form !== event.target ||
        edit.field.value !== edit.value
      )
        return;
      edited.delete(event.target);
      ipcRenderer.send(BROWSER_IPC_CHANNELS.email.remember, edit.value);
    },
    true,
  );

  let pending = false;
  const show = async (event: Event) => {
    const field = event.composedPath()[0];
    if (pending || !event.isTrusted || !loginField(field) || !field.matches(":focus")) return;
    pending = true;
    const prefix = field.value;
    try {
      const email: unknown = await ipcRenderer.invoke(BROWSER_IPC_CHANNELS.email.choose, prefix);
      // The menu can outlive a field, form rerender, or change of focus.
      if (
        typeof email !== "string" ||
        !loginField(field) ||
        !field.matches(":focus") ||
        field.value !== prefix
      )
        return;
      field.value = email;
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      // The tab may have detached while the native menu was open.
    } finally {
      pending = false;
    }
  };
  window.addEventListener(
    "click",
    (event) => {
      if (event.button === 0) void show(event);
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "ArrowDown" && !event.isComposing) void show(event);
    },
    true,
  );
}
