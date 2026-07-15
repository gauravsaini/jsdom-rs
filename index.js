const { RustDocument } = require('./jsdom_rs.node');

// 1. Events implementation
class Event {
  constructor(type, eventInitDict = {}) {
    this.type = type;
    this.bubbles = !!eventInitDict.bubbles;
    this.cancelable = !!eventInitDict.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this._propagationStopped = false;
    this._immediatePropagationStopped = false;
    this.timeStamp = Date.now();
  }
  
  stopPropagation() {
    this._propagationStopped = true;
  }
  
  stopImmediatePropagation() {
    this._immediatePropagationStopped = true;
    this._propagationStopped = true;
  }
  
  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }
}

class CustomEvent extends Event {
  constructor(type, eventInitDict = {}) {
    super(type, eventInitDict);
    this.detail = eventInitDict.detail || null;
  }
}

class EventTarget {
  constructor() {
    this._listeners = {};
  }
  
  addEventListener(type, callback, options = {}) {
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
    this._listeners[type].push({ callback, options });
  }
  
  removeEventListener(type, callback, options = {}) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(l => l.callback !== callback);
  }
  
  dispatchEvent(event) {
    Object.defineProperty(event, 'target', { value: this, writable: true, configurable: true });
    Object.defineProperty(event, 'currentTarget', { value: this, writable: true, configurable: true });
    
    const path = [];
    let current = this;
    while (current) {
      path.push(current);
      current = current.parentNode;
    }
    
    // Capturing phase
    Object.defineProperty(event, 'eventPhase', { value: 1, writable: true, configurable: true });
    for (let i = path.length - 1; i > 0; i--) {
      const target = path[i];
      Object.defineProperty(event, 'currentTarget', { value: target, writable: true, configurable: true });
      target._invokeListeners(event, true);
      if (event._propagationStopped) break;
    }
    
    // At target phase
    if (!event._propagationStopped) {
      Object.defineProperty(event, 'eventPhase', { value: 2, writable: true, configurable: true });
      Object.defineProperty(event, 'currentTarget', { value: this, writable: true, configurable: true });
      this._invokeListeners(event, false);
    }
    
    // Bubbling phase
    if (event.bubbles && !event._propagationStopped) {
      Object.defineProperty(event, 'eventPhase', { value: 3, writable: true, configurable: true });
      for (let i = 1; i < path.length; i++) {
        const target = path[i];
        Object.defineProperty(event, 'currentTarget', { value: target, writable: true, configurable: true });
        target._invokeListeners(event, false);
        if (event._propagationStopped) break;
      }
    }
    
    Object.defineProperty(event, 'eventPhase', { value: 0, writable: true, configurable: true });
    Object.defineProperty(event, 'currentTarget', { value: null, writable: true, configurable: true });
    
    return !event.defaultPrevented;
  }
  
  _invokeListeners(event, useCapture) {
    const type = event.type;
    if (!this._listeners[type]) return;
    const listeners = [...this._listeners[type]];
    for (const listener of listeners) {
      const capture = !!listener.options.capture;
      if (capture === useCapture) {
        try {
          if (typeof listener.callback === 'function') {
            listener.callback.call(this, event);
          } else if (listener.callback && typeof listener.callback.handleEvent === 'function') {
            listener.callback.handleEvent(event);
          }
        } catch (e) {
          console.error(e);
        }
        if (listener.options.once) {
          this.removeEventListener(type, listener.callback, listener.options);
        }
        if (event._immediatePropagationStopped) break;
      }
    }
  }
}

