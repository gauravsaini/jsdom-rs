const assert = require("node:assert");
const { JSDOM } = require("./index.js");

async function runTests() {
  console.log("=== RUNNING BROWSER APIS TEST SUITE ===");

  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="container"><span id="txt">hello</span></div></body></html>`, { url: "http://localhost/" });
  const { window } = dom;
  const { document } = window;

  // 1. Performance API
  assert.ok(typeof window.performance.now() === "number");
  assert.ok(window.performance.timeOrigin > 0);
  assert.deepStrictEqual(window.performance.getEntries(), []);

  // 2. Screen API
  assert.strictEqual(window.screen.width, 1920);
  assert.strictEqual(window.screen.height, 1080);

  // 3. Navigator API
  assert.strictEqual(window.navigator.language, "en-US");
  assert.strictEqual(window.navigator.platform, "Linux x86_64");
  assert.ok(window.navigator.userAgent.includes("Mozilla"));
  assert.strictEqual(typeof window.navigator.javaEnabled, "function");
  assert.strictEqual(window.navigator.javaEnabled(), false);

  // 4. matchMedia API
  const mq = window.matchMedia("(max-width: 600px)");
  assert.strictEqual(mq.media, "(max-width: 600px)");
  assert.strictEqual(mq.matches, false);

  // 5. Scroll & Window Stubs
  window.scroll(10, 20);
  window.scrollTo(100, 200);
  assert.strictEqual(window.scrollX, 0);
  assert.strictEqual(window.scrollY, 0);
  assert.strictEqual(window.confirm("hello"), true);
  assert.strictEqual(window.prompt("hello", "default"), "default");

  // 6. ActiveElement & focus/blur
  const container = document.getElementById("container");
  const txt = document.getElementById("txt");
  
  assert.strictEqual(document.activeElement, document.body);
  txt.focus();
  assert.strictEqual(document.activeElement, txt);
  txt.blur();
  assert.strictEqual(document.activeElement, document.body);

  // 7. FileReader API
  const NativeBlob = window.Blob;
  const blob = new NativeBlob(["hello world"], { type: "text/plain" });
  const reader = new window.FileReader();
  
  const fileReadPromise = new Promise((resolve, reject) => {
    reader.onload = () => {
      try {
        assert.strictEqual(reader.result, "hello world");
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  await fileReadPromise;

  // 8. WebSocket API
  const ws = new window.WebSocket("ws://localhost:8080");
  assert.strictEqual(ws.readyState, 0); // CONNECTING
  
  const wsPromise = new Promise((resolve) => {
    ws.onopen = () => {
      assert.strictEqual(ws.readyState, 1); // OPEN
      ws.close(1000, "done");
    };
    ws.onclose = (event) => {
      assert.strictEqual(ws.readyState, 3); // CLOSED
      assert.strictEqual(event.code, 1000);
      assert.strictEqual(event.reason, "done");
      resolve();
    };
  });
  await wsPromise;

  // 9. postMessage API
  const postMsgPromise = new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      assert.strictEqual(event.data, "test message");
      assert.strictEqual(event.source, window);
      resolve();
    }, { once: true });
    window.postMessage("test message", "*");
  });
  await postMsgPromise;

  // 10. History popstate & navigation
  assert.strictEqual(window.history.length, 0);
  window.history.pushState({ val: 1 }, "title 1", "/page1");
  assert.strictEqual(window.history.length, 1);
  assert.strictEqual(window.history.state.val, 1);
  assert.strictEqual(window.location.pathname, "/page1");

  window.history.replaceState({ val: 2 }, "title 2", "/page2");
  assert.strictEqual(window.history.length, 1);
  assert.strictEqual(window.history.state.val, 2);
  assert.strictEqual(window.location.pathname, "/page2");

  // 11. MutationObserver
  const observerCallbackPromise = new Promise((resolve) => {
    const observer = new window.MutationObserver((records) => {
      assert.strictEqual(records.length, 2);
      
      // First is characterData mutation on text node
      assert.strictEqual(records[0].type, "characterData");
      assert.strictEqual(records[0].oldValue, "hello");
      
      // Second is attribute change on span
      assert.strictEqual(records[1].type, "attributes");
      assert.strictEqual(records[1].attributeName, "class");
      assert.strictEqual(records[1].oldValue, null);
      
      observer.disconnect();
      resolve();
    });
    observer.observe(txt, { subtree: true, characterData: true, attributes: true, attributeOldValue: true, characterDataOldValue: true });
    
    // Trigger mutations
    txt.firstChild.nodeValue = "hi";
    txt.setAttribute("class", "active");
  });
  await observerCallbackPromise;

  // 12. requestIdleCallback & cancelIdleCallback
  const idlePromise = new Promise((resolve) => {
    const handle = window.requestIdleCallback((deadline) => {
      assert.strictEqual(typeof deadline.timeRemaining, "function");
      assert.ok(deadline.timeRemaining() <= 50);
      assert.strictEqual(deadline.didTimeout, false);
      resolve();
    });
    assert.strictEqual(typeof handle, "object"); // setTimeout returns timer object in Node.js
  });
  await idlePromise;

  // 13. DOMException and Error.isError
  try {
    throw new window.DOMException("Testing index size err", "IndexSizeError");
  } catch (e) {
    assert.strictEqual(e.name, "IndexSizeError");
    assert.strictEqual(e.code, 1);
    assert.ok(e instanceof window.DOMException);
    assert.ok(e instanceof window.Error);
    assert.ok(e instanceof Error);
    // Node 20+ has util.types.isNativeError / Error.isError
    assert.ok(require("node:util").types.isNativeError(e) || e instanceof Error);
  }

  // 14. OffscreenCanvas
  const offscreen = new window.OffscreenCanvas(200, 300);
  assert.strictEqual(offscreen.width, 200);
  assert.strictEqual(offscreen.height, 300);
  const ctx = offscreen.getContext("2d");
  assert.ok(ctx !== null);
  assert.strictEqual(typeof ctx.fillRect, "function");

  // 15. HTMLUnknownElement & Search Tag
  const searchEl = document.createElement("search");
  assert.strictEqual(Object.prototype.toString.call(searchEl), "[object HTMLElement]");
  assert.ok(searchEl instanceof window.HTMLElement);
  assert.ok(!(searchEl instanceof window.HTMLUnknownElement));

  const unknownEl = document.createElement("customunknown");
  assert.ok(unknownEl instanceof window.HTMLUnknownElement);
  assert.strictEqual(Object.prototype.toString.call(unknownEl), "[object HTMLUnknownElement]");

  // 16. getHTML() & attachShadow
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open", serializable: true });
  shadow.innerHTML = "<p>shadow content</p>";
  
  // Default getHTML() should serialize shadow roots if option is specified
  const htmlWithShadow = host.getHTML({ serializableShadowRoots: true });
  assert.ok(htmlWithShadow.includes("shadowrootmode=\"open\""));
  assert.ok(htmlWithShadow.includes("<p>shadow content</p>"));

  // Default innerHTML should NOT serialize shadow roots
  assert.strictEqual(host.innerHTML, "");

  // 17. ToggleEvent and <details>
  const details = document.createElement("details");
  document.body.appendChild(details);
  
  const togglePromise = new Promise((resolve) => {
    details.addEventListener("toggle", (event) => {
      assert.strictEqual(event.oldState, "closed");
      assert.strictEqual(event.newState, "open");
      resolve();
    }, { once: true });
  });
  details.open = true;
  await togglePromise;

  console.log("✅ ALL BROWSER APIS TESTS PASSED!");
}

runTests().catch(err => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
