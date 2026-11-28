import { ipcRenderer } from "electron";
import { BROWSER_IPC_CHANNELS } from "../ipcChannels";
import { isLoginEmail, type LoginFieldChoice, type LoginFieldChoiceRequest } from "./loginEmail";

const SIGN_IN =
  /(?:^|[^a-z])(?:log[\s_-]?(?:in|on)|sign[\s_-]?in|authenticate|accedi|connexion|anmelden)(?:$|[^a-z])/iu;
const OTHER_FORM =
  /newsletter|subscri(?:be|ption)|sign[\s_-]?up|register|registration|create[\s_-]?(?:an?[\s_-]?)?account|checkout|shipping|billing|contact|forgot|reset|recover|change[\s_-]?(?:your[\s_-]?)?password|registrati|iscriviti/iu;
const NEXT = /^(?:continue|next|proceed|continua|avanti|suivant|weiter)(?:\s|$)/iu;
const ACCOUNT_FIELD_NAME = /^(?:email|e-mail|emailaddress|user_?name|login(?:fmt)?|identifier)$/iu;

function scopeOf(field: Element): Element {
  return (
    field.closest("form, [role=form], dialog, [role=dialog], main, [role=main]") ?? document.body
  );
}

function ownerOf(field: HTMLInputElement): Element {
  return field.form ?? scopeOf(field);
}

function available(field: HTMLInputElement): boolean {
  return (
    field.isConnected &&
    !field.disabled &&
    !field.readOnly &&
    !field.multiple &&
    field.autocomplete !== "off" &&
    field.form?.autocomplete !== "off" &&
    !field.closest("[inert]") &&
    field.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  );
}

function identityHint(field: HTMLInputElement): boolean {
  if (field.type !== "email" && field.type !== "text") return false;
  const tokens = field.autocomplete.split(/\s+/u);
  if (tokens.includes("username") || tokens.includes("email")) return true;
  if (field.autocomplete && field.autocomplete !== "on") return false;
  return (
    field.type === "email" ||
    field.inputMode === "email" ||
    ACCOUNT_FIELD_NAME.test(field.name) ||
    ACCOUNT_FIELD_NAME.test(field.id)
  );
}

function buttonText(button: Element): string {
  return (
    button.getAttribute("aria-label") ??
    (button instanceof HTMLInputElement && ["button", "submit", "reset"].includes(button.type)
      ? button.value
      : button.textContent) ??
    ""
  ).trim();
}

function formContext(field: HTMLInputElement) {
  const scope = ownerOf(field);
  const form = field.form;
  const controls = form
    ? Array.from(form.elements)
    : Array.from(scope.querySelectorAll("input, button, [role=button]")).filter(
        (el) => scopeOf(el) === scope,
      );
  const inputs = controls.filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
  const buttons = controls.filter((el) => el.matches("button, [role=button], input[type=submit]"));
  const singleForm = document.querySelectorAll("form, [role=form]").length <= 1;
  const action = form?.getAttribute("action");
  const heading =
    scope.querySelector("legend, h1, h2, [role=heading]")?.textContent ??
    (singleForm ? document.querySelector("h1, [role=heading]")?.textContent : "");
  const localHints = [
    scope.id,
    scope.getAttribute("name"),
    scope.getAttribute("aria-label"),
    action ? URL.parse(action, document.baseURI)?.pathname : "",
    heading,
    ...buttons.map(buttonText),
  ].join(" ");
  if (OTHER_FORM.test(localHints) || OTHER_FORM.test(location.pathname)) return null;
  const identities = inputs.filter((input) => identityHint(input) && available(input));
  const passwords = inputs.filter((input) => input.type === "password");
  const username = identities.length === 1 ? identities[0] : undefined;
  const namedUsername =
    username?.autocomplete.split(/\s+/u).includes("username") ||
    /^(?:user_?name|login(?:fmt)?)$/iu.test(username?.name ?? "");
  const signIn =
    SIGN_IN.test(localHints) ||
    (singleForm && (SIGN_IN.test(location.pathname) || SIGN_IN.test(document.title))) ||
    namedUsername;
  const password = passwords.length === 1 ? passwords[0] : undefined;
  const tokens = password?.autocomplete.split(/\s+/u) ?? [];
  const current = tokens.includes("current-password");
  if (passwords.length > 1 || tokens.includes("new-password") || identities.length > 1) return null;
  if (!signIn && !current && !(username && password)) return null;
  const endpoints = [
    form?.action ?? location.href,
    ...controls
      .filter((el) => el.hasAttribute("formaction"))
      .map((el) => URL.parse(el.getAttribute("formaction")!, document.baseURI)?.href ?? ""),
  ];
  const sameOrigin = endpoints.every((url) => URL.parse(url)?.origin === location.origin);
  const acceptsPassword = Boolean(
    password &&
    available(password) &&
    sameOrigin &&
    (current || (signIn && (!password.autocomplete || password.autocomplete === "on"))),
  );
  // An email-first site can carry the selected account into the password step
  // in a read-only or hidden username field. Only use explicit account metadata.
  const boundUsernames = inputs
    .filter(
      (input) =>
        input !== username &&
        ((input.type === "hidden" &&
          (input.autocomplete === "username" || /^(?:username|email)$/iu.test(input.name))) ||
          ((input.readOnly || input.disabled) && identityHint(input))),
    )
    .map((input) => input.value)
    .filter(Boolean);
  if (new Set(boundUsernames).size > 1) return null;
  return {
    scope,
    username,
    boundUsername: boundUsernames[0],
    password: acceptsPassword ? password : undefined,
    actions: endpoints.join("\n"),
  };
}

