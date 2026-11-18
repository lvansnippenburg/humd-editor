// Checks for File > Open… matching (src/js/quick-open.js). Run: npm run test:quick-open
import assert from "node:assert/strict";

const { matchVaultFiles } = await import("../src/js/quick-open.js");

const files = [
  "/v/Introduction.md",
  "/v/notes/intro draft.md",
  "/v/notes/Methods.md",
  "/v/img/intro.png",
  "/v/old/Introduction.md",
];
const shown = (q) => matchVaultFiles(files, "/v/", q).map((m) => (m.folder ? `${m.folder}/` : "") + m.name);

assert.deepEqual(shown(""), [], "nothing typed: no list");
assert.deepEqual(shown("intro"), ["notes/intro draft", "img/intro.png", "Introduction", "old/Introduction"]);
assert.deepEqual(shown("INTRODUCTION"), ["Introduction", "old/Introduction"], "case-insensitive, exact name first");
assert.deepEqual(shown("duct"), ["Introduction", "old/Introduction"], "anywhere in the name");
assert.deepEqual(shown("old/intro"), ["old/Introduction"], "a / matches the path in the vault");
assert.deepEqual(shown("png"), ["img/intro.png"], "non-notes keep their extension");
assert.deepEqual(shown("notes"), [], "a folder name alone doesn't match its files");
assert.equal(matchVaultFiles(files, "/v", "intro", 2).length, 2, "limit");
console.log("all passed");
