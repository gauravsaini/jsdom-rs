const { JSDOM } = require('jsdom');
const { JSDOM: RustJSDOM } = require('./index.js');

// 1. Generate a large mock HTML document (e.g., 5,000 list items and nested components)
console.log("Generating large mock HTML document...");
let listItems = "";
for (let i = 0; i < 5000; i++) {
  listItems += `
    <li class="item" data-index="${i}">
      <span class="name">Product ${i}</span>
      <span class="price">$${(i * 1.5).toFixed(2)}</span>
      <span class="status ${i % 2 === 0 ? 'instock' : 'out-of-stock'}">
        ${i % 2 === 0 ? 'In Stock' : 'Out of Stock'}
      </span>
      <div class="nested-details" id="detail-${i}">
        <p>Description for product ${i} with deep tags.</p>
        <a href="/products/${i}" class="link target-link-${i}">View Product</a>
      </div>
    </li>
  `;
}

const largeHtml = `
  <!DOCTYPE html>
  <html>
    <head>
      <title>Benchmark Page</title>
    </head>
    <body>
      <div class="app-container">
        <header class="header">
          <h1 id="main-title">E-commerce Product Catalog</h1>
          <p class="subtitle">Mock page with large data structure for performance comparison</p>
        </header>
        <main class="content">
          <ul class="product-list">
            ${listItems}
          </ul>
        </main>
      </div>
    </body>
  </html>
`;

console.log(`HTML size: ${(largeHtml.length / 1024 / 1024).toFixed(2)} MB`);

// Number of run iterations to average performance
const ITERATIONS = 10;

// Benchmark JSDOM
console.log("\n--- Benchmarking JSDOM ---");
const jsdomParseTimes = [];
const jsdomSingleQueryTimes = [];
const jsdomAllQueryTimes = [];

for (let j = 0; j < ITERATIONS; j++) {
  // Parse
  const t0 = globalThis.performance.now();
  const dom = new JSDOM(largeHtml);
  const t1 = globalThis.performance.now();
  jsdomParseTimes.push(t1 - t0);

  // Single Query (Deep node)
  const t2 = globalThis.performance.now();
  const title = dom.window.document.querySelector("#main-title");
  const link = dom.window.document.querySelector(".target-link-4999");
  const t3 = globalThis.performance.now();
  jsdomSingleQueryTimes.push(t3 - t2);

  // Query All (5000 nodes)
  const t4 = globalThis.performance.now();
  const items = dom.window.document.querySelectorAll(".item");
  const count = items.length;
  const t5 = globalThis.performance.now();
  jsdomAllQueryTimes.push(t5 - t4);
}

const avgJsdomParse = jsdomParseTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
const avgJsdomSingle = jsdomSingleQueryTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
const avgJsdomAll = jsdomAllQueryTimes.reduce((a, b) => a + b, 0) / ITERATIONS;

console.log(`JSDOM Avg Parse: ${avgJsdomParse.toFixed(2)} ms`);
console.log(`JSDOM Avg Single Query: ${avgJsdomSingle.toFixed(2)} ms`);
console.log(`JSDOM Avg Query All (5k nodes): ${avgJsdomAll.toFixed(2)} ms`);


// Benchmark Rust POC
console.log("\n--- Benchmarking Rust POC (scraper + napi-rs) ---");
const rustParseTimes = [];
const rustSingleQueryTimes = [];
const rustAllQueryTimes = [];

for (let j = 0; j < ITERATIONS; j++) {
  // Parse
  const t0 = globalThis.performance.now();
  const dom = new RustJSDOM(largeHtml);
  const t1 = globalThis.performance.now();
  rustParseTimes.push(t1 - t0);

  // Single Query (Deep node)
  const t2 = globalThis.performance.now();
  const doc = dom.window.document;
  const title = doc.querySelector("#main-title");
  const link = doc.querySelector(".target-link-4999");
  const t3 = globalThis.performance.now();
  rustSingleQueryTimes.push(t3 - t2);

  // Query All (5000 nodes)
  const t4 = globalThis.performance.now();
  const items = doc.querySelectorAll(".item");
  const count = items.length;
  const t5 = globalThis.performance.now();
  rustAllQueryTimes.push(t5 - t4);
}

const avgRustParse = rustParseTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
const avgRustSingle = rustSingleQueryTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
const avgRustAll = rustAllQueryTimes.reduce((a, b) => a + b, 0) / ITERATIONS;

console.log(`Rust POC Avg Parse: ${avgRustParse.toFixed(2)} ms`);
console.log(`Rust POC Avg Single Query: ${avgRustSingle.toFixed(2)} ms`);
console.log(`Rust POC Avg Query All (5k nodes): ${avgRustAll.toFixed(2)} ms`);

// Summary Table Comparison
console.log("\n=== PERFORMANCE COMPARISON (Speedup Factor) ===");
console.log(`1. HTML Parsing:
   - JSDOM:    ${avgJsdomParse.toFixed(2)} ms
   - Rust POC: ${avgRustParse.toFixed(2)} ms
   - Speedup:  **${(avgJsdomParse / avgRustParse).toFixed(1)}x faster**`);

console.log(`\n2. Single Query (querySelector):
   - JSDOM:    ${avgJsdomSingle.toFixed(2)} ms
   - Rust POC: ${avgRustSingle.toFixed(2)} ms
   - Speedup:  **${(avgJsdomSingle / avgRustSingle).toFixed(1)}x faster**`);

console.log(`\n3. Query All (querySelectorAll - 5000 matches):
   - JSDOM:    ${avgJsdomAll.toFixed(2)} ms
   - Rust POC: ${avgRustAll.toFixed(2)} ms
   - Speedup:  **${(avgJsdomAll / avgRustAll).toFixed(1)}x faster**`);
