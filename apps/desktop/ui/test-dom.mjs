/*
 * A small document for the UI tests: enough of the DOM for the quiet list,
 * the edge panel and Needs attention, plus a walk that reads everything a
 * person could see back out of it. Not shipped; the build copies no file
 * named here.
 */
export class FakeElement {
  constructor(tag, doc) {
    this.localName = tag;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.innerHTML = "";
    this.text = "";
    const props = {};
    this.style = { props, setProperty: (name, value) => { props[name] = value; } };
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this.text;
  }

  set textContent(value) {
    this.children = [];
    this.text = String(value);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parent !== null) {
        node.parent.children = node.parent.children.filter((child) => child !== node);
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  insertBefore(node, reference) {
    if (reference === null || reference === undefined) {
      this.append(node);
      return;
    }
    if (node.parent !== null) {
      node.parent.children = node.parent.children.filter((child) => child !== node);
    }
    const index = this.children.indexOf(reference);
    node.parent = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }

  remove() {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
    }
    this.detach();
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.detach();
    this.children = [];
    this.text = "";
    this.append(...nodes);
  }

  contains(node) {
    return this === node || this.children.some((child) => child.contains(node));
  }

  detach() {
    if (this.ownerDocument.activeElement !== null && this.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = null;
    }
    this.parent = null;
  }

  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  toggleAttribute(name, force) { if (force) this.attributes[name] = ""; else delete this.attributes[name]; }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  removeEventListener(name, listener) { this.listeners[name] = (this.listeners[name] ?? []).filter((entry) => entry !== listener); }
  fire(name, event = {}) { return Promise.all((this.listeners[name] ?? []).map((listener) => listener(event))); }

  /** Every descendant, depth first. */
  all(predicate = () => true) {
    return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.all(predicate)]);
  }
}

export function fakeDocument(ids = []) {
  const doc = {
    listeners: {},
    visibilityState: "visible",
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, doc),
    getElementById: (id) => doc.byId[id] ?? null,
    addEventListener(name, listener) { (doc.listeners[name] ??= []).push(listener); },
    removeEventListener(name, listener) { doc.listeners[name] = (doc.listeners[name] ?? []).filter((entry) => entry !== listener); },
    fire(name, event = {}) { return Promise.all((doc.listeners[name] ?? []).map((listener) => listener(event))); },
    byId: {},
  };
  for (const id of ids) doc.byId[id] = new FakeElement("div", doc);
  return doc;
}

/** Everything a person could read or hear: text, labels and titles. */
export function spoken(element) {
  const own = ["aria-label", "title", "aria-valuetext"].map((name) => element.getAttribute(name)).filter(Boolean);
  return [element.text, ...own, ...element.children.flatMap(spoken)].filter(Boolean);
}

/** The ways 2.0.1 leaked codes onto the screen, as one check. */
export function leaks(texts) {
  return texts.filter((text) => /\b[A-Z]{3,}(?:_[A-Z0-9]+)*\b/u.test(text.replace(/\b(?:API|CLI|USD|CNY)\b/gu, "")) ||
    /\bunknown\b/iu.test(text) || /[0-9a-f]{12,}/iu.test(text) || /[-‐-―−]/u.test(text));
}
