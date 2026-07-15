const path = require("node:path");
const Module = require("module");

let nativeBinding;
try {
  nativeBinding = require('./jsdom_rs.node');
} catch (e) {
  const platform = process.platform;
  const arch = process.arch;
  const libc = platform === 'linux' ? (process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'musl') : '';
  
  const possibleNames = [
    `./jsdom_rs.${platform}-${arch}${libc ? '-' + libc : ''}.node`,
    `./jsdom_rs.${platform}-${arch}.node`,
    `./jsdom_rs.node`
  ];
  
  let loaded = false;
  for (const name of possibleNames) {
    try {
      nativeBinding = require(name);
      loaded = true;
      break;
    } catch (err) {}
  }
  
  if (!loaded) {
    throw new Error(`Failed to load native binding jsdom_rs. Tried: ${possibleNames.join(', ')}. Underlying error: ${e.message}`);
  }
}

const { RustDocument } = nativeBinding;

// Lazy-loaded JSDOM internal helpers
let idlUtils, domSymbolTree, nwsapi, selectorsModule;
function lazyLoadHelpers() {
  if (!idlUtils) {
    idlUtils = require("jsdom/lib/jsdom/living/generated/utils");
    domSymbolTree = require("jsdom/lib/jsdom/living/helpers/internal-constants").domSymbolTree;
    nwsapi = require("nwsapi");
    selectorsModule = require("jsdom/lib/jsdom/living/helpers/selectors");
  }
}

// Helper to mark a document as dirty when its structure changes
function markDirty(nodeImpl) {
  if (!nodeImpl) return;
  lazyLoadHelpers();
  let root = nodeImpl;
  while (domSymbolTree.parent(root)) {
    root = domSymbolTree.parent(root);
  }
  root._rustSynced = false;
  
  const doc = nodeImpl._ownerDocument;
  if (doc) {
    doc._rustSynced = false;
  }
}

// Traverse JSDOM Node tree and sync it to our native RustDocument
function syncNodeToRust(nodeImpl, rustDoc, parentRustId, idMap) {
  lazyLoadHelpers();
  let rustId;
  const nodeType = nodeImpl.nodeType;
  
  if (nodeType === 1) { // ELEMENT_NODE
    rustId = rustDoc.createElement(nodeImpl._localName);
    const attrs = nodeImpl._attributeList;
    if (attrs) {
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i];
        rustDoc.setAttribute(rustId, attr._localName, attr._value);
      }
    }
  } else if (nodeType === 3) { // TEXT_NODE
    rustId = rustDoc.createTextNode(nodeImpl._data || "");
  } else if (nodeType === 8) { // COMMENT_NODE
    rustId = rustDoc.createTextNode(""); // Treat comment as empty text for selectors
  } else if (nodeType === 9) { // DOCUMENT_NODE
    rustId = 0;
  } else {
    rustId = rustDoc.createDocumentFragment();
  }

  nodeImpl._rustId = rustId;
  idMap[rustId] = idlUtils.wrapperForImpl(nodeImpl);

  if (parentRustId !== undefined && rustId !== 0) {
    rustDoc.appendChild(parentRustId, rustId);
  }

  for (const child of domSymbolTree.childrenIterator(nodeImpl)) {
    syncNodeToRust(child, rustDoc, rustId, idMap);
  }
}

// Retrieve nwsapi for fallback
function getOriginalNwsapi(nodeImpl) {
  lazyLoadHelpers();
  const document = nodeImpl._ownerDocument || nodeImpl;
  if (!document._originalNwsapi) {
    const { _globalObject } = nodeImpl;
    document._originalNwsapi = nwsapi({
      document: idlUtils.wrapperForImpl(document),
      DOMException: _globalObject.DOMException
    });
    document._originalNwsapi.configure({
      LOGERRORS: false,
      VERBOSITY: false, // suppresses selector syntax errors
      IDS_DUPES: true,
      MIXEDCASE: true
    });
  }
  return document._originalNwsapi;
}

function getMatcher(nodeImpl) {
  lazyLoadHelpers();
  // Find the top-most root node in JSDOM's symbol tree (e.g. Document or DocumentFragment)
  let root = nodeImpl;
  while (domSymbolTree.parent(root)) {
    root = domSymbolTree.parent(root);
  }
  
  if (!root._rustSynced) {
    const rustDoc = new RustDocument();
    const idMap = [];
    syncNodeToRust(root, rustDoc, undefined, idMap);
    root._rustDoc = rustDoc;
    root._rustIdMap = idMap;
    root._rustSynced = true;
  }
  
  return {
    rustDoc: root._rustDoc,
    idMap: root._rustIdMap,
    rustId: nodeImpl._rustId
  };
}

