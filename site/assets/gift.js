"use strict";
(function () {
  var p = NOID.params();
  var key = (p.get("k") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key) || /^0+$/.test(key)) {
    NOID.show("gift", false);
    NOID.show("invalid", true);
    return;
  }
  // The key is now in memory (and in the button below). Drop it from the
  // address bar so it doesn't linger in browser history or synced tabs.
  try {
    history.replaceState(null, "", location.pathname);
  } catch (e) {}
  var themes = ["vault", "celebrate", "thanks", "birthday"];
  var theme = themes.indexOf(p.get("t")) >= 0 ? p.get("t") : "vault";
  var amount = NOID.amount(p.get("a"));
  var message = NOID.clean(p.get("m"), 120);
  var from = NOID.clean(p.get("f"), 30);
  document.getElementById("card").className = "card t-" + theme;
  NOID.text("amount", amount || "NOID");
  NOID.show("unit", !!amount);
  NOID.text("from", from ? "from " + from : "");
  NOID.text("message", message ? "“" + message + "”" : "");
  NOID.show("message", !!message);
  NOID.text("title", from ? from + " sent you NOID" : "You received a NOID gift card");
  // Pass the gift on to the app exactly as received (only the fields it reads).
  var q = new URLSearchParams({ v: "1", k: key, t: theme });
  if (amount) q.set("a", amount);
  if (message) q.set("m", message);
  if (from) q.set("f", from);
  document.getElementById("open").setAttribute("href", NOID.appLink("g", q.toString()));
})();