// Lazy NodeList / HTMLCollection Proxy wrapper to eliminate wrap/instantiation overhead on large queryAlls
class NodeList {
  constructor(rustDoc, ids, window) {
    this._rustDoc = rustDoc;
    this._ids = ids;
    this._window = window;
    
    return new Proxy(this, {
      get(target, prop) {
        if (prop === 'length') {
          return target._ids.length;
        }
        if (prop === 'item') {
          return (i) => target.item(i);
        }
        if (prop === 'forEach') {
          return (cb, thisArg) => {
            for (let i = 0; i < target._ids.length; i++) {
              cb.call(thisArg, target.item(i), i, target);
            }
          };
        }
        if (typeof prop === 'string') {
          const index = Number(prop);
          if (Number.isInteger(index) && index >= 0 && index < target._ids.length) {
            return target.item(index);
          }
        }
        if (prop === Symbol.iterator) {
          return function* () {
            for (let i = 0; i < target._ids.length; i++) {
              yield target.item(i);
            }
          };
        }
        // Custom array utility checks in JS frameworks
        if (prop === 'map') {
          return (cb, thisArg) => {
            const result = [];
            for (let i = 0; i < target._ids.length; i++) {
              result.push(cb.call(thisArg, target.item(i), i, target));
            }
            return result;
          };
        }
        if (prop === 'find') {
          return (cb, thisArg) => {
            for (let i = 0; i < target._ids.length; i++) {
              const node = target.item(i);
              if (cb.call(thisArg, node, i, target)) return node;
            }
            return undefined;
          };
        }
        if (prop === 'findIndex') {
          return (cb, thisArg) => {
            for (let i = 0; i < target._ids.length; i++) {
              if (cb.call(thisArg, target.item(i), i, target)) return i;
            }
            return -1;
          };
        }
        return target[prop];
      }
    });
  }

  item(i) {
    if (i < 0 || i >= this._ids.length) return null;
    return wrapNode(this._rustDoc, this._ids[i], this._window);
  }
}

// 3. Node Factory with Caching (Reference Equality Support)
function wrapNode(rustDoc, nodeId, window) {
  if (nodeId === null || nodeId === undefined) return null;
  
  if (window && window._nodeCache) {
    if (window._nodeCache.has(nodeId)) {
      return window._nodeCache.get(nodeId);
    }
  }
  
  let node;
  if (nodeId === 0) {
    node = new Document(rustDoc, nodeId, window);
  } else {
    const tagName = rustDoc.getTagName(nodeId);
    if (tagName !== null) {
      node = new Element(rustDoc, nodeId, window);
    } else {
      node = new Node(rustDoc, nodeId, window);
    }
  }
  
  if (window && window._nodeCache) {
    window._nodeCache.set(nodeId, node);
  }
  
  return node;
}

// 4. Node Class Hierarchy
class Node extends EventTarget {
  constructor(rustDoc, nodeId, window) {
    super();
    this._rustDoc = rustDoc;
    this._nodeId = nodeId;
    this._window = window;
  }

  get baseURI() {
    return this._window ? this._window.document.baseURI : "about:blank";
  }

  get nodeType() {
    if (this._nodeId === 0) return 9; // DOCUMENT_NODE
    const tag = this._rustDoc.getTagName(this._nodeId);
    if (tag !== null) return 1; // ELEMENT_NODE
    const text = this._rustDoc.getNodeValue(this._nodeId);
    if (text !== null) {
      const outer = this._rustDoc.getOuterHtml(this._nodeId);
      if (outer && outer.startsWith("<!--")) return 8; // COMMENT_NODE
      return 3; // TEXT_NODE
    }
    return 8; // default
  }

  get nodeName() {
    const type = this.nodeType;
    if (type === 9) return "#document";
    if (type === 1) return this._rustDoc.getTagName(this._nodeId).toUpperCase();
    if (type === 3) return "#text";
    if (type === 8) return "#comment";
    return "#comment";
  }

  get nodeValue() {
    return this._rustDoc.getNodeValue(this._nodeId);
  }

  set nodeValue(val) {
    this._rustDoc.setNodeValue(this._nodeId, val === null ? null : String(val));
  }

  get parentNode() {
    const parentId = this._rustDoc.getParentNode(this._nodeId);
    return wrapNode(this._rustDoc, parentId, this._window);
  }

  get childNodes() {
    const ids = this._rustDoc.getChildNodes(this._nodeId);
    return new NodeList(this._rustDoc, ids, this._window);
  }