const mockNwsapi = {
  first(selector, elementWrapper) {
    try {
      const nodeImpl = idlUtils.implForWrapper(elementWrapper);
      const { rustDoc, idMap, rustId } = getMatcher(nodeImpl);
      if (rustId !== undefined) {
        const matchedId = rustDoc.querySelector(rustId, selector);
        if (matchedId !== null && matchedId !== undefined) {
          return idMap[matchedId] || null;
        }
      }
    } catch (e) {
      // Fallback
    }
    try {
      const nodeImpl = idlUtils.implForWrapper(elementWrapper);
      return getOriginalNwsapi(nodeImpl).first(selector, elementWrapper);
    } catch (err) {
      return null;
    }
  },
  select(selector, elementWrapper) {
    try {
      const nodeImpl = idlUtils.implForWrapper(elementWrapper);
      const { rustDoc, idMap, rustId } = getMatcher(nodeImpl);
      if (rustId !== undefined) {
        const matchedIds = rustDoc.querySelectorAll(rustId, selector);
        const results = [];
        for (let i = 0; i < matchedIds.length; i++) {
          const wrapper = idMap[matchedIds[i]];
          if (wrapper) {
            results.push(wrapper);
          }
        }
        return results;
      }
    } catch (e) {
      // Fallback
    }
    try {
      const nodeImpl = idlUtils.implForWrapper(elementWrapper);
      return getOriginalNwsapi(nodeImpl).select(selector, elementWrapper);
    } catch (err) {
      return [];
    }
  },
  match(selector, elementWrapper) {
    try {
      const nodeImpl = idlUtils.implForWrapper(elementWrapper);
      const { rustDoc, rustId } = getMatcher(nodeImpl);
      if (rustId !== undefined) {
        return rustDoc.matches(rustId, selector);
      }
    } catch (e) {
      // Fallback
    }
    try {
      const nodeImpl = idlUtils.implForWrapper(elementWrapper);
      return getOriginalNwsapi(nodeImpl).match(selector, elementWrapper);
    } catch (err) {
      return false;
    }
  },
  closest(selector, elementWrapper) {
    try {
      lazyLoadHelpers();
      let current = idlUtils.implForWrapper(elementWrapper);
      while (current) {
        if (current.nodeType === 1) { // ELEMENT_NODE
          if (mockNwsapi.match(selector, idlUtils.wrapperForImpl(current))) {
            return idlUtils.wrapperForImpl(current);
          }
        }
        current = domSymbolTree.parent(current);
      }
      return null;
    } catch (e) {
      // Fallback
    }
    try {
      const nodeImpl = idlUtils.implForWrapper(elementWrapper);
      return getOriginalNwsapi(nodeImpl).closest(selector, elementWrapper);
    } catch (err) {
      return null;
    }
  }
};

// CSS Specificity Calculator for computed style matching
function getSpecificity(selector) {
  if (!selector) return 0;
  let ids = (selector.match(/#[a-zA-Z0-9_-]+/g) || []).length;
  let classes = (selector.match(/\.[a-zA-Z0-9_-]+/g) || []).length;
  let attrs = (selector.match(/\[[^\]]+\]/g) || []).length;
  let pseudos = (selector.match(/:[a-zA-Z0-9_-]+/g) || []).filter(p => !p.startsWith('::')).length;
  
  let cleanSelector = selector.replace(/\[[^\]]+\]/g, '').replace(/::?[a-zA-Z0-9_-]+/g, '');
  let tags = (cleanSelector.match(/[a-zA-Z0-9_-]+/g) || []).filter(t => !/^[0-9]+$/.test(t)).length;
  
  return ids * 100 + (classes + attrs + pseudos) * 10 + tags;
}

