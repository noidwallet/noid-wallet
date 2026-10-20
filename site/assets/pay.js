"use strict";
(function () {
  var p = NOID.params();
  var to = (p.get("to") || "").trim().toLowerCase();
  if (!/^o1[02-9ac-hj-np-z]{20,100}$/.test(to)) {
    NOID.show("request", false);
    NOID.show("invalid", true);
    return;
  }
  var amount = NOID.amount(p.get("a"));
  var note = NOID.clean(p.get("n"), 80);
  NOID.text("amount", amount ? amount + " NOID" : "Any amount");
  NOID.text("note", note);
  NOID.show("note", !!note);
  NOID.text("to", to);
  var q = new URLSearchParams({ to: to });
  if (amount) q.set("a", amount);
  if (note) q.set("n", note);
  document.getElementById("open").setAttribute("href", NOID.appLink("pay", q.toString()));
})();
