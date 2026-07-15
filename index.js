const { RustDocument } = require('./jsdom_rs.node');
const EventEmitter = require('node:events');
const vm = require('node:vm');
const { MIMEType } = require('whatwg-mimetype');
const toughCookie = require('tough-cookie');

const activeWindows = new Set();

class CookieJar extends toughCookie.CookieJar {
  constructor(store, options) {
    super(store, { looseMode: true, ...options });
  }
}

function camelToKebab(str) {
  return str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2').toLowerCase();
}

class CSSStyleDeclaration {
  constructor(element = null, readOnly = false) {
    this._element = element;
    this._readOnly = readOnly;
    this._values = new Map();
    this._parse();

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') {
          return Reflect.get(target, prop, receiver);
        }
        if (prop in target || typeof target[prop] === 'function') {
          return Reflect.get(target, prop, receiver);
        }
        const cssProp = camelToKebab(prop);
        return target.getPropertyValue(cssProp);
      },
      set(target, prop, value, receiver) {
        if (prop in target || typeof target[prop] === 'function') {
          return Reflect.set(target, prop, value, receiver);
        }
        if (target._readOnly) return false;
        const cssProp = camelToKebab(prop);
        target.setProperty(cssProp, String(value));
        return true;
      }
    });
  }

  _parse() {
    if (!this._element) return;
    const styleAttr = this._element.getAttribute("style") || "";
    this._values.clear();
    const parts = styleAttr.split(";");
    for (const part of parts) {
      const colonIdx = part.indexOf(":");
      if (colonIdx !== -1) {
        const prop = part.substring(0, colonIdx).trim().toLowerCase();
        const val = part.substring(colonIdx + 1).trim();
        if (prop) {
          this._values.set(prop, val);
        }
      }
    }
  }

  _serialize() {
    if (this._readOnly || !this._element) return;
    const parts = [];
    for (const [prop, val] of this._values.entries()) {
      parts.push(`${prop}: ${val}`);
    }
    this._element.setAttribute("style", parts.join("; "));
  }

  getPropertyValue(prop) {
    this._parse();
    return this._values.get(prop) || "";
  }

  setProperty(prop, val) {
    if (this._readOnly) return;
    this._parse();
    if (val === null || val === "") {
      this._values.delete(prop);
    } else {
      this._values.set(prop, String(val));
    }
    this._serialize();
  }

  removeProperty(prop) {
    if (this._readOnly) return "";
    this._parse();
    const old = this._values.get(prop) || "";
    if (this._values.delete(prop)) {
      this._serialize();
    }
    return old;
  }

  get cssText() {
    this._parse();
    const parts = [];
    for (const [prop, val] of this._values.entries()) {
      parts.push(`${prop}: ${val};`);
    }
    return parts.join(" ");
  }

  set cssText(val) {
    if (this._readOnly) return;
    if (this._element) {
      this._element.setAttribute("style", val);
      this._parse();
    }
  }
}

function parseCssRules(cssText) {
  const rules = [];
  const cleanCss = (cssText || "").replace(/\/\*[\s\S]*?\*\//g, "");
  const regex = /([^{]+)\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(cleanCss)) !== null) {
    const selectorGroup = match[1].trim();
    const declarationsText = match[2].trim();
    
    const declarations = {};
    const declParts = declarationsText.split(";");
    for (const decl of declParts) {
      const colonIdx = decl.indexOf(":");
      if (colonIdx !== -1) {
        const prop = decl.substring(0, colonIdx).trim().toLowerCase();
        const val = decl.substring(colonIdx + 1).trim();
        if (prop) {
          declarations[prop] = val;
        }
      }
    }
    
    const selectors = selectorGroup.split(",");
    for (const sel of selectors) {
      const s = sel.trim();
      if (s) {
        rules.push({ selector: s, declarations });
      }
    }
  }
  return rules;
}

function getSpecificity(selector) {
  let a = 0, b = 0, c = 0;
  const ids = selector.match(/#[^\s+>~:]+/g);
  if (ids) a += ids.length;
  const classes = selector.match(/\.[^\s+>~:]+/g);
  if (classes) b += classes.length;
  const attrs = selector.match(/\[[^\]]+\]/g);
  if (attrs) b += attrs.length;
  const pseudos = selector.match(/:[^\s+>~]+/g);
  if (pseudos) b += pseudos.length;
  const tags = selector.match(/^[a-zA-Z0-9_-]+|(?<=[\s+>~])[a-zA-Z0-9_-]+/g);
  if (tags) {
    for (const t of tags) {
      if (t !== "and" && t !== "or") c++;
    }
  }
  return a * 100 + b * 10 + c;
}

function markStylesDirty(node) {
  if (!node) return;
  const doc = node._window ? node._window.document : null;
  if (doc) {
    doc._stylesVersion = (doc._stylesVersion || 0) + 1;
  }
}

const consoleMethods = [
  "assert", "clear", "count", "countReset", "debug", "dir", "dirxml", "error",
  "group", "groupCollapsed", "groupEnd", "info", "log", "table", "time",
  "timeLog", "timeEnd", "trace", "warn"
];

class VirtualConsole extends EventEmitter {
  constructor() {
    super();
    this.on("error", () => {});
  }

  forwardTo(anyConsole, { jsdomErrors } = {}) {
    for (const method of Object.keys(anyConsole)) {
      if (typeof anyConsole[method] === "function") {
        this.on(method, (...args) => {
          anyConsole[method](...args);
        });
      }
    }

    const forward = (e) => {
      if (e.type === "unhandled-exception") {
        anyConsole.error(e.cause.stack);
      } else {
        anyConsole.error(e.message);
      }
    };

    if (jsdomErrors === undefined) {
      this.on("jsdomError", forward);
    } else if (Array.isArray(jsdomErrors)) {
      this.on("jsdomError", e => {
        if (jsdomErrors.includes(e.type)) {
          forward(e);
        }
      });
    } else if (jsdomErrors !== "none") {
      throw new TypeError("Invalid jsdomErrors option");
    }

    return this;
  }
}

class Storage {
  constructor(quota = 5000000) {
    this._quota = quota;
    this._data = new Map();
    
    return new Proxy(this, {
      get(target, prop) {
        if (typeof prop === 'symbol') {
          return target[prop];
        }
        if (prop in target || typeof target[prop] === 'function') {
          return target[prop];
        }
        return target.getItem(prop);
      },
      set(target, prop, value) {
        if (prop in target || typeof target[prop] === 'function') {
          target[prop] = value;
          return true;
        }
        target.setItem(prop, value);
        return true;
      },
      deleteProperty(target, prop) {
        if (prop in target || typeof target[prop] === 'function') {
          return false;
        }
        target.removeItem(prop);
        return true;
      }
    });
  }

  get length() {
    return this._data.size;
  }