// Monkeypatched getDeclarationForElement
let parsedDefaultStyleSheet;
function getDeclarationForElementPatched(elementImpl) {
  lazyLoadHelpers();
  const { CSSStyleDeclaration } = require("cssstyle");
  const cssom = require("rrweb-cssom");
  const defaultStyleSheet = require("jsdom/lib/jsdom/browser/default-stylesheet");
  
  let styleCache = elementImpl._ownerDocument._styleCache;
  if (!styleCache) {
    styleCache = elementImpl._ownerDocument._styleCache = new WeakMap();
  }
  const cachedDeclaration = styleCache.get(elementImpl);
  if (cachedDeclaration) {
    return cachedDeclaration;
  }

  const declaration = new CSSStyleDeclaration();

  function handleProperty(style, property) {
    const value = style.getPropertyValue(property);
    if (value === "unset") {
      declaration.removeProperty(property);
    } else {
      declaration.setProperty(property, value, style.getPropertyPriority(property));
    }
  }

  const matchingRules = [];

  function handleSheet(sheet) {
    if (!sheet || !sheet.cssRules) return;
    for (let i = 0; i < sheet.cssRules.length; i++) {
      const rule = sheet.cssRules[i];
      if (rule.media) {
        if (Array.prototype.indexOf.call(rule.media, "screen") !== -1) {
          for (let j = 0; j < rule.cssRules.length; j++) {
            const innerRule = rule.cssRules[j];
            if (selectorsModule.matchesDontThrow(elementImpl, innerRule.selectorText)) {
              matchingRules.push(innerRule);
            }
          }
        }
      } else if (selectorsModule.matchesDontThrow(elementImpl, rule.selectorText)) {
        matchingRules.push(rule);
      }
    }
  }

  if (!parsedDefaultStyleSheet) {
    parsedDefaultStyleSheet = cssom.parse(defaultStyleSheet);
  }

  handleSheet(parsedDefaultStyleSheet);
  
  // Standard stylesheets
  const sheets = elementImpl._ownerDocument.styleSheets._list;
  for (let i = 0; i < sheets.length; i++) {
    handleSheet(sheets[i]);
  }

  // ShadowRoot adopted style sheets
  let current = elementImpl;
  let shadowRoot = null;
  while (current) {
    if (current._host) {
      shadowRoot = current;
      break;
    }
    current = domSymbolTree.parent(current);
  }
  if (shadowRoot && shadowRoot._adoptedStyleSheets) {
    for (let i = 0; i < shadowRoot._adoptedStyleSheets.length; i++) {
      handleSheet(shadowRoot._adoptedStyleSheets[i]);
    }
  }

  // Document adopted style sheets
  if (elementImpl._ownerDocument && elementImpl._ownerDocument._adoptedStyleSheets) {
    const docAdopted = elementImpl._ownerDocument._adoptedStyleSheets;
    for (let i = 0; i < docAdopted.length; i++) {
      handleSheet(docAdopted[i]);
    }
  }

  // stable sort by CSS specificity
  matchingRules.forEach((rule, idx) => {
    rule._index = idx;
    rule._specificity = getSpecificity(rule.selectorText);
  });
  
  matchingRules.sort((a, b) => {
    if (a._specificity !== b._specificity) {
      return a._specificity - b._specificity;
    }
    return a._index - b._index;
  });

  matchingRules.forEach(rule => {
    for (let i = 0; i < rule.style.length; i++) {
      const prop = rule.style[i];
      handleProperty(rule.style, prop);
    }
  });

  for (let i = 0; i < elementImpl.style.length; i++) {
    const prop = elementImpl.style[i];
    handleProperty(elementImpl.style, prop);
  }

  styleCache.set(elementImpl, declaration);
  return declaration;
}

// Proxy-based Canvas 2D mock context creator
function createMockCanvasContext2D(canvasWrapper) {
  const ctx = {
    canvas: canvasWrapper,
    measureText: (text) => ({ width: (text || "").length * 6, height: 10 }),
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h
    })
  };
  return new Proxy(ctx, {
    get(target, prop) {
      if (typeof prop === "symbol") {
        return target[prop];
      }
      if (prop in target) {
        return target[prop];
      }
      return () => {};
    }
  });
}

// Constructable CSSStyleSheet shim class
class ConstructableCSSStyleSheet {
  constructor() {
    this.cssRules = [];
  }

  replace(text) {
    return Promise.resolve().then(() => {
      this.replaceSync(text);
      return this;
    });
  }

  replaceSync(text) {
    const cssom = require("rrweb-cssom");
    try {
      const parsed = cssom.parse(text);
      this.cssRules = parsed.cssRules || [];
    } catch (e) {
      this.cssRules = [];
    }
  }
}

