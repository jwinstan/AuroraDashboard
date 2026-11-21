// Shim browser globals so we can import the module graph from Node.
globalThis.location = { protocol: "http:", hostname: "127.0.0.1" };
globalThis.document = { createElement: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null, head: { appendChild() {} } };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };

try {
  const m = await import("../web/sources_test.js");
  console.log("sources_test exports:", Object.keys(m));
  const m2 = await import("../web/test_events.js");
  console.log("test_events exports:", Object.keys(m2));
} catch (e) {
  console.error("IMPORT FAIL:", e.stack || e.message);
  process.exit(1);
}