  key(index) {
    const keys = Array.from(this._data.keys());
    return index >= 0 && index < keys.length ? keys[index] : null;
  }

  getItem(key) {
    return this._data.has(key) ? this._data.get(key) : null;
  }

  setItem(key, value) {
    const valStr = String(value);
    const keyStr = String(key);
    
    let size = 0;
    for (const [k, v] of this._data.entries()) {
      if (k !== keyStr) {
        size += k.length + v.length;
      }
    }
    
    if (size + keyStr.length + valStr.length > this._quota) {
      throw new Error("QuotaExceededError: The quota has been exceeded.");
    }
    
    this._data.set(keyStr, valStr);
  }

  removeItem(key) {
    this._data.delete(String(key));
  }

  clear() {
    this._data.clear();
  }
}

function isAttachedToDocument(node) {
  let curr = node;
  while (curr) {
    if (curr._nodeId === 0) return true;
    if (curr instanceof ShadowRoot) {
      curr = curr.host;
    } else {
      curr = curr.parentNode;
    }
  }
  return false;
}

function triggerConnectionLifecycle(node, isConnectedBefore) {
  if (!node || node._nodeId === 0) return;
  const isConnectedNow = isAttachedToDocument(node);
  if (isConnectedNow !== isConnectedBefore) {
    if (node._customElementState === "upgraded") {
      if (isConnectedNow) {
        if (typeof node.connectedCallback === 'function') {
          try { node.connectedCallback(); } catch(e) { reportException(node._window, e, node._window.location.href); }
        }
      } else {
        if (typeof node.disconnectedCallback === 'function') {
          try { node.disconnectedCallback(); } catch(e) { reportException(node._window, e, node._window.location.href); }
        }
      }
    }
    
    if (node._shadowRoot) {
      triggerConnectionLifecycle(node._shadowRoot, isConnectedBefore);
    }
    
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      triggerConnectionLifecycle(children[i], isConnectedBefore);
    }
  }
}

function reportException(window, error, filename) {
  let errorString;
  if (error && error.name && error.message !== undefined && error.stack) {
    errorString = `[${error.name}: ${error.message}]`;
  } else {
    errorString = require("node:util").inspect(error);
  }
  const jsdomError = new Error(`Uncaught ${errorString}`, { cause: error });
  jsdomError.type = "unhandled-exception";
  if (window && window._virtualConsole) {
    window._virtualConsole.emit("jsdomError", jsdomError);
  }
}

function fetchAndRunExternalScript(node, window) {
  const resources = window._resources;
  if (!resources) return;
  const src = node.getAttribute("src");
  if (!src) return;
  try {
    const url = new URL(src, window.location.href).href;
    
    let fetchPromise;
    if (resources === "usable") {
      fetchPromise = fetch(url).then(res => {
        if (!res.ok) throw new Error(`Status code: ${res.status}`);
        return res.text();
      });
    } else if (resources && typeof resources.fetch === "function") {
      fetchPromise = resources.fetch(url, { element: node });
    } else {
      return;
    }

    if (fetchPromise) {
      const context = window._context || window;
      fetchPromise
        .then(code => {
          if (Buffer.isBuffer(code)) {
            code = code.toString("utf8");
          } else if (code && typeof code === "object" && code.toString) {
            code = code.toString();
          }
          try {
            vm.runInContext(code, context, { filename: url, displayErrors: false });
          } catch (err) {
            reportException(window, err, url);
          }
          const event = new Event("load");
          node.dispatchEvent(event);
        })
        .catch(err => {
          reportException(window, err, url);
          const event = new Event("error");
          node.dispatchEvent(event);
        });
    }
  } catch (e) {
    reportException(window, e, window.location.href);
  }
}

function runScriptIfNecessary(node, window) {
  if (!isAttachedToDocument(node)) return;

  if (node instanceof Element && node.tagName === "SCRIPT") {
    if (!node._alreadyStarted) {
      node._alreadyStarted = true;
      if (node.hasAttribute("src")) {
        fetchAndRunExternalScript(node, window);
      } else {
        const code = node.textContent;
        try {
          const context = window._context || window;
          vm.runInContext(code, context, { filename: window.location.href, displayErrors: false });
        } catch (err) {
          reportException(window, err, window.location.href);
        }
      }
    }
  } else {
    if (node.querySelectorAll) {
      const scripts = node.querySelectorAll("script");
      scripts.forEach(s => runScriptIfNecessary(s, window));
    }
  }
}

// Helper console creator
function createConsole(virtualConsole) {
  const windowConsole = {};
  for (const method of consoleMethods) {
    windowConsole[method] = (...args) => {
      virtualConsole.emit(method, ...args);
    };
  }
  return windowConsole;
}

function defineEventHandlerProperty(prototype, eventName, isAlwaysWindowAlias = false) {
  const propName = "on" + eventName;
  Object.defineProperty(prototype, propName, {
    get() {
      const isBodyOrHtmlAlias = !isAlwaysWindowAlias && this.tagName && (this.tagName === "BODY" || this.tagName === "HTML");
      if ((isAlwaysWindowAlias || isBodyOrHtmlAlias) && this._window) {
        return this._window[propName];
      }
      return (this._eventHandlers && this._eventHandlers[propName] !== undefined) ? this._eventHandlers[propName] : null;
    },
    set(handler) {
      const isBodyOrHtmlAlias = !isAlwaysWindowAlias && this.tagName && (this.tagName === "BODY" || this.tagName === "HTML");
      if ((isAlwaysWindowAlias || isBodyOrHtmlAlias) && this._window) {
        this._window[propName] = handler;
        return;
      }
      this._eventHandlers = this._eventHandlers || {};
      const oldHandler = this._eventHandlers[propName];
      if (oldHandler) {
        this.removeEventListener(eventName, oldHandler);
      }
      if (typeof handler === "function") {
        this._eventHandlers[propName] = handler;
        this.addEventListener(eventName, handler);
      } else {
        delete this._eventHandlers[propName];
      }
    },
    configurable: true,
    enumerable: true
  });
}

// 1. Events implementation
class Event {
  constructor(type, eventInitDict = {}) {
    this.type = type;
    this.bubbles = !!eventInitDict.bubbles;
    this.cancelable = !!eventInitDict.cancelable;
    this.composed = !!eventInitDict.composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this._propagationStopped = false;
    this._immediatePropagationStopped = false;
    this.timeStamp = Date.now();
    this._composedPath = [];
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

  composedPath() {
    return this._composedPath;
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
      if (current instanceof ShadowRoot) {
        if (!event.composed && current !== this) {
          break;
        }
        current = current.host;
      } else {
        current = current.parentNode;
      }
    }
    
    event._composedPath = path;
    
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
      const tagUpper = tagName.toUpperCase();
      if (tagUpper === "CANVAS") {
        node = new HTMLCanvasElement(rustDoc, nodeId, window);
      } else {
        node = new Element(rustDoc, nodeId, window);
      }
    } else {
      const val = rustDoc.getNodeValue(nodeId);
      if (val === null) {
        node = new DocumentFragment(rustDoc, nodeId, window);
      } else {
        node = new Node(rustDoc, nodeId, window);
      }
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
    return this._window ? this._window.location.href : "about:blank";
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
    if (this.tagName === "STYLE") markStylesDirty(this);
    this._rustDoc.setTextContent(this._nodeId, String(val));
  }