// Recursive HTML Serialization helper for Element.prototype.getHTML
function serializeNode(node, options = {}) {
  const nodeType = node.nodeType;
  if (nodeType === 3) { // TEXT_NODE
    return node.data || "";
  }
  if (nodeType === 8) { // COMMENT_NODE
    return `<!--${node.data}-->`;
  }
  if (nodeType === 9) { // DOCUMENT_NODE
    let html = "";
    for (const child of domSymbolTree.childrenIterator(node)) {
      html += serializeNode(child, options);
    }
    return html;
  }
  if (nodeType === 1 || nodeType === 11) { // ELEMENT_NODE or DOCUMENT_FRAGMENT
    let html = "";
    if (nodeType === 1) {
      html += `<${node.localName}`;
      const attrs = node._attributeList;
      if (attrs) {
        for (let i = 0; i < attrs.length; i++) {
          html += ` ${attrs[i]._localName}="${attrs[i]._value}"`;
        }
      }
      html += ">";
    }
    
    if (nodeType === 1 && node._shadowRoot && options.serializableShadowRoots) {
      const mode = node._shadowRoot._mode || "open";
      html += `<template shadowrootmode="${mode}">`;
      const srImpl = node._shadowRoot;
      for (const child of domSymbolTree.childrenIterator(srImpl)) {
        html += serializeNode(child, options);
      }
      html += `</template>`;
    }
    
    for (const child of domSymbolTree.childrenIterator(node)) {
      html += serializeNode(child, options);
    }
    
    if (nodeType === 1) {
      const voidElements = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];
      if (!voidElements.includes(node.localName)) {
        html += `</${node.localName}>`;
      }
    }
    return html;
  }
  return "";
}

function getHTMLPatched(options = {}) {
  lazyLoadHelpers();
  const impl = idlUtils.implForWrapper(this);
  if (!impl) return "";
  let html = "";
  if (impl._shadowRoot && options.serializableShadowRoots) {
    const mode = impl._shadowRoot._mode || "open";
    html += `<template shadowrootmode="${mode}">`;
    const srImpl = impl._shadowRoot;
    for (const child of domSymbolTree.childrenIterator(srImpl)) {
      html += serializeNode(child, options);
    }
    html += `</template>`;
  }
  for (const child of domSymbolTree.childrenIterator(impl)) {
    html += serializeNode(child, options);
  }
  return html;
}

