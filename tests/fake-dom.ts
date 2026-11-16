// A stand-in DOM for the browser code's tests: only the element calls design-view.ts,
// main.ts and update-view.ts make. What a real browser adds (focus, maxLength while
// typing, the capture order of key handlers) is checked in the app.

type Listener = (event: unknown) => void;

export class FakeElement {
  readonly ownerDocument: FakeDocument;
  readonly tagName: string;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  value = "";
  textContent = "";
  type = "";
  checked = false;
  disabled = false;
  private listeners = new Map<string, Listener[]>();

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceChildren(): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  contains(node: FakeElement | null): boolean {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  setAttribute(): void {}
  focus(): void {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** Run this element's own listeners for `type` (no bubbling). */
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }
  /** This element and everything under it with that tag, in document order. */
  findAll(tagName: string): FakeElement[] {
    return [...(this.tagName === tagName ? [this] : []), ...this.children.flatMap((c) => c.findAll(tagName))];
  }
}

export class FakeDocument {
  /** The window's keydown listeners. */
  readonly keydown: Listener[] = [];
  readonly defaultView = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === "keydown") this.keydown.push(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      this.keydown.splice(this.keydown.indexOf(listener), 1);
    },
  };
  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
  /** Press a key with the focus on `target`; true when a listener claimed it. */
  press(key: string, target: FakeElement): boolean {
    let claimed = false;
    const event = {
      key, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false,
      preventDefault: () => { claimed = true; },
      stopPropagation: () => undefined,
    };
    for (const listener of [...this.keydown]) listener(event);
    return claimed;
  }
}

// design-view.ts checks `event.target instanceof Node`.
(globalThis as { Node?: unknown }).Node = FakeElement;