function fill(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

if (
  window === window.top &&
  window.isSecureContext &&
  (location.protocol === "https:" || location.protocol === "http:")
) {
  const edited = new WeakMap<Element, { field: HTMLInputElement; value: string }>();
  const filledPasswords = new Set<WeakRef<HTMLInputElement>>();
  let documentGeneration = 0;
  window.addEventListener(
    "pagehide",
    () => {
      documentGeneration++;
      // A page restored from Chromium's back/forward cache can reuse the same DOM.
      for (const reference of filledPasswords) {
        const field = reference.deref();
        if (field) field.value = "";
      }
      filledPasswords.clear();
    },
    true,
  );
  const remember = (scope: Element) => {
    const edit = edited.get(scope);
    if (!edit) return;
    edited.delete(scope);
    if (
      ownerOf(edit.field) === scope &&
      identityHint(edit.field) &&
      formContext(edit.field)?.username === edit.field &&
      edit.field.value === edit.value
    ) {
      ipcRenderer.send(BROWSER_IPC_CHANNELS.email.remember, edit.value);
    }
  };
  window.addEventListener(
    "input",
    (event) => {
      const field = event.composedPath()[0];
      if (!event.isTrusted || !(field instanceof HTMLInputElement) || !identityHint(field)) return;
      const owner = ownerOf(field);
      if (isLoginEmail(field.value)) edited.set(owner, { field, value: field.value });
      else edited.delete(owner);
    },
    true,
  );
  window.addEventListener(
    "submit",
    (event) => {
      if (event.isTrusted && event.target instanceof HTMLFormElement) remember(event.target);
    },
    true,
  );

  let pending = false;
  const show = async (event: Event) => {
    const field = event.composedPath()[0];
    if (
      pending ||
      !event.isTrusted ||
      !(field instanceof HTMLInputElement) ||
      !field.matches(":focus") ||
      (!identityHint(field) && field.type !== "password")
    )
      return;
    const generation = documentGeneration;
    const before = formContext(field);
    if (!before || (field !== before.username && field !== before.password)) return;
    const passwordField = field === before.password;
    if (passwordField && field.value) return;
    const originalUsername = before.username?.value ?? "";
    const knownUsername = before.boundUsername || originalUsername;
    if (before.boundUsername && originalUsername && before.boundUsername !== originalUsername)
      return;
    const request: LoginFieldChoiceRequest = {
      field: passwordField ? "password" : field.type === "email" ? "email" : "username",
      prefix: passwordField ? "" : originalUsername,
      ...(before.boundUsername || (passwordField && knownUsername)
        ? { formUsername: knownUsername }
        : {}),
      acceptsPassword: Boolean(before.password && !before.password.value),
    };
    const stillMatches = () => {
      if (generation !== documentGeneration || !field.matches(":focus") || !available(field))
        return false;
      const now = formContext(field);
      return (
        now?.scope === before.scope &&
        now.username === before.username &&
        now.boundUsername === before.boundUsername &&
        now.password === before.password &&
        now.actions === before.actions
      );
    };
    pending = true;
    try {
      const choice: LoginFieldChoice | null = await ipcRenderer.invoke(
        BROWSER_IPC_CHANNELS.email.choose,
        request,
      );
      if (
        !choice ||
        typeof choice.username !== "string" ||
        !stillMatches() ||
        (before.username?.value ?? "") !== originalUsername
      )
        return;
      if (request.formUsername && request.formUsername !== choice.username) return;
      if (before.username && (!passwordField || !originalUsername)) {
        if (before.username.type === "email" && !isLoginEmail(choice.username)) return;
        fill(before.username, choice.username);
      }
      // Username listeners can synchronously replace the form, show a signup
      // flow, or change the destination password field into visible text.
      if (
        request.acceptsPassword &&
        typeof choice.password === "string" &&
        before.password &&
        !before.password.value &&
        stillMatches() &&
        (!before.username || before.username.value === choice.username)
      ) {
        for (const reference of filledPasswords) {
          const previous = reference.deref();
          if (!previous || previous === before.password) filledPasswords.delete(reference);
        }
        filledPasswords.add(new WeakRef(before.password));
        fill(before.password, choice.password);
      }
    } catch {
      // The tab can navigate or detach while the native menu is open.
    } finally {
      pending = false;
    }
  };
  window.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || event.button !== 0) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Element)) return;
      const button = target.closest(
        "button, [role=button], input[type=button], input[type=submit]",
      );
      if (button && (NEXT.test(buttonText(button)) || SIGN_IN.test(buttonText(button)))) {
        // Script-driven steps can advance on a button click without a submit.
        const form =
          button instanceof HTMLButtonElement || button instanceof HTMLInputElement
            ? button.form
            : null;
        if (!form || button.getAttribute("type") === "button") remember(form ?? scopeOf(button));
      } else {
        void show(event);
      }
    },
    true,
  );

  let tabbing = false;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.isComposing) return;
      tabbing = event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (tabbing) {
        window.setTimeout(() => {
          tabbing = false;
        }, 0);
      } else if (event.key === "ArrowDown") {
        void show(event);
      } else if (event.key === "Enter") {
        const field = event.composedPath()[0];
        if (field instanceof HTMLInputElement && !field.form && identityHint(field))
          remember(ownerOf(field));
      }
    },
    true,
  );
  window.addEventListener(
    "focusin",
    (event) => {
      if (!tabbing) return;
      tabbing = false;
      void show(event);
    },
    true,
  );
}