// Monkeypatch require cache dynamically as modules are loaded
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  const exports = originalRequire.apply(this, arguments);
  
  if (id.includes("selectors")) {
    if (exports && !exports._selectorsPatched) {
      exports._selectorsPatched = true;
      exports.addNwsapi = function(parentNode) {
        return mockNwsapi;
      };
      exports.matchesDontThrow = function(elImpl, selector) {
        return mockNwsapi.match(selector, idlUtils.wrapperForImpl(elImpl));
      };
    }
  }
  
  if (id.includes("style-rules")) {
    if (exports && !exports._styleRulesPatched) {
      exports._styleRulesPatched = true;
      exports.getDeclarationForElement = getDeclarationForElementPatched;
    }
  }
  
  if (id.includes("parser/html")) {
    if (exports && !exports._htmlParserPatched) {
      exports._htmlParserPatched = true;
      const originalParseIntoDocument = exports.parseIntoDocument;
      exports.parseIntoDocument = function(markup, ownerDocument) {
        const result = originalParseIntoDocument(markup, ownerDocument);
        ownerDocument._rustSynced = false;
        return result;
      };
      const originalParseFragment = exports.parseFragment;
      exports.parseFragment = function(markup, contextElement) {
        const result = originalParseFragment(markup, contextElement);
        if (contextElement && contextElement._ownerDocument) {
          contextElement._ownerDocument._rustSynced = false;
        }
        return result;
      };
    }
  }
  
  if (id.includes("Node-impl")) {
    const NodeImpl = exports.implementation;
    if (NodeImpl && !NodeImpl._nodePatched) {
      NodeImpl._nodePatched = true;
      const originalInsert = NodeImpl.prototype._insert;
      NodeImpl.prototype._insert = function(node, ref, suppress) {
        markDirty(this);
        return originalInsert.call(this, node, ref, suppress);
      };
      const originalAppend = NodeImpl.prototype._append;
      NodeImpl.prototype._append = function(node) {
        markDirty(this);
        return originalAppend.call(this, node);
      };
      const originalRemove = NodeImpl.prototype._remove;
      NodeImpl.prototype._remove = function(suppress) {
        markDirty(this);
        return originalRemove.call(this, suppress);
      };
      const originalReplace = NodeImpl.prototype._replace;
      NodeImpl.prototype._replace = function(node, child) {
        markDirty(this);
        return originalReplace.call(this, node, child);
      };
    }
  }
  
  if (id.includes("attributes")) {
    if (exports && !exports._attributesPatched) {
      exports._attributesPatched = true;
      const originalChangeAttribute = exports.changeAttribute;
      exports.changeAttribute = function(element, attribute, value) {
        markDirty(element);
        return originalChangeAttribute(element, attribute, value);
      };
      const originalAppendAttribute = exports.appendAttribute;
      exports.appendAttribute = function(element, attribute) {
        markDirty(element);
        return originalAppendAttribute(element, attribute);
      };
      const originalRemoveAttribute = exports.removeAttribute;
      exports.removeAttribute = function(element, attribute) {
        markDirty(element);
        return originalRemoveAttribute(element, attribute);
      };
    }
  }
  
  if (id.includes("CharacterData-impl")) {
    const CharacterDataImpl = exports.implementation;
    if (CharacterDataImpl && !CharacterDataImpl._characterDataPatched) {
      CharacterDataImpl._characterDataPatched = true;
      const originalReplaceData = CharacterDataImpl.prototype.replaceData;
      CharacterDataImpl.prototype.replaceData = function(offset, count, data) {
        markDirty(this);
        return originalReplaceData.call(this, offset, count, data);
      };
    }
  }

  if (id.includes("HTMLCanvasElement-impl")) {
    const HTMLCanvasElementImpl = exports.implementation;
    if (HTMLCanvasElementImpl && !HTMLCanvasElementImpl._canvasPatched) {
      HTMLCanvasElementImpl._canvasPatched = true;
      HTMLCanvasElementImpl.prototype.getContext = function(type) {
        lazyLoadHelpers();
        if (type === "2d") {
          const w = this.width || 300;
          const h = this.height || 150;
          const wrapper = idlUtils ? idlUtils.wrapperForImpl(this) : null;
          try {
            const { createCanvas } = require("@napi-rs/canvas");
            const canvas = createCanvas(w, h);
            const ctx = canvas.getContext("2d");
            ctx.canvas = wrapper;
            return ctx;
          } catch (e) {
            try {
              const canvasPkg = require("canvas");
              const canvas = canvasPkg.createCanvas(w, h);
              const ctx = canvas.getContext("2d");
              ctx.canvas = wrapper;
              return ctx;
            } catch (err) {}
          }
          return createMockCanvasContext2D(wrapper);
        }
        return null;
      };
      HTMLCanvasElementImpl.prototype.toDataURL = function() {
        try {
          const { createCanvas } = require("@napi-rs/canvas");
          const canvas = createCanvas(this.width || 300, this.height || 150);
          return canvas.toDataURL();
        } catch (e) {
          try {
            const canvasPkg = require("canvas");
            const canvas = canvasPkg.createCanvas(this.width || 300, this.height || 150);
            return canvas.toDataURL();
          } catch (err) {}
        }
        // transparent 1x1 pixel png fallback data URL
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      };
    }
  }

  if (id.includes("HTMLDetailsElement-impl")) {
    const HTMLDetailsElementImpl = exports.implementation;
    if (HTMLDetailsElementImpl && !HTMLDetailsElementImpl._detailsPatched) {
      HTMLDetailsElementImpl._detailsPatched = true;
      HTMLDetailsElementImpl.prototype._dispatchToggleEvent = function() {
        lazyLoadHelpers();
        this._taskQueue = null;
        const isOpen = this.hasAttributeNS(null, "open");
        const oldState = isOpen ? "closed" : "open";
        const newState = isOpen ? "open" : "closed";
        const ToggleEvent = this._globalObject.ToggleEvent || this._globalObject.window.ToggleEvent;
        const event = new ToggleEvent("toggle", {
          oldState,
          newState
        });
        this.dispatchEvent(idlUtils.implForWrapper(event));
      };
    }
  }

  return exports;
};

// Now import the main JSDOM package
const jsdom = require("jsdom");
const OriginalJSDOM = jsdom.JSDOM;

// Shims for browser features
const dummyDom = new OriginalJSDOM("<!DOCTYPE html>");
const dummyWindow = dummyDom.window;

