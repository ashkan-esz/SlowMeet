const assert = require("node:assert/strict");
const fs = require("node:fs");
const {read, update} = require("../web/js/login-url.js");

const connectionTypes = ["auto", "direct", "turn-tcp", "turn-tcp-rotate"];

const prefilled = read("?user=arman&connectionType=turn-tcp&room=weekly", connectionTypes);
assert.equal(prefilled.hasUser, true);
assert.equal(prefilled.user, "arman");
assert.equal(prefilled.connectionType, "turn-tcp");

const invalidConnectionType = read("?user=arman&connectionType=tcp-routing", connectionTypes);
assert.equal(invalidConnectionType.connectionType, null);

const emptyUser = read("?user=&connectionType=direct", connectionTypes);
assert.equal(emptyUser.hasUser, true);
assert.equal(emptyUser.user, "");

const updated = update("https://meet.example/join?room=weekly#login", "Arman Doe + 1", "turn-tcp");
const updatedURL = new URL(updated, "https://meet.example");
assert.equal(updatedURL.searchParams.get("user"), "Arman Doe + 1");
assert.equal(updatedURL.searchParams.get("connectionType"), "turn-tcp");
assert.equal(updatedURL.searchParams.get("room"), "weekly");
assert.equal(updatedURL.hash, "#login");

const blankUpdated = new URL(update("https://meet.example/join", "", "auto"), "https://meet.example");
assert.equal(blankUpdated.searchParams.has("user"), true);
assert.equal(blankUpdated.searchParams.get("user"), "");

const appSource = fs.readFileSync("web/js/app.js", "utf8");
const indexSource = fs.readFileSync("web/index.html", "utf8");
assert.ok(indexSource.indexOf('/js/login-url.js') < indexSource.indexOf('/js/app.js'),
  "login URL helpers must load before the app");
assert.match(appSource, /if \(loginURLPreferences\.hasUser\) nameInput\.value = loginURLPreferences\.user;/,
  "URL username must override the stored username");
assert.match(appSource, /let connectionMethod = loginURLPreferences\.connectionType \|\|/,
  "URL connection type must override the stored method");
assert.match(appSource, /nameInput\.addEventListener\("input", syncLoginURL\)/,
  "username edits must update the link");
assert.match(appSource, /history\.replaceState\(window\.history\.state, "", url\)/,
  "link updates must replace the current history entry");
assert.match(appSource, /joinConnectionMethod\?\.addEventListener\("change", \(\) => \{/,
  "connection method edits must update the link");

console.log("Login URL behavior tests passed");
