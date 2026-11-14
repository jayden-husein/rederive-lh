import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFromDraft } from "../src/draft.ts";

test("an attached folder in the composer prefills the dialog", () => {
  // How the first in-app test's attached folder appeared in the sent message.
  const draft = "i built this with ai and i cant explain it `\\\\wsl.localhost\\Ubuntu\\home\\jayden\\dali-challenge\\`";
  assert.equal(sourceFromDraft(draft), "\\\\wsl.localhost\\Ubuntu\\home\\jayden\\dali-challenge\\");
});

test("quoted paths win over bare ones, and the last one wins", () => {
  assert.equal(sourceFromDraft("see C:\\old and `C:\\a` then `D:\\b`"), "D:\\b");
  assert.equal(sourceFromDraft("clone https://github.com/x/y please"), "https://github.com/x/y");
});

test("text with no path or URL gives nothing", () => {
  assert.equal(sourceFromDraft(""), null);
  assert.equal(sourceFromDraft("why is it built like this? `queue`"), null);
});