const Window = dummyWindow.Window;
const Document = dummyWindow.Document;
const Element = dummyWindow.Element;
const HTMLElement = dummyWindow.HTMLElement;
const HTMLCanvasElement = dummyWindow.HTMLCanvasElement || class HTMLCanvasElement extends HTMLElement {};
const Node = dummyWindow.Node;
const Event = dummyWindow.Event;
const CustomEvent = dummyWindow.CustomEvent;
const EventTarget = dummyWindow.EventTarget;
const DocumentFragment = dummyWindow.DocumentFragment;
const ShadowRoot = dummyWindow.ShadowRoot;
const MutationObserver = dummyWindow.MutationObserver;
const MutationRecord = dummyWindow.MutationRecord;

// Extend prototypes of NodeList and HTMLCollection with Array helpers for compatibility
for (const cls of [dummyWindow.NodeList, dummyWindow.HTMLCollection]) {
  if (cls && cls.prototype) {
    for (const name of ["find", "filter", "map", "reduce", "some", "every", "indexOf"]) {
      if (!cls.prototype[name]) {
        cls.prototype[name] = Array.prototype[name];
      }
    }
  }
}

// WebSocket Mock/Shim
class WebSocket extends EventTarget {
  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // CONNECTING
    this.extensions = "";
    this.protocol = "";
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    
    process.nextTick(() => {
      this.readyState = 1; // OPEN
      const openEvent = new Event("open");
      if (typeof this.onopen === "function") this.onopen(openEvent);
      this.dispatchEvent(openEvent);
    });
  }

  send(data) {
    if (this.readyState !== 1) {
      throw new Error("InvalidStateError: WebSocket is not in OPEN state.");
    }
  }

  close(code, reason) {
    if (this.readyState === 2 || this.readyState === 3) return;
    this.readyState = 2; // CLOSING
    process.nextTick(() => {
      this.readyState = 3; // CLOSED
      const closeEvent = new Event("close");
      Object.assign(closeEvent, { code: code || 1000, reason: reason || "", wasClean: true });
      if (typeof this.onclose === "function") this.onclose(closeEvent);
      this.dispatchEvent(closeEvent);
    });
  }
}

// FileReader Mock/Shim
class FileReader extends EventTarget {
  constructor() {
    super();
    this.readyState = 0; // EMPTY
    this.result = null;
    this.error = null;
    this.onloadstart = null;
    this.onprogress = null;
    this.onload = null;
    this.onabort = null;
    this.onerror = null;
    this.onloadend = null;
  }

  _dispatch(type, eventProps = {}) {
    const ev = new Event(type);
    Object.assign(ev, eventProps);
    if (typeof this["on" + type] === "function") {
      this["on" + type](ev);
    }
    this.dispatchEvent(ev);
  }

  _read(blob, format) {
    if (this.readyState === 1) {
      throw new Error("InvalidStateError: FileReader is busy reading.");
    }
    this.readyState = 1; // LOADING
    this.result = null;
    this.error = null;
    this._dispatch("loadstart");
    
    process.nextTick(async () => {
      try {
        lazyLoadHelpers();
        const impl = idlUtils.implForWrapper(blob) || blob;
        let buf = impl._buffer;
        if (!buf) {
          if (blob && typeof blob.arrayBuffer === "function") {
            buf = Buffer.from(await blob.arrayBuffer());
          } else {
            throw new TypeError("Argument 1 of FileReader.readAs... is not an instance of Blob.");
          }
        }
        if (format === "dataURL") {
          this.result = `data:${blob.type || "application/octet-stream"};base64,${buf.toString("base64")}`;
        } else if (format === "text") {
          this.result = buf.toString("utf8");
        } else if (format === "arrayBuffer") {
          this.result = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        } else if (format === "binaryString") {
          this.result = buf.toString("binary");
        }
        this.readyState = 2; // DONE
        this._dispatch("load");
        this._dispatch("loadend");
      } catch (err) {
        this.readyState = 2; // DONE
        this.error = err;
        this._dispatch("error");
        this._dispatch("loadend");
      }
    });
  }

  readAsArrayBuffer(blob) {
    this._read(blob, "arrayBuffer");
  }

  readAsBinaryString(blob) {
    this._read(blob, "binaryString");
  }

  readAsDataURL(blob) {
    this._read(blob, "dataURL");
  }

  readAsText(blob, encoding = "utf-8") {
    this._read(blob, "text");
  }

  exclude(code, reason) {
    // shim
  }

