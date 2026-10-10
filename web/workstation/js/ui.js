// Windows, menus, dialogs and dropdowns, all drawn in the page. Nothing here uses
// native <select> popups, alert/confirm/prompt or the browser's context menu.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ------------------------------------------------------------------ menus

let openMenus = [];

export function closeMenus(depth = 0) {
  for (const menu of openMenus.slice(depth)) menu.remove();
  openMenus = openMenus.slice(0, depth);
}

function placeMenu(menu, x, y) {
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 4);
  const top = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(2, left)}px`;
  menu.style.top = `${Math.max(2, top)}px`;
}

/**
 * Open a menu at a point or under an element.
 * items: "-" for a separator, or { label, action, shortcut, disabled, checked, submenu }.
 */
export function openMenu(items, at, depth = 0) {
  closeMenus(depth);
  const menu = el("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item === "-") {
      menu.append(el("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    const button = el("button", {
      class: `menu-item${item.checked ? " checked" : ""}`,
      role: item.checked !== undefined ? "menuitemcheckbox" : "menuitem",
      "aria-checked": item.checked !== undefined ? String(Boolean(item.checked)) : undefined,
      disabled: item.disabled,
      "aria-haspopup": item.submenu ? "menu" : undefined,
    }, el("span", { text: item.label }));
    if (item.shortcut) button.append(el("span", { class: "shortcut", text: item.shortcut }));
    if (item.submenu) button.append(el("span", { class: "submenu-arrow", text: "▸" }));
    const openSub = () => {
      menu.querySelectorAll(".menu-item.open").forEach((node) => node.classList.remove("open"));
      if (!item.submenu) {
        closeMenus(depth + 1);
        return;
      }
      button.classList.add("open");
      const rect = button.getBoundingClientRect();
      openMenu(item.submenu, { x: rect.right - 2, y: rect.top - 3 }, depth + 1);
    };
    button.addEventListener("pointerenter", openSub);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (item.disabled) return;
      if (item.submenu) {
        openSub();
        return;
      }
      closeMenus();
      item.action?.();
    });
    menu.append(button);
  }
  if (at instanceof Element) {
    const rect = at.getBoundingClientRect();
    placeMenu(menu, rect.left, rect.bottom + 1);
  } else {
    placeMenu(menu, at.x, at.y);
  }
  openMenus[depth] = menu;
  return menu;
}

document.addEventListener("pointerdown", (event) => {
  if (openMenus.length && !openMenus.some((menu) => menu.contains(event.target))) closeMenus();
}, true);

/** A button showing the current choice; clicking it lists the choices. */
export function dropdown({ options, value, onChange, label, className = "dropdown-button", disabled }) {
  let current = value;
  const button = el("button", { class: className, "aria-haspopup": "menu", disabled, "aria-label": label });
  const render = () => {
    const option = options().find((entry) => entry.value === current);
    button.textContent = option ? option.label : "—";
    if (label) button.setAttribute("aria-label", `${label}: ${button.textContent}`);
  };
  button.addEventListener("click", () => {
    openMenu(options().map((option) => option === "-" ? "-" : ({
      label: option.label,
      checked: option.value === current,
      disabled: option.disabled,
      action: () => {
        current = option.value;
        render();
        onChange?.(option.value);
      },
    })), button);
  });
  render();
  return {
    node: button,
    get value() { return current; },
    set value(next) { current = next; render(); },
    refresh: render,
  };
}

// ---------------------------------------------------------------- dialogs

let dialogDepth = 0;
export const dialogOpen = () => dialogDepth > 0;
/** Returned by a dialog button's action to keep the dialog open. */
export const KEEP_OPEN = Symbol("keep-open");

/**
 * A modal dialog. buttons: [{ label, primary, cancel, action }]. An action may
 * return KEEP_OPEN (or a promise of it) to keep the dialog open; otherwise the
 * dialog closes and resolves to what the action returned. Enter presses
 * the primary button; Escape the cancel button.
 */
export function dialog({ title, body, buttons, width, initialFocus }) {
  return new Promise((resolve) => {
    dialogDepth += 1;
    const backdrop = el("div", { class: "modal-backdrop" });
    const box = el("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title, style: width ? { width: `${width}px` } : undefined });
    const footer = el("div", { class: "dialog-buttons" });
    const finish = (result) => {
      dialogDepth -= 1;
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const press = async (button) => {
      const result = button.action ? await button.action() : undefined;
      if (result === KEEP_OPEN) return;
      finish(result === undefined ? button.value ?? button.label : result);
    };
    const nodes = buttons.map((button) => {
      const node = el("button", { class: `button${button.primary ? " primary" : ""}`, text: button.label });
      node.addEventListener("click", () => press(button));
      footer.append(node);
      return node;
    });
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        const cancel = buttons.find((button) => button.cancel);
        if (cancel) press(cancel);
      } else if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement)) {
        const primary = buttons.find((button) => button.primary);
        if (primary) {
          event.preventDefault();
          event.stopPropagation();
          nodes[buttons.indexOf(primary)].click();
        }
      } else {
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey, true);
    box.append(el("div", { class: "dialog-title", text: title }), el("div", { class: "dialog-body" }, body), footer);
    backdrop.append(box);
    document.getElementById("overlays").append(backdrop);
    const focus = initialFocus ?? box.querySelector("input");
    (focus ?? nodes.find((_, index) => buttons[index].primary) ?? nodes[0])?.focus();
    if (focus instanceof HTMLInputElement) focus.select();
  });
}

export async function promptDialog({ title, label, value = "", okLabel = "OK" }) {
  const input = el("input", { class: "text-input", value, "aria-label": label });
  const result = await dialog({
    title,
    body: el("div", { class: "field" }, el("label", { text: label }), input),
    buttons: [
      { label: okLabel, primary: true, action: () => (input.value.trim() ? input.value.trim() : KEEP_OPEN) },
      { label: "Cancel", cancel: true, action: () => null },
    ],
  });
  return result;
}

export async function confirmDialog({ title, message, ok = "Yes", cancel = "No" }) {
  return dialog({
    title,
    body: el("div", { class: "dialog-message", text: message }),
    buttons: [
      { label: ok, primary: true, action: () => true },
      { label: cancel, cancel: true, action: () => false },
    ],
  });
}

export function messageDialog({ title, message }) {
  return dialog({
    title,
    body: el("div", { class: "dialog-message", text: message }),
    buttons: [{ label: "OK", primary: true, cancel: true }],
  });
}

export function checkbox(label, checked = false, onChange) {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange?.(input.checked));
  const node = el("label", { class: "check" }, input, el("span", { text: label }));
  return { node, input, get checked() { return input.checked; }, set checked(value) { input.checked = value; } };
}

export function radioGroup(options, value, onChange, label) {
  let current = value;
  const node = el("div", { class: "radio-row", role: "radiogroup", "aria-label": label });
  const buttons = options.map((option) => {
    const button = el("button", { class: "radio", role: "radio", "aria-checked": String(option.value === current) },
      el("span", { class: "dot" }), el("span", { text: option.label }));
    button.addEventListener("click", () => {
      current = option.value;
      buttons.forEach((entry, index) => entry.setAttribute("aria-checked", String(options[index].value === current)));
      onChange?.(current);
    });
    node.append(button);
    return button;
  });
  return { node, get value() { return current; } };
}

// ---------------------------------------------------------------- windows

const windows = [];
let zTop = 100;

export function activeWindow() {
  return windows.reduce((top, entry) => (!top || Number(entry.root.style.zIndex) > Number(top.root.style.zIndex) ? entry : top), null);
}

export function allWindows() {
  return [...windows];
}

/** A movable window floating over the workspace, like FlowJo's graph windows. */
export function createWindow({ title, x, y, width, height, className = "", onClose, onKey }) {
  const titleText = el("span", { class: "title-text", text: title });
  const close = el("button", { class: "window-close", "aria-label": `Close ${title}`, title: "Close", text: "×" });
  const bar = el("div", { class: "window-title" }, titleText, close);
  const body = el("div", { class: "window-body" });
  const root = el("div", { class: `window ${className}`, role: "dialog", "aria-label": title }, bar, body);
  const maxX = window.innerWidth - width - 4;
  const maxY = window.innerHeight - height - 4;
  Object.assign(root.style, {
    left: `${Math.max(0, Math.min(x, maxX))}px`,
    top: `${Math.max(0, Math.min(y, maxY))}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
  const entry = {
    root,
    body,
    onKey,
    setTitle(text) {
      titleText.textContent = text;
      root.setAttribute("aria-label", text);
      close.setAttribute("aria-label", `Close ${text}`);
    },
    focus() {
      root.style.zIndex = String(++zTop);
      windows.forEach((other) => other.root.classList.toggle("active", other === entry));
    },
    close() {
      const index = windows.indexOf(entry);
      if (index >= 0) windows.splice(index, 1);
      root.remove();
      onClose?.();
      activeWindow()?.focus();
    },
  };
  close.addEventListener("click", () => entry.close());
  root.addEventListener("pointerdown", () => entry.focus(), true);
  bar.addEventListener("pointerdown", (event) => {
    if (event.target === close) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const left = root.offsetLeft;
    const top = root.offsetTop;
    const move = (moveEvent) => {
      root.style.left = `${Math.max(-width + 80, Math.min(window.innerWidth - 80, left + moveEvent.clientX - startX))}px`;
      root.style.top = `${Math.max(0, Math.min(window.innerHeight - 30, top + moveEvent.clientY - startY))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  document.getElementById("windows").append(root);
  windows.push(entry);
  entry.focus();
  return entry;
}

export function formatCount(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "";
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  if (value < 0.01) return value.toExponential(1);
  if (value < 10) return value.toFixed(2);
  return value.toFixed(1);
}
