// Shared by the gift and payment pages. Everything is read from the part of
// the address after "#", which the browser never sends to this server.
"use strict";
var NOID = (function () {
  var PKG = "com.dpeluola.noid";
  function params() {
    return new URLSearchParams(location.hash.replace(/^#/, ""));
  }
  function clean(s, max) {
    return (s || "").replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }
  function amount(s) {
    return /^\d{1,12}(\.\d{1,6})?$/.test(s || "") && Number(s) > 0 ? s : "";
  }
  // Always an Android intent naming the NOID package, so only the real NOID
  // app can receive the gift (a bare noid:// link could be caught by any app
  // that registers the same scheme). Falls back to the download section.
  function appLink(path, query) {
    var fallback = encodeURIComponent(location.origin + "/#get");
    return "intent://" + path + "?" + query + "#Intent;scheme=noid;package=" + PKG + ";S.browser_fallback_url=" + fallback + ";end";
  }

  function text(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  function show(id, on) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !on);
  }
  return { params: params, clean: clean, amount: amount, appLink: appLink, text: text, show: show };
})();
