const { JSDOM, Event, CustomEvent } = require('./index.js');
const assert = require('assert');

console.log("=== RUNNING JSDOM RUST FULL DROPIN SPECIFICATION SUITE ===");

function test(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

const dom = new JSDOM(`
  <!DOCTYPE html>
  <html>
    <head>
      <title>Full Spec Test</title>
    </head>
    <body>
      <div id="container" class="wrapper main">
        <h1 class="title">My Title</h1>
        <p class="desc" data-role="intro">Intro text</p>
        <ul id="list">
          <li class="item" id="item-1">First Item</li>
          <!-- middle comment -->
          <li class="item" id="item-2">Second Item</li>
          <li class="item" id="item-3">Third Item</li>
        </ul>
        <div class="empty-div"></div>
        <span class="suffix-text">End span</span>
      </div>
    </body>
  </html>
`);

const { window } = dom;
const { document } = window;

// 1. Sibling and Traversal APIs
test("Sibling & Traversal Navigation", () => {
  const container = document.getElementById("container");
  
  assert.strictEqual(container.children.length, 5);
  assert.strictEqual(container.children[0].tagName, "H1");
  assert.strictEqual(container.children[4].tagName, "SPAN");
  
  assert.strictEqual(container.firstElementChild.tagName, "H1");
  assert.strictEqual(container.lastElementChild.tagName, "SPAN");
  
  const h1 = container.firstElementChild;
  const p = h1.nextElementSibling;
  assert.strictEqual(p.tagName, "P");
  assert.strictEqual(p.previousElementSibling, h1);
  
  assert.strictEqual(container.children.item(1).tagName, "P");
  
  const list = document.getElementById("list");
  const firstLi = list.children[0];
  
  const sib = firstLi.nextSibling;
  assert.ok(sib);
  assert.strictEqual(sib.parentNode, list);
});

// 2. Node Info & Values
test("Node Types and Values", () => {
  const list = document.getElementById("list");
  
  const commentNode = list.childNodes.find(n => n.nodeType === 8);
  assert.ok(commentNode, "Should find a comment node");
  assert.strictEqual(commentNode.nodeName, "#comment");
  assert.strictEqual(commentNode.nodeValue.trim(), "middle comment");
  
  commentNode.nodeValue = " updated comment ";
  assert.strictEqual(commentNode.nodeValue, " updated comment ");
  
  const h1 = document.querySelector("h1");
  const textNode = h1.firstChild;
  assert.strictEqual(textNode.nodeType, 3);
  assert.strictEqual(textNode.nodeName, "#text");
  assert.strictEqual(textNode.nodeValue, "My Title");
  
  textNode.nodeValue = "New Title Value";
  assert.strictEqual(h1.textContent, "New Title Value");
});

// 3. Sibling Mutations
test("Sibling Mutations (insertBefore, replaceChild)", () => {
  const list = document.getElementById("list");
  const refLi = document.getElementById("item-2");
  
  const insertedLi = document.createElement("li");
  insertedLi.className = "item";
  insertedLi.id = "item-inserted";
  insertedLi.textContent = "Inserted Item";
  
  list.insertBefore(insertedLi, refLi);
  
  const items = list.getElementsByClassName("item");
  assert.strictEqual(items.length, 4);
  assert.strictEqual(items[1].id, "item-inserted");
  assert.strictEqual(items[2].id, "item-2");
  
  const replacementLi = document.createElement("li");
  replacementLi.className = "item";
  replacementLi.id = "item-replaced";
  replacementLi.textContent = "Replaced Item";
  
  list.replaceChild(replacementLi, insertedLi);
  assert.strictEqual(list.getElementsByClassName("item")[1].id, "item-replaced");
});

// 4. Node Cloning
test("Node Cloning (cloneNode deep vs shallow)", () => {
  const container = document.getElementById("container");
  
  const shallow = container.cloneNode(false);
  assert.strictEqual(shallow.tagName, "DIV");
  assert.strictEqual(shallow.className, "wrapper main");
  assert.strictEqual(shallow.children.length, 0, "Shallow clone should have no children");
  
  const deep = container.cloneNode(true);
  assert.strictEqual(deep.tagName, "DIV");
  assert.strictEqual(deep.children.length, 5, "Deep clone should copy children");
  assert.strictEqual(deep.firstElementChild.textContent, "New Title Value");
});

// 5. Fast Path Lookups
test("Fast Path API Lookups", () => {
  const container = document.getElementById("container");
  assert.ok(container);
  assert.strictEqual(container.tagName, "DIV");
  
  const wrapperItems = document.getElementsByClassName("wrapper");
  assert.strictEqual(wrapperItems.length, 1);
  assert.strictEqual(wrapperItems[0].id, "container");
  
  const lis = document.getElementsByTagName("li");
  assert.strictEqual(lis.length, 4);
});

// 6. Events Bubbling and Capturing
test("Event Bubbling & Capturing", () => {
  const container = document.getElementById("container");
  const list = document.getElementById("list");
  const item1 = document.getElementById("item-1");
  
  const eventLog = [];
  
  container.addEventListener("click", (e) => {
    eventLog.push(`container-capture`);
  }, { capture: true });
  
  container.addEventListener("click", (e) => {
    eventLog.push(`container-bubble`);
  });
  
  list.addEventListener("click", (e) => {
    eventLog.push(`list-bubble`);
  });
  
  item1.addEventListener("click", (e) => {
    eventLog.push(`item1-target`);
  });
  
  const clickEvent = new Event("click", { bubbles: true });
  item1.dispatchEvent(clickEvent);
  
  assert.deepStrictEqual(eventLog, [
    "container-capture",
    "item1-target",
    "list-bubble",
    "container-bubble"
  ]);
  
  const eventLog2 = [];
  const clickEvent2 = new Event("click", { bubbles: true });
  
  const stopper = (e) => {
    eventLog2.push("list-stopper");
    e.stopPropagation();
  };
  list.addEventListener("click", stopper);
  
  item1.dispatchEvent(clickEvent2);
  assert.deepStrictEqual(eventLog2, [
    "list-stopper"
  ]);
  
  const cleanLog = [];
  const target = document.createElement("button");
  const parent = document.createElement("div");
  parent.appendChild(target);
  
  parent.addEventListener("custom", () => cleanLog.push("parent-bubble"));
  target.addEventListener("custom", (e) => {
    cleanLog.push("target");
    e.stopPropagation();
  });
  parent.addEventListener("custom", () => cleanLog.push("parent-capture"), { capture: true });
  
  target.dispatchEvent(new Event("custom", { bubbles: true }));
  assert.deepStrictEqual(cleanLog, ["parent-capture", "target"]);
});

// 7. Advanced CSS Selectors
test("Advanced CSS Selectors", () => {
  const pDirect = document.querySelector("#container > p");
  assert.ok(pDirect);
  assert.strictEqual(pDirect.textContent, "Intro text");
  
  const liAdjacent = document.querySelector("#item-1 + li");
  assert.ok(liAdjacent);
  assert.strictEqual(liAdjacent.id, "item-replaced");
  
  const liGeneral = document.querySelectorAll("#item-1 ~ li");
  assert.strictEqual(liGeneral.length, 3);
  
  const firstLi = document.querySelector("#list > li:first-child");
  assert.ok(firstLi);
  assert.strictEqual(firstLi.id, "item-1");
  
  const lastLi = document.querySelector("#list > li:last-child");
  assert.ok(lastLi);
  assert.strictEqual(lastLi.id, "item-3");
  
  const emptyDiv = document.querySelector(".empty-div:empty");
  assert.ok(emptyDiv);
  
  const secondLi = document.querySelector("#list > li:nth-child(2)");
  assert.ok(secondLi);
  assert.strictEqual(secondLi.id, "item-replaced");
  
  const startsWithAttr = document.querySelector("[class^=wrap]");
  assert.ok(startsWithAttr);
  assert.strictEqual(startsWithAttr.id, "container");
  
  const endsWithAttr = document.querySelector("[class$=main]");
  assert.ok(endsWithAttr);
  assert.strictEqual(endsWithAttr.id, "container");
  
  const containsAttr = document.querySelector("[class*=wrap]");
  assert.ok(containsAttr);
  assert.strictEqual(containsAttr.id, "container");
});

// 8. Style and computedStyle
test("CSSOM element.style and window.getComputedStyle", () => {
  const container = document.getElementById("container");
  
  // Test element.style
  container.style.color = "red";
  container.style.backgroundColor = "blue";
  
  assert.strictEqual(container.style.color, "red");
  assert.strictEqual(container.style.backgroundColor, "blue");
  assert.strictEqual(container.getAttribute("style"), "color: red; background-color: blue");
  
  // Test computed style from stylesheet
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    .title { color: green; font-size: 20px; }
    h1 { color: purple; }
  `;
  document.head.appendChild(styleEl);
  
  const h1 = document.querySelector("h1");
  const computedH1 = window.getComputedStyle(h1);
  
  // title class has specificity 10, h1 has specificity 1, so class overrides element rule
  assert.strictEqual(computedH1.color, "green");
  assert.strictEqual(computedH1.fontSize, "20px");
  
  // Inline style overrides stylesheet rule
  h1.style.color = "orange";
  const computedH1_2 = window.getComputedStyle(h1);
  assert.strictEqual(computedH1_2.color, "orange");
});

// 9. Canvas support
test("Canvas context and fallback support", () => {
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 300;
  
  assert.strictEqual(canvas.width, 400);
  assert.strictEqual(canvas.height, 300);
  assert.strictEqual(canvas.getAttribute("width"), "400");
  assert.strictEqual(canvas.getAttribute("height"), "300");
  
  const ctx = canvas.getContext("2d");
  assert.ok(ctx);
  assert.strictEqual(ctx.canvas, canvas);
  
  // Draw call shouldn't throw even with mock fallback
  ctx.fillRect(0, 0, 100, 100);
  
  // measureText returns standard mock structure
  const metrics = ctx.measureText("hello");
  assert.ok(metrics);
  assert.strictEqual(metrics.width, 30);
  
  const data = canvas.toDataURL();
  assert.ok(data.startsWith("data:image/png;base64"));
});

// 10. Web Components (Custom Elements, Shadow DOM, adoptedStyleSheets)
test("Web Components Specs", () => {
  const container = document.getElementById("container");

  // A. Shadow DOM: attachShadow, mode, host, getRootNode
  const shadowHost = document.createElement("div");
  container.appendChild(shadowHost);
  
  const shadowRoot = shadowHost.attachShadow({ mode: "open" });
  assert.strictEqual(shadowRoot.host, shadowHost);
  assert.strictEqual(shadowRoot.mode, "open");
  assert.strictEqual(shadowHost.shadowRoot, shadowRoot);

  const innerSpan = document.createElement("span");
  shadowRoot.appendChild(innerSpan);
  assert.strictEqual(innerSpan.getRootNode(), shadowRoot);
  assert.strictEqual(innerSpan.getRootNode({ composed: true }), document);

  // B. Event composedPath across Shadow Boundaries
  let receivedComposed = false;
  let receivedComposedPath = [];
  container.addEventListener("custom-composed", (e) => {
    receivedComposed = true;
    receivedComposedPath = e.composedPath();
  });

  const customEvent = new Event("custom-composed", { bubbles: true, composed: true });
  innerSpan.dispatchEvent(customEvent);
  assert.ok(receivedComposed);
  assert.ok(receivedComposedPath.includes(innerSpan));
  assert.ok(receivedComposedPath.includes(shadowRoot));
  assert.ok(receivedComposedPath.includes(shadowHost));
  assert.ok(receivedComposedPath.includes(container));

  // C. Custom Elements Lifecycle
  let connectedCalls = 0;
  let attributeChangedCalls = [];
  class MyCustomElement extends window.HTMLElement {
    static get observedAttributes() {
      return ["data-test"];
    }
    connectedCallback() {
      connectedCalls++;
    }
    attributeChangedCallback(name, oldVal, newVal) {
      attributeChangedCalls.push({ name, oldVal, newVal });
    }
  }

  window.customElements.define("my-custom-element", MyCustomElement);
  
  const customEl = document.createElement("my-custom-element");
  assert.strictEqual(customEl.tagName, "MY-CUSTOM-ELEMENT");
  
  // Attribute callback should trigger on creation if attribute already present, or on change
  customEl.setAttribute("data-test", "val1");
  assert.strictEqual(attributeChangedCalls.length, 1);
  assert.deepStrictEqual(attributeChangedCalls[0], { name: "data-test", oldVal: null, newVal: "val1" });

  // Connected callback should trigger when appended
  container.appendChild(customEl);
  assert.strictEqual(connectedCalls, 1);

  // D. adoptedStyleSheets
  const sheet = new window.CSSStyleSheet();
  sheet.replaceSync(".custom-style { color: teal; }");
  
  shadowRoot.adoptedStyleSheets = [sheet];
  
  const customSpan = document.createElement("span");
  customSpan.className = "custom-style";
  shadowRoot.appendChild(customSpan);
  
  const computedCustomSpan = window.getComputedStyle(customSpan);
  assert.strictEqual(computedCustomSpan.color, "teal");
});

console.log("\n✨ ALL SPECIFICATION SUITE TESTS PASSED SUCCESSFULLY! ✨");

