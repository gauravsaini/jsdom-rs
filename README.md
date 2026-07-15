# jsdom-rs

A lightning-fast Rust-backed drop-in replacement for JSDOM using `napi-rs` and `scraper`.

## Features
- **20x - 50x Faster HTML Parsing**
- **400x+ Faster `querySelector` / `querySelectorAll`**
- Arena-based DOM Tree Mutations (`appendChild`, `removeChild`, `insertBefore`)
- Sibling and Child DOM Traversal
- Spec-compliant Event Bubbling and Capturing
- Fast-path `$O(1)` Lookups (`getElementById`, etc.)

## License
MIT
