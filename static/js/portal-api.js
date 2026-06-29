(function () {
  "use strict";

  function portalRole() {
    return document.body.getAttribute("data-portal-role") || "";
  }

  function apiFetch(url, options) {
    options = options || {};
    var headers = Object.assign(
      { "Content-Type": "application/json", "X-Portal-Role": portalRole() },
      options.headers || {}
    );
    return fetch(url, Object.assign({}, options, { headers: headers, credentials: "same-origin" }))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
          return data;
        });
      });
  }

  window.PortalApi = {
    role: portalRole,
    fetch: apiFetch,
  };
})();