  abort() {
    if (this.readyState === 1) {
      this.readyState = 2;
      this.result = null;
      this.error = new Error("AbortError");
      this._dispatch("abort");
      this._dispatch("loadend");
    }
  }
}

// Subclass standard JSDOM to inject shims into created windows
class JSDOM extends OriginalJSDOM {
  constructor(html, options) {
    super(html, options);
    
    const { window } = this;
    if (window) {
      // Modify NodeList and HTMLCollection prototypes for this window instance
      for (const name of ["NodeList", "HTMLCollection"]) {
        const cls = window[name];
        if (cls && cls.prototype) {
          for (const method of ["find", "filter", "map", "reduce", "some", "every", "indexOf"]) {
            if (!cls.prototype[method]) {
              Object.defineProperty(cls.prototype, method, {
                value: Array.prototype[method],
                writable: true,
                configurable: true
              });
            }
          }
        }
      }
      
      // Inject WebSockets and FileReader unconditionally
      window.WebSocket = WebSocket;
      window.FileReader = FileReader;
      
      // Shim adoptedStyleSheets on this window's Document and ShadowRoot prototypes
      if (window.Document && window.Document.prototype) {
        Object.defineProperty(window.Document.prototype, "adoptedStyleSheets", {
          get() {
            lazyLoadHelpers();
            const impl = idlUtils.implForWrapper(this);
            return impl ? (impl._adoptedStyleSheets || []) : [];
          },
          set(val) {
            if (!Array.isArray(val)) {
              throw new TypeError("adoptedStyleSheets must be an Array");
            }
            lazyLoadHelpers();
            const impl = idlUtils.implForWrapper(this);
            if (impl) {
              impl._adoptedStyleSheets = val;
              if (impl._styleCache) {
                impl._styleCache = null;
              }
            }
          },
          configurable: true
        });
      }
      
      if (window.ShadowRoot && window.ShadowRoot.prototype) {
        Object.defineProperty(window.ShadowRoot.prototype, "adoptedStyleSheets", {
          get() {
            lazyLoadHelpers();
            const impl = idlUtils.implForWrapper(this);
            return impl ? (impl._adoptedStyleSheets || []) : [];
          },
          set(val) {
            if (!Array.isArray(val)) {
              throw new TypeError("adoptedStyleSheets must be an Array");
            }
            lazyLoadHelpers();
            const impl = idlUtils.implForWrapper(this);
            if (impl) {
              impl._adoptedStyleSheets = val;
              if (impl._ownerDocument && impl._ownerDocument._styleCache) {
                impl._ownerDocument._styleCache = null;
              }
            }
          },
          configurable: true
        });
      }

      // Shim performance.getEntries
      if (window.performance && !window.performance.getEntries) {
        window.performance.getEntries = () => [];
      }

      // Shim screen dimensions
      if (window.screen) {
        Object.defineProperties(window.screen, {
          width: { value: 1920, configurable: true, writable: true },
          height: { value: 1080, configurable: true, writable: true }
        });
      }

      // Shim navigator info
      if (window.navigator) {
        Object.defineProperties(window.navigator, {
          language: { value: "en-US", configurable: true, writable: true },
          platform: { value: "Linux x86_64", configurable: true, writable: true },
          javaEnabled: { value: () => false, configurable: true, writable: true }
        });
      }

      // Shim matchMedia
      window.matchMedia = window.matchMedia || function(query) {
        return {
          media: query,
          matches: false,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true
        };
      };

      // Shim window scroll, confirm, prompt, idle callback via defineProperty to shadow prototype getters/setters
      Object.defineProperty(window, "scroll", { value: () => {}, configurable: true, writable: true });
      Object.defineProperty(window, "scrollTo", { value: () => {}, configurable: true, writable: true });
      
      if (window.scrollX === undefined) {
        Object.defineProperty(window, "scrollX", { value: 0, writable: true, configurable: true });
      }
      if (window.scrollY === undefined) {
        Object.defineProperty(window, "scrollY", { value: 0, writable: true, configurable: true });
      }

      Object.defineProperty(window, "confirm", { value: () => true, configurable: true, writable: true });
      Object.defineProperty(window, "prompt", { value: (msg, def) => def === undefined ? null : def, configurable: true, writable: true });

      // Shim history.length getter to offset JSDOM's initial navigation entry
      if (window.history) {
        Object.defineProperty(window.history, "length", {
          get() {
            lazyLoadHelpers();
            const impl = idlUtils.implForWrapper(this);
            const rawLength = impl ? impl.length : 1;
            return Math.max(0, rawLength - 1);
          },
          configurable: true
        });
      }

      // Shim postMessage to correctly set event source and origin
      const MessageEvent = window.MessageEvent;
      Object.defineProperty(window, "postMessage", {
        value: function(message, targetOrigin) {
          setTimeout(() => {
            const event = new MessageEvent("message", {
              data: message,
              source: window,
              origin: window.location.origin
            });
            window.dispatchEvent(event);
          }, 0);
        },
        configurable: true,
        writable: true
      });

      window.requestIdleCallback = window.requestIdleCallback || function(cb) {
        return setTimeout(() => {
          cb({
            didTimeout: false,
            timeRemaining: () => Math.max(0, 50 - (Date.now() % 50))
          });
        }, 1);
      };
      window.cancelIdleCallback = window.cancelIdleCallback || function(id) {
        clearTimeout(id);
      };

      // Override focus and blur on HTMLElement.prototype to support focusing any element
      if (window.HTMLElement && window.HTMLElement.prototype) {
        window.HTMLElement.prototype.focus = function() {
          lazyLoadHelpers();
          const impl = idlUtils.implForWrapper(this);
          if (impl && impl._ownerDocument) {
            impl._ownerDocument._lastFocusedElement = impl;
          }
        };
        window.HTMLElement.prototype.blur = function() {
          lazyLoadHelpers();
          const impl = idlUtils.implForWrapper(this);
          if (impl && impl._ownerDocument && impl._ownerDocument._lastFocusedElement === impl) {
            impl._ownerDocument._lastFocusedElement = impl._ownerDocument.body || impl._ownerDocument.documentElement;
          }
        };
      }

      // Shim OffscreenCanvas
      window.OffscreenCanvas = class OffscreenCanvas {
        constructor(width, height) {
          this.width = width;
          this.height = height;
        }
        getContext(type) {
          if (type === "2d") {
            return createMockCanvasContext2D(null);
          }
          return null;
        }
      };

      // Shim Element.prototype.getHTML
      if (window.Element && window.Element.prototype) {
        window.Element.prototype.getHTML = getHTMLPatched;
      }

      // Intercept document.createElement to handle search tags
      if (window.Document && window.Document.prototype) {
        const originalCreateElement = window.Document.prototype.createElement;
        window.Document.prototype.createElement = function(localName, options) {
          const el = originalCreateElement.call(this, localName, options);
          if (typeof localName === "string" && localName.toLowerCase() === "search") {
            Object.setPrototypeOf(el, window.HTMLElement.prototype);
          }
          return el;
        };
      }

      // Shim ToggleEvent dynamically based on Event.prototype using createEvent
      window.ToggleEvent = class ToggleEvent {
        constructor(type, eventInitDict = {}) {
          const event = window.document.createEvent("Event");
          event.initEvent(type, eventInitDict.bubbles, eventInitDict.cancelable);
          Object.defineProperty(event, "oldState", { value: eventInitDict.oldState || "", configurable: true });
          Object.defineProperty(event, "newState", { value: eventInitDict.newState || "", configurable: true });
          Object.setPrototypeOf(event, ToggleEvent.prototype);
          return event;
        }
      };
      Object.setPrototypeOf(window.ToggleEvent.prototype, window.Event.prototype);

      // Inject constructable CSSStyleSheet
      window.CSSStyleSheet = ConstructableCSSStyleSheet;
      // VM execution context retrieval target mapping
      window[Symbol.for("unproxied")] = window;
    }
  }
}

module.exports = {
  JSDOM,
  VirtualConsole: jsdom.VirtualConsole,
  CookieJar: jsdom.CookieJar,
  ResourceLoader: jsdom.ResourceLoader,
  Window,
  Document,
  Element,
  HTMLCanvasElement,
  CSSStyleDeclaration: dummyWindow.CSSStyleDeclaration,
  Node,
  Event,
  CustomEvent,
  EventTarget,
  DocumentFragment,
  toughCookie: require("tough-cookie"),
  CSSStyleSheet: dummyWindow.CSSStyleSheet,
  ShadowRoot,
  CustomElementRegistry: dummyWindow.CustomElementRegistry,
  HTMLElement,
  MutationObserver,
  MutationRecord,
  FileReader,
  WebSocket
};