  appendChild(child) {
    if (child instanceof Node) {
      if (child.tagName === "STYLE") markStylesDirty(this);
      const isConnectedBefore = isAttachedToDocument(child);
      this._rustDoc.appendChild(this._nodeId, child._nodeId);
      triggerConnectionLifecycle(child, isConnectedBefore);
      if (this._window && this._window._runScripts === "dangerously") {
        runScriptIfNecessary(child, this._window);
      }
      return child;
    }
    throw new Error("Parameter 1 of Node.appendChild is not of type Node.");
  }

  removeChild(child) {
    if (child instanceof Node) {
      if (child.tagName === "STYLE") markStylesDirty(this);
      const isConnectedBefore = isAttachedToDocument(child);
      this._rustDoc.removeChild(this._nodeId, child._nodeId);
      triggerConnectionLifecycle(child, isConnectedBefore);
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
    if (newChild.tagName === "STYLE") markStylesDirty(this);
    const refId = refChild ? refChild._nodeId : null;
    const isConnectedBefore = isAttachedToDocument(newChild);
    this._rustDoc.insertBefore(this._nodeId, newChild._nodeId, refId);
    triggerConnectionLifecycle(newChild, isConnectedBefore);
    if (this._window && this._window._runScripts === "dangerously") {
      runScriptIfNecessary(newChild, this._window);
    }
    return newChild;
  }

  replaceChild(newChild, oldChild) {
    if (!(newChild instanceof Node)) {
      throw new Error("Parameter 1 of Node.replaceChild is not of type Node.");
    }
    if (!(oldChild instanceof Node)) {
      throw new Error("Parameter 2 of Node.replaceChild is not of type Node.");
    }
    if (newChild.tagName === "STYLE" || oldChild.tagName === "STYLE") markStylesDirty(this);
    const isConnectedNewBefore = isAttachedToDocument(newChild);
    const isConnectedOldBefore = isAttachedToDocument(oldChild);
    const ret = this._rustDoc.replaceChild(this._nodeId, newChild._nodeId, oldChild._nodeId);
    if (ret !== null) {
      triggerConnectionLifecycle(newChild, isConnectedNewBefore);
      triggerConnectionLifecycle(oldChild, isConnectedOldBefore);
      if (this._window && this._window._runScripts === "dangerously") {
        runScriptIfNecessary(newChild, this._window);
      }
      return oldChild;
    }
    throw new Error("Old child not found in parent.");
  }

  cloneNode(deep = false) {
    const clonedId = this._rustDoc.cloneNode(this._nodeId, !!deep);
    return wrapNode(this._rustDoc, clonedId, this._window);
  }

  getRootNode(options = {}) {
    const composed = !!options.composed;
    let curr = this;
    while (curr) {
      const parent = curr instanceof ShadowRoot ? (composed ? curr.host : null) : curr.parentNode;
      if (!parent) return curr;
      curr = parent;
    }
    return curr;
  }
}

class CSSStyleSheet {
  constructor(options = {}) {
    this.media = options.media || "";
    this.title = options.title || "";
    this.disabled = !!options.disabled;
    this._cssText = "";
    this._rules = [];
  }

  get cssRules() {
    return this._rules;
  }