  get firstChild() {
    const ids = this._rustDoc.getChildNodes(this._nodeId);
    return ids.length > 0 ? wrapNode(this._rustDoc, ids[0], this._window) : null;
  }

  get lastChild() {
    const ids = this._rustDoc.getChildNodes(this._nodeId);
    return ids.length > 0 ? wrapNode(this._rustDoc, ids[ids.length - 1], this._window) : null;
  }

  get nextSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const siblings = parent.childNodes;
    const idx = siblings.findIndex(n => n._nodeId === this._nodeId);
    return idx !== -1 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  }

  get previousSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const siblings = parent.childNodes;
    const idx = siblings.findIndex(n => n._nodeId === this._nodeId);
    return idx > 0 ? siblings[idx - 1] : null;
  }

  get textContent() {
    return this._rustDoc.getTextContent(this._nodeId) || "";
  }

  set textContent(val) {
    this._rustDoc.setTextContent(this._nodeId, String(val));
  }

  appendChild(child) {
    if (child instanceof Node) {
      this._rustDoc.appendChild(this._nodeId, child._nodeId);
      return child;
    }
    throw new Error("Parameter 1 of Node.appendChild is not of type Node.");
  }

  removeChild(child) {
    if (child instanceof Node) {
      this._rustDoc.removeChild(this._nodeId, child._nodeId);
      return child;
    }
    throw new Error("Parameter 1 of Node.removeChild is not of type Node.");
  }

  insertBefore(newChild, refChild) {
    if (!(newChild instanceof Node)) {
      throw new Error("Parameter 1 of Node.insertBefore is not of type Node.");
    }
    if (refChild !== null && refChild !== undefined && !(refChild instanceof Node)) {
      throw new Error("Parameter 2 of Node.insertBefore is not of type Node.");
    }
    const refId = refChild ? refChild._nodeId : null;
    this._rustDoc.insertBefore(this._nodeId, newChild._nodeId, refId);
    return newChild;
  }

  replaceChild(newChild, oldChild) {
    if (!(newChild instanceof Node)) {
      throw new Error("Parameter 1 of Node.replaceChild is not of type Node.");
    }
    if (!(oldChild instanceof Node)) {
      throw new Error("Parameter 2 of Node.replaceChild is not of type Node.");
    }
    const ret = this._rustDoc.replaceChild(this._nodeId, newChild._nodeId, oldChild._nodeId);
    if (ret !== null) return oldChild;
    throw new Error("Old child not found in parent.");
  }

  cloneNode(deep = false) {
    const clonedId = this._rustDoc.cloneNode(this._nodeId, !!deep);
    return wrapNode(this._rustDoc, clonedId, this._window);
  }
}

class Element extends Node {
  get tagName() {
    const tag = this._rustDoc.getTagName(this._nodeId);
    return tag ? tag.toUpperCase() : "";
  }

  get localName() {
    const tag = this._rustDoc.getTagName(this._nodeId);
    return tag ? tag.toLowerCase() : "";
  }

  get src() {
    const val = this.getAttribute('src');
    if (val === null) return "";
    try {
      const base = this._window ? this._window.location.href : "about:blank";
      return new URL(val, base).href;
    } catch (e) {
      return val;
    }
  }

  set src(val) {
    this.setAttribute('src', val);
  }

  get href() {
    const val = this.getAttribute('href');
    if (val === null) return "";
    try {
      const base = this._window ? this._window.location.href : "about:blank";
      return new URL(val, base).href;
    } catch (e) {
      return val;
    }
  }

  set href(val) {
    this.setAttribute('href', val);
  }

  get id() {
    return this.getAttribute('id') || "";
  }

  set id(val) {
    this.setAttribute('id', val);
  }

  get className() {
    return this.getAttribute('class') || "";
  }

  set className(val) {
    this.setAttribute('class', val);
  }

  get innerHTML() {
    return this._rustDoc.getInnerHtml(this._nodeId) || "";
  }

  set innerHTML(val) {
    this._rustDoc.setInnerHtml(this._nodeId, String(val));
  }

