const { JSDOM } = require("./index.js");

const html = `
  <!DOCTYPE html>
  <html>
    <body>
      <div id="container">
        <h1 class="title">Hello from Rust!</h1>
        <p class="desc">This is a fast DOM parser in Rust.</p>
        <span class="item" data-id="1">Item 1</span>
        <span class="item" data-id="2">Item 2</span>
      </div>
    </body>
  </html>
`;

console.time("Parse document");
const dom = new JSDOM(html);
const { document } = dom.window;
console.timeEnd("Parse document");

console.time("Query single selector");
const title = document.querySelector(".title");
console.timeEnd("Query single selector");

console.log("Title tag:", title.tagName);
console.log("Title content:", title.textContent.trim());
console.log("Title class:", title.className);

console.time("Query querySelectorAll");
const items = document.querySelectorAll("span.item");
console.timeEnd("Query querySelectorAll");

console.log("Found items count:", items.length);
items.forEach(item => {
  console.log(`- ${item.tagName}[data-id="${item.getAttribute("data-id")}"]: "${item.textContent}"`);
});
