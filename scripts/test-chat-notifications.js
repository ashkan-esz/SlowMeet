const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const addChatMessageStart = appSource.indexOf("function addChatMessage(");
const addChatMessageEnd = appSource.indexOf("\nfunction addChatSystem", addChatMessageStart);
const addChatMessageSource = appSource.slice(addChatMessageStart, addChatMessageEnd);

assert.ok(addChatMessageStart >= 0 && addChatMessageEnd > addChatMessageStart,
  "chat message handler should be present");
assert.match(addChatMessageSource, /if \(!system && chatClosed\) \{[\s\S]*?if \(!own\) \{[\s\S]*?showToast\(/,
  "only incoming chat messages should show a toast while chat is closed");
assert.match(addChatMessageSource, /const preview = body\.length > 120 \? `\$\{body\.slice\(0, 120\)\}…` : body;/,
  "long message previews should be truncated");
assert.match(addChatMessageSource, /showToast\(`\$\{author\}: \$\{preview\}`\);/,
  "the toast should show the sender followed directly by the message preview");
assert.match(addChatMessageSource, /unreadMessages \+= 1;/,
  "closed-chat messages should continue incrementing the unread count");
assert.match(appSource, /setTimeout\(\(\) => toast\.remove\(\), 4000\);/,
  "chat notification toasts should use the existing four-second dismissal");
assert.match(indexSource, /<div id="toast-region" class="toast-region" role="status" aria-live="polite" aria-atomic="true"><\/div>/,
  "the toast region should expose polite status updates to assistive technology");

console.log("Chat notification checks passed");