  get outerHTML() {
    return this._rustDoc.getOuterHtml(this._nodeId) || "";
  }

  get attributes() {
    const attrs = this._rustDoc.getAttributes(this._nodeId);
    const arr = Object.keys(attrs).map(name => ({ name, value: attrs[name] }));
    arr.getNamedItem = (name) => arr.find(a => a.name === name) || null;
    return arr;
  }

  getAttribute(name) {
    return this._rustDoc.getAttribute(this._nodeId, name);
  }

  setAttribute(name, value) {
    this._rustDoc.setAttribute(this._nodeId, name, String(value));
  }

  removeAttribute(name) {
    this._rustDoc.removeAttribute(this._nodeId, name);
  }

  querySelector(selector) {
    const matchedId = this._rustDoc.querySelector(this._nodeId, selector);
    return wrapNode(this._rustDoc, matchedId, this._window);
  }

  querySelectorAll(selector) {
    const ids = this._rustDoc.querySelectorAll(this._nodeId, selector);
    return new NodeList(this._rustDoc, ids, this._window);
  }

  getElementsByClassName(className) {
    const ids = this._rustDoc.getElementsByClassName(this._nodeId, className);
    return new NodeList(this._rustDoc, ids, this._window);
  }

  getElementsByTagName(tagName) {
    const ids = this._rustDoc.getElementsByTagName(this._nodeId, tagName);
    return new NodeList(this._rustDoc, ids, this._window);
  }

  // Traversal extension (optimized via filtering IDs first before wrapping)
  get children() {
    const ids = this._rustDoc.getChildNodes(this._nodeId);
    const elementIds = ids.filter(id => this._rustDoc.getTagName(id) !== null);
    return new NodeList(this._rustDoc, elementIds, this._window);
  }

  get firstElementChild() {
    const c = this.children;
    return c.length > 0 ? c[0] : null;
  }

  get lastElementChild() {
    const c = this.children;
    return c.length > 0 ? c[c.length - 1] : null;
  }

  get nextElementSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const siblings = parent.children;
    const idx = siblings.findIndex(n => n._nodeId === this._nodeId);
    return idx !== -1 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  }

  get previousElementSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const siblings = parent.children;
    const idx = siblings.findIndex(n => n._nodeId === this._nodeId);
    return idx > 0 ? siblings[idx - 1] : null;
  }

  get classList() {
    const element = this;
    return {
      add(...classes) {
        let current = element.className;
        let parts = current.split(/\s+/).filter(Boolean);
        classes.forEach(c => {
          if (!parts.includes(c)) parts.push(c);
        });
        element.className = parts.join(" ");
      },
      remove(...classes) {
        let current = element.className;
        let parts = current.split(/\s+/).filter(Boolean);
        element.className = parts.filter(c => !classes.includes(c)).join(" ");
      },
      contains(cls) {
        return element.className.split(/\s+/).filter(Boolean).includes(cls);
      },
      toggle(cls, force) {
        const contains = this.contains(cls);
        const next = force !== undefined ? !!force : !contains;
        if (next) {
          this.add(cls);
        } else {
          this.remove(cls);
        }
        return next;
      }
    };
  }
}

class Document extends Node {
  get documentElement() {
    return this.querySelector('html');
  }

  get URL() {
    return this._window ? this._window.location.href : "about:blank";
  }

  get documentURI() {
    return this._window ? this._window.location.href : "about:blank";
  }

  get baseURI() {
    return this.URL;
  }

  get innerHTML() {
    return this._rustDoc.getInnerHtml(this._nodeId) || "";
  }

  set innerHTML(val) {
    this._rustDoc.setInnerHtml(this._nodeId, String(val));
  }

  get body() {
    return this.querySelector('body');
  }

  get head() {
    return this.querySelector('head');
  }

  get title() {
    const titleEl = this.querySelector('title');
    return titleEl ? titleEl.textContent : "";
  }

