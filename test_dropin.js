const { JSDOM } = require('./index.js');

console.log("=== testing drop-in jsdom-rust-poc ===");

// 1. Instantiation
const dom = new JSDOM(`
  <!DOCTYPE html>
  <html>
    <head>
      <title>Initial Title</title>
    </head>
    <body>
      <div id="app" class="main-container">
        <h1>Welcome to Rust DOM</h1>
        <ul class="list">
          <li class="item" data-id="101">Item 1</li>
          <li class="item" data-id="102">Item 2</li>
        </ul>
      </div>
    </body>
  </html>
`);

const { window } = dom;
const { document } = window;

// 2. Querying elements & textContent
console.log("\n--- Querying Tests ---");
const h1 = document.querySelector('h1');
console.log("H1 tagName:", h1.tagName); // Should be "H1"
console.log("H1 textContent:", h1.textContent); // Should be "Welcome to Rust DOM"

const items = document.querySelectorAll('.item');
console.log("Items count:", items.length); // Should be 2
console.log("Item 1 data-id:", items.item(0).getAttribute('data-id')); // Should be "101"
console.log("Item 2 textContent:", items.item(1).textContent); // Should be "Item 2"

// 3. Document details
console.log("\n--- Document Property Tests ---");
console.log("Document Title:", document.title); // Should be "Initial Title"
document.title = "Updated Title";
console.log("Document Title after update:", document.title); // Should be "Updated Title"

// 4. Mutations (appendChild, createelement, createTextNode)
console.log("\n--- Mutation Tests (Element creation & append) ---");
const list = document.querySelector('.list');
const newItem = document.createElement('li');
newItem.setAttribute('class', 'item new-item');
newItem.setAttribute('data-id', '103');

const newText = document.createTextNode('Item 3 (Added dynamically)');
newItem.appendChild(newText);
list.appendChild(newItem);

console.log("New items count in selector query:", document.querySelectorAll('.item').length); // Should be 3 now!

// 5. innerHTML and textContent updates
console.log("\n--- Mutation Tests (innerHTML & textContent modification) ---");
const h1El = document.querySelector('h1');
h1El.textContent = "Welcome to Mutated Rust DOM";
console.log("H1 textContent after update:", h1El.textContent);

const app = document.querySelector('#app');
console.log("Original app classList contains 'main-container':", app.classList.contains('main-container')); // true
app.classList.remove('main-container');
app.classList.add('custom-container');
console.log("Updated app className:", app.className); // Should be "custom-container"

// 6. Serialization
console.log("\n--- Serialization Test ---");
const serializedHtml = dom.serialize();
console.log("Serialized HTML Output:\n", serializedHtml);

console.log("\nAll tests ran successfully!");
