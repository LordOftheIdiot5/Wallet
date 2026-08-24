const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

// app.js reaches for elements by id. A redesign that renames or drops one fails
// silently in most places and throws in a few, so the two files have to agree.
// This is the same class of mismatch as the ABI check: two artefacts that must
// stay in step, verified rather than assumed.
describe("Markup and script agree", function () {
  const wallet = path.join(__dirname, "..", "wallet");
  const script = fs.readFileSync(path.join(wallet, "app.js"), "utf8");
  const markup = fs.readFileSync(path.join(wallet, "index.html"), "utf8");

  function requestedIds() {
    const ids = new Set();
    // $("someId") and document.getElementById("someId")
    for (const re of [/\$\("([A-Za-z0-9_-]+)"\)/g, /getElementById\("([A-Za-z0-9_-]+)"\)/g]) {
      let m;
      while ((m = re.exec(script)) !== null) {
        ids.add(m[1]);
      }
    }
    return [...ids].sort();
  }

  function definedIds() {
    const ids = new Set();
    const re = /\bid="([A-Za-z0-9_-]+)"/g;
    let m;
    while ((m = re.exec(markup)) !== null) {
      ids.add(m[1]);
    }
    return ids;
  }

  it("defines every element the script reaches for", function () {
    const defined = definedIds();
    const missing = requestedIds().filter((id) => !defined.has(id));
    expect(missing, `app.js looks for these ids, index.html has none: ${missing.join(", ")}`)
      .to.deep.equal([]);
  });

  it("keeps the ids the script depends on most", function () {
    const defined = definedIds();
    // The load-bearing ones. If a redesign drops these the page is broken even
    // though nothing throws.
    for (const id of [
      "networkBpm", "networkState", "networkAge", "networkFeed", "networkEmpty",
      "offerPot", "offerLine", "offerDrip",
      "connectButton", "watchButton", "watchAddress", "walletSelect",
      "pulseBpm", "pulseStateLabel", "pulseBeats", "pulseNetwork", "pulseRunway",
      "balance", "sendButton", "recipient", "amount",
      "claimButton", "claimEmissionButton", "txList", "aiSuggestion",
    ]) {
      expect(defined.has(id), `missing required id: ${id}`).to.equal(true);
    }
  });
});