  set title(val) {
    const titleEl = this.querySelector('title');
    if (titleEl) {
      titleEl.textContent = val;
    } else {
      const head = this.head || this;
      const newTitle = this.createElement('title');
      newTitle.textContent = val;
      head.appendChild(newTitle);
    }
  }

  createElement(tagName) {
    const nodeId = this._rustDoc.createElement(tagName.toLowerCase());
    return wrapNode(this._rustDoc, nodeId, this._window);
  }

  createTextNode(text) {
    const nodeId = this._rustDoc.createTextNode(String(text));
    return wrapNode(this._rustDoc, nodeId, this._window);
  }

  getElementById(id) {
    const matchedId = this._rustDoc.getElementById(this._nodeId, id);
    return wrapNode(this._rustDoc, matchedId, this._window);
  }

  getElementsByClassName(className) {
    const ids = this._rustDoc.getElementsByClassName(this._nodeId, className);
    return new NodeList(this._rustDoc, ids, this._window);
  }

  getElementsByTagName(tagName) {
    const ids = this._rustDoc.getElementsByTagName(this._nodeId, tagName);
    return new NodeList(this._rustDoc, ids, this._window);
  }

  querySelector(selector) {
    const matchedId = this._rustDoc.querySelector(this._nodeId, selector);
    return wrapNode(this._rustDoc, matchedId, this._window);
  }

  querySelectorAll(selector) {
    const ids = this._rustDoc.querySelectorAll(this._nodeId, selector);
    return new NodeList(this._rustDoc, ids, this._window);
  }
}

class Window {
  constructor(rustDoc) {
    this._rustDoc = rustDoc;
    this._nodeCache = new Map();
    this.window = this;
    this.self = this;
    this.top = this;
    
    // Instantiate document and register in the cache
    this.document = new Document(rustDoc, 0, this);
    this._nodeCache.set(0, this.document);
    
    // Prototypes chain exposure
    this.Node = Node;
    this.Element = Element;
    this.Document = Document;
    this.Event = Event;
    this.CustomEvent = CustomEvent;
    this.EventTarget = EventTarget;
    
    // Alias HTML elements for drop-in prototype checks
    this.HTMLElement = Element;
    this.HTMLDivElement = Element;
    this.HTMLAnchorElement = Element;
    this.HTMLSpanElement = Element;
    this.HTMLInputElement = Element;
    this.HTMLButtonElement = Element;
    this.HTMLUListElement = Element;
    this.HTMLOListElement = Element;
    this.HTMLLIElement = Element;
    this.HTMLParagraphElement = Element;
    this.HTMLImageElement = Element;
    
    this.navigator = { userAgent: "node.js" };
    this.history = {
      state: null,
      pushState(state, title, url) {},
      replaceState(state, title, url) {}
    };
    this.location = {
      href: "about:blank",
      protocol: "about:",
      host: "",
      hostname: "",
      port: "",
      pathname: "blank",
      search: "",
      hash: "",
      assign() {},
      replace() {},
      reload() {}
    };
  }
}

class JSDOM {
  constructor(html, options = {}) {
    const input = html === undefined ? "" : String(html);
    this._rustDoc = new RustDocument(input);
    this.window = new Window(this._rustDoc);
    
    if (options.url) {
      this.reconfigure({ url: options.url });
    }
  }

  serialize() {
    return this._rustDoc.getOuterHtml(0);
  }

  reconfigure(settings) {
    if ("url" in settings) {
      // Validate first (throws TypeError if URL is invalid)
      const u = new URL(settings.url);
      this.window.location.href = u.href;
      this.window.location.protocol = u.protocol;
      this.window.location.host = u.host;
      this.window.location.hostname = u.hostname;
      this.window.location.port = u.port;
      this.window.location.pathname = u.pathname;
      this.window.location.search = u.search;
      this.window.location.hash = u.hash;
    }
    if ("windowTop" in settings) {
      this.window.top = settings.windowTop;
    }
  }
}

module.exports = {
  JSDOM,
  Window,
  Document,
  Element,
  Node,
  Event,
  CustomEvent,
  EventTarget
};
