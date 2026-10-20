// Shared by the gift and payment pages. Everything is read from the part of
// the address after "#", which the browser never sends to this server.
"use strict";
var NOID = (function () {
  var PKG = "com.dpeluola.noid";
  function params() {
    return new URLSearchParams(location.hash.replace(/^#/, ""));
  }
  function clean(s, max) {
    return (s || "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }
  function amount(s) {
    return /^\d{1,12}(\.\d{1,6})?$/.test(s || "") && Number(s) > 0 ? s : "";
  }
  // Android Chrome: open the app if installed, otherwise come back here.
  function appLink(path, query) {
    var isAndroid = /Android/i.test(navigator.userAgent);
    if (isAndroid) {
      var fallback = encodeURIComponent(location.origin + "/#get");
      return "intent://" + path + "?" + query + "#Intent;scheme=noid;package=" + PKG + ";S.browser_fallback_url=" + fallback + ";end";
    }
    return "noid://" + path + "?" + query;
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