  replace(cssText) {
    try {
      this.replaceSync(cssText);
      return Promise.resolve(this);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  replaceSync(cssText) {
    this._cssText = String(cssText);
    const parsed = parseCssRules(this._cssText);
    this._rules = parsed.map((rule, index) => {
      return {
        selectorText: rule.selector,
        style: {
          cssText: Object.entries(rule.declarations).map(([k, v]) => `${k}: ${v};`).join(" ")
        },
        _rule: rule
      };
    });
    
    if (this._owners) {
      for (const owner of this._owners) {
        markStylesDirty(owner);
      }
    }
  }
}

function createAdoptedStyleSheetsArray(owner) {
  const arr = [];
  return new Proxy(arr, {
    set(target, prop, value, receiver) {
      const success = Reflect.set(target, prop, value, receiver);
      if (success) {
        if (value instanceof CSSStyleSheet) {
          value._owners = value._owners || new Set();
          value._owners.add(owner);
        }
        markStylesDirty(owner);
      }
      return success;
    },
    deleteProperty(target, prop) {
      const value = target[prop];
      const success = Reflect.deleteProperty(target, prop);
      if (success) {
        if (value instanceof CSSStyleSheet && value._owners) {
          value._owners.delete(owner);
        }
        markStylesDirty(owner);
      }
      return success;
    }
  });
}

class DocumentFragment extends Node {
  get nodeType() {
    return 11;
  }

  get nodeName() {
    return "#document-fragment";
  }

  get innerHTML() {
    return this._rustDoc.getInnerHtml(this._nodeId) || "";
  }

  set innerHTML(val) {
    this._rustDoc.setInnerHtml(this._nodeId, String(val));
    if (this._window && this._window.customElements) {
      this._window.customElements.upgrade(this);
    }
    if (this._window && this._window._runScripts === "dangerously") {
      const scripts = this.querySelectorAll("script");
      scripts.forEach(s => runScriptIfNecessary(s, this._window));
    }
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

class ShadowRoot extends DocumentFragment {
  constructor(rustDoc, nodeId, window, host, mode) {
    super(rustDoc, nodeId, window);
    this.host = host;
    this.mode = mode;
    this.adoptedStyleSheets = createAdoptedStyleSheetsArray(this);
  }

  get nodeName() {
    return "#document-fragment";
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

  get style() {
    if (!this._style) {
      this._style = new CSSStyleDeclaration(this);
    }
    return this._style;
  }

  attachShadow(init) {
    if (!init || (init.mode !== "open" && init.mode !== "closed")) {
      throw new TypeError("Failed to execute 'attachShadow' on 'Element': member mode is required and must be 'open' or 'closed'.");
    }
    const validTags = [
      "article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3",
      "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"
    ];
    const isCustomElement = this.tagName.includes('-');
    if (!validTags.includes(this.tagName.toLowerCase()) && !isCustomElement) {
      throw new DOMException(`Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow`, "NotSupportedError");
    }
    if (this._shadowRoot !== undefined) {
      throw new DOMException(`Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.`, "InvalidStateError");
    }
    
    const nodeId = this._rustDoc.createDocumentFragment();
    const shadow = new ShadowRoot(this._rustDoc, nodeId, this._window, this, init.mode);
    this._shadowRoot = shadow;
    
    if (this._window && this._window._nodeCache) {
      this._window._nodeCache.set(nodeId, shadow);
    }
    
    return shadow;
  }

  get shadowRoot() {
    if (!this._shadowRoot || this._shadowRoot.mode === "closed") {
      return null;
    }
    return this._shadowRoot;
  }

  get innerHTML() {
    return this._rustDoc.getInnerHtml(this._nodeId) || "";
  }

  set innerHTML(val) {
    if (this.tagName === "TEMPLATE") {
      this.content.innerHTML = val;
    } else {
      this._rustDoc.setInnerHtml(this._nodeId, String(val));
      if (this._window && this._window.customElements) {
        this._window.customElements.upgrade(this);
      }
      if (this._window && this._window._runScripts === "dangerously") {
        const scripts = this.querySelectorAll("script");
        scripts.forEach(s => runScriptIfNecessary(s, this._window));
      }
    }
  }

  get content() {
    if (this.tagName !== "TEMPLATE") return undefined;
    if (!this._content) {
      const frag = this._window.document.createDocumentFragment();
      const childIds = this._rustDoc.getChildNodes(this._nodeId);
      for (const id of childIds) {
        this._rustDoc.appendChild(frag._nodeId, id);
      }
      this._content = frag;
    }
    return this._content;
  }

  get contentWindow() {
    if (this.tagName !== "IFRAME") return undefined;
    if (!this._contentWindow) {
      const iframeDoc = new RustDocument(""); // builds basic <html><head></head><body></body></html>
      const options = {
        runScripts: this._window ? this._window._runScripts : undefined,
        virtualConsole: this._window ? this._window._virtualConsole : undefined,
        storageQuota: this._window ? this._window._storageQuota : undefined,
        resources: this._window ? this._window._resources : undefined,
        pretendToBeVisual: this._window ? this._window._pretendToBeVisual : undefined
      };
      const win = new Window(iframeDoc, options, "text/html");
      win.parent = this._window;
      win.top = this._window ? this._window.top : win;
      
      const src = this.getAttribute("src");
      if (src) {
        try {
          const base = this._window ? this._window.location.href : "about:blank";
          win.location.href = new URL(src, base).href;
        } catch (e) {}
      }
      
      // Contextify iframe contentWindow if scripting is enabled!
      if (options.runScripts === "dangerously" || options.runScripts === "outside-only") {
        const rawWin = win[Symbol.for("unproxied")];
        vm.createContext(rawWin);
        win._context = rawWin;
        win.eval = (code) => {
          return vm.runInContext(String(code), rawWin);
        };
      }
      
      this._contentWindow = win;
      this._contentDocument = win.document;
    }
    return this._contentWindow;
  }

  get contentDocument() {
    if (this.tagName !== "IFRAME") return undefined;
    if (!this._contentDocument) {
      const win = this.contentWindow; // forces creation
    }
    return this._contentDocument;
  }

  click() {
    const event = new Event("click", { bubbles: true, cancelable: true });
    this.dispatchEvent(event);
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  get attributes() {
    const attrs = this._rustDoc.getAttributes(this._nodeId);
    if (!attrs) {
      const arr = [];
      arr.getNamedItem = () => null;
      return arr;
    }
    const arr = Object.keys(attrs).map(name => ({ name, value: attrs[name] }));
    arr.getNamedItem = (name) => arr.find(a => a.name === name) || null;
    return arr;
  }

  getAttribute(name) {
    return this._rustDoc.getAttribute(this._nodeId, name);
  }

  setAttribute(name, value) {
    const valStr = String(value);
    const oldVal = this.getAttribute(name);
    this._rustDoc.setAttribute(this._nodeId, name, valStr);
    
    // Check if setting inline event handler
    if (name.startsWith("on")) {
      const eventType = name.slice(2);
      if (this._window && this._window._runScripts === "dangerously") {
        try {
          const context = this._window._context || this._window;
          const handler = vm.runInContext(`(function(event) { ${valStr} })`, context);
          this[name] = handler; // Set it via property setter to trigger aliasing & addEventListener!
        } catch (e) {
          reportException(this._window, e, this._window.location.href);
        }
      }
    }
    
    if (this._customElementState === "upgraded") {
      const constructor = this.constructor;
      if (Array.isArray(constructor.observedAttributes) && constructor.observedAttributes.includes(name)) {
        if (typeof this.attributeChangedCallback === 'function') {
          try {
            this.attributeChangedCallback(name, oldVal, valStr);
          } catch (e) {
            reportException(this._window, e, this._window.location.href);
          }
        }
      }
    }
  }

  removeAttribute(name) {
    const oldVal = this.getAttribute(name);
    this._rustDoc.removeAttribute(this._nodeId, name);
    if (name.startsWith("on")) {
      this["on" + name.slice(2)] = null; // triggers setter to clean up
    }
    
    if (this._customElementState === "upgraded") {
      const constructor = this.constructor;
      if (Array.isArray(constructor.observedAttributes) && constructor.observedAttributes.includes(name)) {
        if (typeof this.attributeChangedCallback === 'function') {
          try {
            this.attributeChangedCallback(name, oldVal, null);
          } catch (e) {
            reportException(this._window, e, this._window.location.href);
          }
        }
      }
    }
  }

  querySelector(selector) {
    const matchedId = this._rustDoc.querySelector(this._nodeId, selector);
    return wrapNode(this._rustDoc, matchedId, this._window);
  }

  matches(selector) {
    return this._rustDoc.matches(this._nodeId, selector);
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

let CanvasBackend = null;
let canvasLoadAttempted = false;

function getCanvasBackend() {
  if (canvasLoadAttempted) return CanvasBackend;
  canvasLoadAttempted = true;
  try {
    CanvasBackend = require("@napi-rs/canvas");
  } catch (e1) {
    try {
      CanvasBackend = require("canvas");
    } catch (e2) {
      CanvasBackend = null;
    }
  }
  return CanvasBackend;
}

function createMockCanvasContext2D(canvasElement) {
  const mockContext = {
    canvas: canvasElement,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "10px sans-serif",
    lineWidth: 1,
  };
  
  return new Proxy(mockContext, {
    get(target, prop, receiver) {
      if (prop in target) {
        return target[prop];
      }
      return (...args) => {
        if (prop === "measureText") {
          const text = args[0] || "";
          return {
            width: text.length * 6,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: text.length * 6,
            actualBoundingBoxAscent: 0,
            actualBoundingBoxDescent: 0,
          };
        }
        if (prop === "getImageData") {
          const w = args[2] || 0;
          const h = args[3] || 0;
          return {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4)
          };
        }
        if (prop === "createImageData") {
          const w = args[0] || 0;
          const h = args[1] || 0;
          return {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4)
          };
        }
        return undefined;
      };
    },
    set(target, prop, value, receiver) {
      target[prop] = value;
      return true;
    }
  });
}

function createCanvasContext2D(canvasElement) {
  const backend = getCanvasBackend();
  if (backend) {
    const width = canvasElement.width;
    const height = canvasElement.height;
    let nativeCanvas;
    if (typeof backend.createCanvas === "function") {
      nativeCanvas = backend.createCanvas(width, height);
    } else if (typeof backend.Canvas === "function") {
      nativeCanvas = new backend.Canvas(width, height);
    }
    
    if (nativeCanvas) {
      canvasElement._canvasBackend = nativeCanvas;
      return nativeCanvas.getContext("2d");
    }
  }
  return createMockCanvasContext2D(canvasElement);
}

class HTMLCanvasElement extends Element {
  get width() {
    const val = this.getAttribute("width");
    return val !== null ? (parseInt(val, 10) || 300) : 300;
  }

  set width(val) {
    const num = parseInt(val, 10) || 300;
    this.setAttribute("width", String(num));
    if (this._canvasBackend) {
      this._canvasBackend.width = num;
    }
  }

  get height() {
    const val = this.getAttribute("height");
    return val !== null ? (parseInt(val, 10) || 150) : 150;
  }

  set height(val) {
    const num = parseInt(val, 10) || 150;
    this.setAttribute("height", String(num));
    if (this._canvasBackend) {
      this._canvasBackend.height = num;
    }
  }

  getContext(contextId, options) {
    if (contextId === "2d") {
      if (!this._canvasContext) {
        this._canvasContext = createCanvasContext2D(this);
      }
      return this._canvasContext;
    }
    return null;
  }

  toDataURL(type, encoderOptions) {
    if (this._canvasBackend && typeof this._canvasBackend.toDataURL === "function") {
      return this._canvasBackend.toDataURL(type, encoderOptions);
    }
    return "data:image/png;base64,";
  }

  toBuffer(type, encoderOptions) {
    if (this._canvasBackend && typeof this._canvasBackend.toBuffer === "function") {
      return this._canvasBackend.toBuffer(type, encoderOptions);
    }
    return Buffer.alloc(0);
  }
}


class CustomElementRegistry {
  constructor(window) {
    this._window = window;
    this._registry = new Map();
    this._whenDefinedPromises = new Map();
    this._whenDefinedResolvers = new Map();
  }

  define(name, constructor, options = {}) {
    if (typeof name !== 'string' || !name.includes('-')) {
      throw new DOMException(`Registration failed for '${name}'. The name is not a valid custom element name.`, 'NotSupportedError');
    }
    if (this._registry.has(name)) {
      throw new DOMException(`Registration failed for '${name}'. A duplicate definition was found.`, 'NotSupportedError');
    }
    this._registry.set(name, { constructor, options });
    
    if (this._whenDefinedResolvers.has(name)) {
      this._whenDefinedResolvers.get(name)();
      this._whenDefinedResolvers.delete(name);
      this._whenDefinedPromises.delete(name);
    }
    
    this.upgrade(this._window.document);
  }

  get(name) {
    const entry = this._registry.get(name);
    return entry ? entry.constructor : undefined;
  }

  whenDefined(name) {
    if (typeof name !== 'string' || !name.includes('-')) {
      return Promise.reject(new DOMException(`Invalid custom element name: '${name}'`, 'SyntaxError'));
    }
    if (this._registry.has(name)) {
      return Promise.resolve();
    }
    if (this._whenDefinedPromises.has(name)) {
      return this._whenDefinedPromises.get(name);
    }
    const promise = new Promise(resolve => {
      this._whenDefinedResolvers.set(name, resolve);
    });
    this._whenDefinedPromises.set(name, promise);
    return promise;
  }

  upgrade(root) {
    const upgradeElement = (element) => {
      const name = element.localName;
      if (name) {
        const definition = this._registry.get(name);
        if (definition && !element._customElementState) {
          this._upgradeElementWithDefinition(element, definition);
        }
      }
      
      if (element.shadowRoot) {
        upgradeElement(element.shadowRoot);
      }
      const children = element.children;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          upgradeElement(children[i]);
        }
      }
    };
    upgradeElement(root);
  }

  _upgradeElementWithDefinition(element, definition) {
    element._customElementState = "upgraded";
    const constructor = definition.constructor;
    
    Object.setPrototypeOf(element, constructor.prototype);
    
    try {
      HTMLElement._constructionStack.push(element);
      new constructor();
    } catch (e) {
      console.error("Custom element construction failed:", e);
    } finally {
      HTMLElement._constructionStack.pop();
    }

    if (isAttachedToDocument(element)) {
      if (typeof element.connectedCallback === 'function') {
        try {
          element.connectedCallback();
        } catch (e) {
          reportException(this._window, e, this._window.location.href);
        }
      }
    }

    if (Array.isArray(constructor.observedAttributes)) {
      const attrs = element.attributes;
      for (const attr of attrs) {
        if (constructor.observedAttributes.includes(attr.name)) {
          if (typeof element.attributeChangedCallback === 'function') {
            try {
              element.attributeChangedCallback(attr.name, null, attr.value);
            } catch (e) {
              reportException(this._window, e, this._window.location.href);
            }
          }
        }
      }
    }
  }
}

class HTMLElement extends Element {
  constructor() {
    super();
    const upgradeElement = HTMLElement._constructionStack[HTMLElement._constructionStack.length - 1];
    if (upgradeElement) {
      return upgradeElement;
    }
    let foundTagName = null;
    let win = null;
    for (const activeWin of activeWindows) {
      if (activeWin.customElements) {
        for (const [tag, def] of activeWin.customElements._registry.entries()) {
          if (def.constructor === new.target) {
            foundTagName = tag;
            win = activeWin;
            break;
          }
        }
      }
      if (win) break;
    }
    if (!foundTagName) {
      throw new TypeError("Illegal constructor");
    }
    const doc = win.document;
    const nodeId = doc._rustDoc.createElement(foundTagName);
    const node = wrapNode(doc._rustDoc, nodeId, win);
    Object.setPrototypeOf(node, new.target.prototype);
    return node;
  }
}
HTMLElement._constructionStack = [];

class Document extends Node {
  constructor(rustDoc, nodeId, window) {
    super(rustDoc, nodeId, window);
    this.adoptedStyleSheets = createAdoptedStyleSheetsArray(this);
  }

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
    if (this._window && this._window.customElements) {
      this._window.customElements.upgrade(this);
    }
    if (this._window && this._window._runScripts === "dangerously") {
      const scripts = this.querySelectorAll("script");
      scripts.forEach(s => runScriptIfNecessary(s, this._window));
    }
  }

  get hidden() {
    return this._window ? this._window._hidden : true;
  }

  get visibilityState() {
    return this._window ? this._window._visibilityState : "prerender";
  }

  get contentType() {
    return this._window ? this._window._contentType : "text/html";
  }

  get referrer() {
    return this._referrer || "";
  }

  get doctype() {
    return null;
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
    const tagLower = tagName.toLowerCase();
    const nodeId = this._rustDoc.createElement(tagLower);
    const node = wrapNode(this._rustDoc, nodeId, this._window);
    if (this._window && this._window.customElements) {
      const def = this._window.customElements._registry.get(tagLower);
      if (def && !node._customElementState) {
        this._window.customElements._upgradeElementWithDefinition(node, def);
      }
    }
    return node;
  }

  createTextNode(text) {
    const nodeId = this._rustDoc.createTextNode(String(text));
    return wrapNode(this._rustDoc, nodeId, this._window);
  }

  createDocumentFragment() {
    const nodeId = this._rustDoc.createDocumentFragment();
    return wrapNode(this._rustDoc, nodeId, this._window);
  }

  get cookie() {
    return this._window._cookieJar.getCookieStringSync(this.URL, { http: false });
  }

  set cookie(val) {
    try {
      this._window._cookieJar.setCookieSync(String(val), this.URL, { http: false, ignoreError: true });
    } catch (e) {}
  }

  open() {
    this.innerHTML = "";
    this._writeBuffer = "";
  }

  write(html) {
    if (this._writeBuffer === undefined) {
      this._writeBuffer = "";
    }
    this._writeBuffer += String(html);
  }

  close() {
    if (this._writeBuffer) {
      this.innerHTML = this._writeBuffer;
      this._writeBuffer = "";
    }
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

class Window extends EventTarget {
  constructor(rustDoc, options = {}, contentType = "text/html", url = "about:blank", referrer = "") {
    super();
    activeWindows.add(this);
    this._rustDoc = rustDoc;
    this._nodeCache = new Map();
    this.window = this;
    this.self = this;
    this.top = this;
    this.parent = this;
    
    this._runScripts = options.runScripts;
    this._resources = options.resources;
    this._contentType = contentType;
    this._cookieJar = options.cookieJar || new CookieJar();
    this._virtualConsole = options.virtualConsole || new VirtualConsole();
    this.console = createConsole(this._virtualConsole);
    
    // pretendToBeVisual options
    this._pretendToBeVisual = !!options.pretendToBeVisual;
    this._hidden = !this._pretendToBeVisual;
    this._visibilityState = this._pretendToBeVisual ? "visible" : "prerender";
    
    if (this._pretendToBeVisual) {
      this.requestAnimationFrame = (cb) => {
        return setTimeout(() => {
          try { cb(Date.now()); } catch(e) { reportException(this, e, this.location.href); }
        }, 16);
      };
      this.cancelAnimationFrame = (id) => {
        clearTimeout(id);
      };
    }
    
    const quota = options.storageQuota !== undefined ? Number(options.storageQuota) : 5000000;
    this.localStorage = new Storage(quota);
    this.sessionStorage = new Storage(quota);
    
    // Instantiate document and register in the cache
    this.document = new Document(rustDoc, 0, this);
    this.document._referrer = referrer;
    this._nodeCache.set(0, this.document);
    
    // Custom elements registry
    this.customElements = new CustomElementRegistry(this);
    
    // Prototypes chain exposure
    this.Window = Window;
    this.Node = Node;
    this.Element = Element;
    this.HTMLCanvasElement = HTMLCanvasElement;
    this.CSSStyleDeclaration = CSSStyleDeclaration;
    this.Document = Document;
    this.DocumentFragment = DocumentFragment;
    this.Event = Event;
    this.CustomEvent = CustomEvent;
    this.EventTarget = EventTarget;
    this.CSSStyleSheet = CSSStyleSheet;
    this.ShadowRoot = ShadowRoot;
    this.CustomElementRegistry = CustomElementRegistry;
    
    // Alias HTML elements for drop-in prototype checks
    this.HTMLElement = HTMLElement;
    this.HTMLDivElement = HTMLElement;
    this.HTMLAnchorElement = HTMLElement;
    this.HTMLSpanElement = HTMLElement;
    this.HTMLInputElement = HTMLElement;
    this.HTMLButtonElement = HTMLElement;
    this.HTMLUListElement = HTMLElement;
    this.HTMLOListElement = HTMLElement;
    this.HTMLLIElement = HTMLElement;
    this.HTMLParagraphElement = HTMLElement;
    this.HTMLImageElement = HTMLElement;
    this.HTMLTemplateElement = HTMLElement;
    this.HTMLIFrameElement = HTMLElement;
    
    this.navigator = { userAgent: options.userAgent || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" };
    this.history = {
      state: null,
      pushState(state, title, url) {},
      replaceState(state, title, url) {}
    };
    
    this.getComputedStyle = this.getComputedStyle.bind(this);
    
    // Install Node.js globals on Window (aliased globals) if scripting is off
    const jsGlobals = [
      "Object", "Function", "Array", "Number", "parseFloat", "parseInt", "Infinity", "NaN", "undefined",
      "Boolean", "String", "Symbol", "Date", "Promise", "RegExp", "Error", "AggregateError", "EvalError",
      "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "globalThis", "JSON", "Math",
      "Intl", "ArrayBuffer", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array",
      "Float32Array", "Float64Array", "Uint8ClampedArray", "BigUint64Array", "BigInt64Array", "DataView", "Map",
      "BigInt", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "FinalizationRegistry", "WeakRef", "decodeURI",
      "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape", "eval", "isFinite", "isNaN",
      "SharedArrayBuffer", "Atomics", "WebAssembly"
    ];
    if (options.runScripts !== "dangerously" && options.runScripts !== "outside-only") {
      for (const key of jsGlobals) {
        try {
          const desc = Object.getOwnPropertyDescriptor(global, key);
          if (desc) {
            Object.defineProperty(this, key, desc);
          }
        } catch (e) {}
      }
    }
    
    const locationObj = {
      _href: url,
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
    
    try {
      const u = new URL(url);
      locationObj._href = u.href;
      locationObj.protocol = u.protocol;
      locationObj.host = u.host;
      locationObj.hostname = u.hostname;
      locationObj.port = u.port;
      locationObj.pathname = u.pathname;
      locationObj.search = u.search;
      locationObj.hash = u.hash;
    } catch (e) {}
    
    const windowInstance = this;
    this.location = Object.create(null);
    Object.defineProperties(this.location, {
      href: {
        get() {
          return locationObj._href;
        },
        set(val) {
          try {
            const oldUrl = locationObj._href;
            const u = new URL(val, oldUrl);
            locationObj._href = u.href;
            locationObj.protocol = u.protocol;
            locationObj.host = u.host;
            locationObj.hostname = u.hostname;
            locationObj.port = u.port;
            locationObj.pathname = u.pathname;
            locationObj.search = u.search;
            locationObj.hash = u.hash;
            
            const newUrl = u.href;
            const oldBase = oldUrl.split('#')[0];
            const newBase = newUrl.split('#')[0];
            if (oldBase === newBase && oldUrl !== newUrl) {
              const event = new Event("hashchange");
              Object.defineProperty(event, 'oldURL', { value: oldUrl, enumerable: true });
              Object.defineProperty(event, 'newURL', { value: newUrl, enumerable: true });
              windowInstance.dispatchEvent(event);
            }
          } catch (e) {
            throw new TypeError(`Could not parse "${val}" as a URL`);
          }
        },
        enumerable: true,
        configurable: true
      },
      hash: {
        get() {
          return locationObj.hash;
        },
        set(val) {
          const hashVal = String(val);
          const formattedHash = hashVal.startsWith("#") ? hashVal : "#" + hashVal;
          if (locationObj.hash !== formattedHash) {
            const oldUrl = locationObj._href;
            const u = new URL(locationObj._href);
            u.hash = formattedHash;
            
            locationObj._href = u.href;
            locationObj.hash = formattedHash;
            
            const event = new Event("hashchange");
            Object.defineProperty(event, 'oldURL', { value: oldUrl, enumerable: true });
            Object.defineProperty(event, 'newURL', { value: u.href, enumerable: true });
            windowInstance.dispatchEvent(event);
          }
        },
        enumerable: true,
        configurable: true
      }
    });
    
    for (const key of ["protocol", "host", "hostname", "port", "pathname", "search", "assign", "replace", "reload"]) {
      Object.defineProperty(this.location, key, {
        get() { return locationObj[key]; },
        set(val) { locationObj[key] = val; },
        enumerable: true,
        configurable: true
      });
    }
    
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === Symbol.for("unproxied")) {
          return target;
        }
        if (typeof prop === 'string') {
          const index = Number(prop);
          if (Number.isInteger(index) && index >= 0) {
            const iframes = target.document.querySelectorAll("iframe");
            if (index < iframes.length) {
              return iframes[index].contentWindow;
            }
          }
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  close() {
    activeWindows.delete(this);
    this._nodeCache.clear();
  }

  getComputedStyle(element) {
    if (!(element instanceof Element)) {
      throw new TypeError("parameter 1 is not of type Element.");
    }
    
    const computed = new CSSStyleDeclaration(null, true);
    
    const roots = [];
    let curr = element;
    while (curr) {
      const root = curr.getRootNode();
      if (root && !roots.includes(root)) {
        roots.push(root);
      }
      if (curr instanceof ShadowRoot) {
        curr = curr.host;
      } else {
        curr = curr.parentNode;
      }
    }
    
    const rules = [];
    
    const doc = element._window ? element._window.document : null;
    if (doc) {
      if (!doc._cachedStylesVersion || doc._cachedStylesVersion !== doc._stylesVersion) {
        const styles = doc.querySelectorAll("style");
        const docRules = [];
        styles.forEach(styleEl => {
          docRules.push(...parseCssRules(styleEl.textContent));
        });
        if (doc.adoptedStyleSheets) {
          for (const sheet of doc.adoptedStyleSheets) {
            if (!sheet.disabled) {
              docRules.push(...sheet.cssRules.map(r => r._rule));
            }
          }
        }
        docRules.forEach((rule, index) => {
          rule.specificity = getSpecificity(rule.selector);
          rule.index = index;
        });
        docRules.sort((a, b) => {
          if (a.specificity !== b.specificity) {
            return a.specificity - b.specificity;
          }
          return a.index - b.index;
        });
        doc._cachedRules = docRules;
        doc._cachedStylesVersion = doc._stylesVersion || 1;
      }
      if (doc._cachedRules) {
        rules.push(...doc._cachedRules);
      }
    }
    
    for (const root of roots) {
      if (root instanceof ShadowRoot) {
        const styles = root.querySelectorAll("style");
        const srRules = [];
        styles.forEach(styleEl => {
          srRules.push(...parseCssRules(styleEl.textContent));
        });
        if (root.adoptedStyleSheets) {
          for (const sheet of root.adoptedStyleSheets) {
            if (!sheet.disabled) {
              srRules.push(...sheet.cssRules.map(r => r._rule));
            }
          }
        }
        srRules.forEach((rule, index) => {
          rule.specificity = getSpecificity(rule.selector);
          rule.index = index;
        });
        srRules.sort((a, b) => {
          if (a.specificity !== b.specificity) {
            return a.specificity - b.specificity;
          }
          return a.index - b.index;
        });
        rules.push(...srRules);
      }
    }
    
    for (const rule of rules) {
      if (element.matches(rule.selector)) {
        for (const [prop, val] of Object.entries(rule.declarations)) {
          computed._values.set(prop, val);
        }
      }
    }
    
    const inline = new CSSStyleDeclaration(element, true);
    for (const [prop, val] of inline._values.entries()) {
      computed._values.set(prop, val);
    }
    
    return computed;
  }
}

// Event handler properties on prototypes
defineEventHandlerProperty(Window.prototype, "hashchange");
defineEventHandlerProperty(Window.prototype, "click");
defineEventHandlerProperty(Window.prototype, "load");
defineEventHandlerProperty(Window.prototype, "error");

defineEventHandlerProperty(Node.prototype, "click");
defineEventHandlerProperty(Node.prototype, "load");
defineEventHandlerProperty(Node.prototype, "error");
defineEventHandlerProperty(Node.prototype, "hashchange", true); // aliases to window

// frames getter on Window
Object.defineProperty(Window.prototype, "frames", {
  get() {
    return this;
  },
  configurable: true,
  enumerable: true
});

let sharedFragmentDocument = null;

class JSDOM {
  constructor(html, options = {}) {
    const input = html === undefined ? "" : String(html);
    
    if (options.runScripts !== undefined && options.runScripts !== "dangerously" && options.runScripts !== "outside-only") {
      throw new RangeError(`The given runScripts "${options.runScripts}" is not one of: dangerously, outside-only`);
    }
    
    let contentType = "text/html";
    if (options.contentType !== undefined) {
      try {
        const mime = new MIMEType(options.contentType);
        const type = mime.essence;
        if (type !== "text/html" && type !== "application/xhtml+xml" && !type.endsWith("+xml")) {
          throw new RangeError(`The given contentType "${options.contentType}" is not an HTML or XML content type`);
        }
        contentType = type;
      } catch (err) {
        if (err instanceof RangeError) throw err;
        throw new Error(`The given contentType "${options.contentType}" is unparseable`);
      }
    }
    
    if (options.includeNodeLocations && contentType !== "text/html") {
      throw new Error("includeNodeLocations is not supported with XML content types");
    }
    
    let referrer = "";
    if (options.referrer !== undefined) {
      const refStr = String(options.referrer);
      try {
        referrer = new URL(refStr).href;
      } catch (e) {
        throw new TypeError(`The given referrer "${options.referrer}" is not a valid absolute URL`);
      }
    }

    let url = "about:blank";
    if (options.url !== undefined) {
      const urlStr = String(options.url);
      try {
        url = new URL(urlStr).href;
      } catch (e) {
        throw new TypeError(`The given url "${options.url}" is not a valid absolute URL`);
      }
    }
    
    // If beforeParse option is set, we construct an empty document initially.
    // Otherwise we parse the HTML input immediately.
    this._rustDoc = options.beforeParse ? new RustDocument() : new RustDocument(input);
    this._runScripts = options.runScripts;
    
    // Create window
    const win = new Window(this._rustDoc, options, contentType, url, referrer);
    this.window = win;
    
    // If runScripts option is enabled, contextify the window
    if (options.runScripts === "dangerously" || options.runScripts === "outside-only") {
      const rawWin = win[Symbol.for("unproxied")];
      vm.createContext(rawWin);
      win._context = rawWin;
      win.eval = (code) => {
        return vm.runInContext(String(code), rawWin);
      };
      
      // Copy fresh VM globals onto the window object
      const jsGlobals = [
        "Object", "Function", "Array", "Number", "parseFloat", "parseInt", "Infinity", "NaN", "undefined",
        "Boolean", "String", "Symbol", "Date", "Promise", "RegExp", "Error", "AggregateError", "EvalError",
        "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "globalThis", "JSON", "Math",
        "Intl", "ArrayBuffer", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array",
        "Float32Array", "Float64Array", "Uint8ClampedArray", "BigUint64Array", "BigInt64Array", "DataView", "Map",
        "BigInt", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "FinalizationRegistry", "WeakRef", "decodeURI",
        "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape", "eval", "isFinite", "isNaN",
        "SharedArrayBuffer", "Atomics", "WebAssembly"
      ];
      for (const key of jsGlobals) {
        try {
          const val = vm.runInContext(key, rawWin);
          const desc = Object.getOwnPropertyDescriptor(global, key) || {
            writable: true,
            enumerable: false,
            configurable: true
          };
          Object.defineProperty(win, key, { ...desc, value: val });
        } catch (e) {}
      }
    }
    
    if (options.beforeParse) {
      options.beforeParse(this.window);
      // Run parser now on the input HTML
      this._rustDoc.parse(input);
    }
    
    // Handle <noscript> tag children parsing fallback if scripting is disabled/outside-only
    if (options.runScripts !== "dangerously") {
      const noscripts = this.window.document.querySelectorAll("noscript");
      noscripts.forEach(noscript => {
        if (noscript.childNodes.length === 1 && noscript.firstChild.nodeType === 3) {
          const text = noscript.textContent;
          noscript.innerHTML = text;
        }
      });
    }
    
    // Parse inline event handlers if any from the initial DOM tree
    if (options.runScripts === "dangerously") {
      const allElements = this.window.document.querySelectorAll("*");
      allElements.forEach(el => {
        const attrs = el.attributes;
        for (const attr of attrs) {
          if (attr.name.startsWith("on")) {
            const eventType = attr.name.slice(2);
            try {
              const context = this.window._context || this.window;
              const handler = vm.runInContext(`(function(event) { ${attr.value} })`, context);
              el["on" + eventType] = handler; // Set it via property setter to trigger aliasing & addEventListener!
            } catch (e) {
              reportException(this.window, e, this.window.location.href);
            }
          }
        }
      });
    }
    
    if (options.runScripts === "dangerously") {
      // Find all script tags in the parsed document and run them
      const scripts = this.window.document.querySelectorAll("script");
      let lastIndex = 0;
      scripts.forEach(script => {
        if (!script._alreadyStarted) {
          script._alreadyStarted = true;
          
          let lineOffset = 0;
          if (options.includeNodeLocations) {
            const nextScriptIndex = input.indexOf("<script", lastIndex);
            if (nextScriptIndex !== -1) {
              const textBefore = input.substring(0, nextScriptIndex);
              lineOffset = textBefore.split("\n").length - 1;
              lastIndex = nextScriptIndex + 7;
            }
          }
          
          if (script.hasAttribute("src")) {
            fetchAndRunExternalScript(script, this.window);
          } else {
            const code = script.textContent;
            try {
              const context = this.window._context || this.window;
              vm.runInContext(code, context, {
                filename: this.window.location.href,
                lineOffset: lineOffset,
                displayErrors: false
              });
            } catch (err) {
              reportException(this.window, err, this.window.location.href);
            }
          }
        }
      });
    }
    
    // Dispatch onload event asynchronously (after parsing is complete)
    process.nextTick(() => {
      const event = new Event("load");
      this.window.dispatchEvent(event);
    });
  }

  get cookieJar() {
    return this.window._cookieJar;
  }

  get virtualConsole() {
    return this.window._virtualConsole;
  }

  serialize() {
    return this._rustDoc.getOuterHtml(0);
  }

  getInternalVMContext() {
    if (this._runScripts === "outside-only" || this._runScripts === "dangerously") {
      return this.window._context || this.window;
    }
    throw new TypeError("This jsdom was not configured to allow script running. Use the runScripts option during creation.");
  }

  reconfigure(settings) {
    if ("url" in settings) {
      this.window.location.href = settings.url;
    }
    if ("windowTop" in settings) {
      this.window.top = settings.windowTop;
    }
  }

  static fragment(string = "") {
    if (!sharedFragmentDocument) {
      sharedFragmentDocument = (new JSDOM()).window.document;
    }
    const template = sharedFragmentDocument.createElement("template");
    template.innerHTML = string;
    return template.content;
  }

  static async fromURL(url, options = {}) {
    const ua = options.userAgent || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    const headers = { "User-Agent": ua };
    if (options.referrer) {
      headers["Referer"] = options.referrer;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Failed to fetch URL: ${res.statusText}`);
    
    const contentTypeHeader = res.headers.get("content-type");
    let optionsWithContentType = { ...options };
    if (contentTypeHeader && !options.contentType) {
      optionsWithContentType.contentType = contentTypeHeader.split(";")[0].trim();
    }
    
    const html = await res.text();
    return new JSDOM(html, optionsWithContentType);
  }

  static async fromFile(filename, options = {}) {
    const fs = require("node:fs").promises;
    const path = require("node:path");
    const html = await fs.readFile(filename, "utf8");
    const fileUrl = require("node:url").pathToFileURL(path.resolve(filename)).href;
    return new JSDOM(html, { url: fileUrl, ...options });
  }
}

module.exports = {
  JSDOM,
  Window,
  Document,
  Element,
  HTMLCanvasElement,
  CSSStyleDeclaration,
  Node,
  Event,
  CustomEvent,
  EventTarget,
  DocumentFragment,
  VirtualConsole,
  CookieJar,
  toughCookie,
  CSSStyleSheet,
  ShadowRoot,
  CustomElementRegistry,
  HTMLElement
};
