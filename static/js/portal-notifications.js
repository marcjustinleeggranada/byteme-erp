(function () {
  "use strict";

  var pollTimer = null;
  var lastUnread = 0;
  var lastMaxId = 0;
  var audioCtx = null;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function playNotificationSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.04;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.18);
    } catch (e) { /* ignore audio errors */ }
  }

  function apiFetch(url, options) {
    if (window.PortalApi && window.PortalApi.fetch) {
      return window.PortalApi.fetch(url, options);
    }
    options = options || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    return fetch(url, Object.assign({}, options, { headers: headers, credentials: "same-origin" }))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Request failed");
          return data;
        });
      });
  }

  function renderNotifications(data) {
    var badge = $("portal-notification-count");
    var list = $("portal-notification-list");
    if (badge) {
      badge.textContent = String(data.unreadCount || 0);
      badge.hidden = !(data.unreadCount > 0);
    }
    if (!list) return;
    var items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      list.innerHTML = '<div class="notification-empty">No notifications yet.</div>';
      return;
    }
    list.innerHTML = items.map(function (note) {
      return (
        '<button type="button" class="notification-item' + (note.isRead ? "" : " unread") + '"' +
        ' data-notification-id="' + note.id + '"' +
        ' data-event-type="' + escapeHtml(note.eventType || "") + '"' +
        ' data-reference="' + escapeHtml(note.reference || "") + '">' +
        '<strong>' + escapeHtml(note.title) + "</strong>" +
        "<span>" + escapeHtml(note.message) + "</span>" +
        '<small>' + escapeHtml(note.date || "") + " · " + escapeHtml(note.time || "") + "</small>" +
        "</button>"
      );
    }).join("");
  }

  function markRead(id) {
    return apiFetch("/api/notifications/mark-read", {
      method: "POST",
      body: JSON.stringify({ id: id }),
    }).then(loadNotifications);
  }

  function markAllRead() {
    return apiFetch("/api/notifications/mark-all-read", { method: "POST", body: "{}" })
      .then(loadNotifications);
  }

  function ensurePanelInBody() {
    var panel = $("portal-notification-panel");
    if (panel && panel.parentElement !== document.body) {
      document.body.appendChild(panel);
    }
  }

  function positionPanel() {
    var button = $("portal-notification-button");
    var panel = $("portal-notification-panel");
    if (!button || !panel || panel.hidden) return;

    ensurePanelInBody();

    panel.style.visibility = "hidden";
    panel.style.display = "flex";
    panel.style.position = "fixed";
    panel.style.right = "auto";

    var rect = button.getBoundingClientRect();
    var panelWidth = Math.min(340, window.innerWidth - 32);
    var maxPanelHeight = Math.min(480, window.innerHeight - 32);
    panel.style.width = panelWidth + "px";
    panel.style.maxHeight = maxPanelHeight + "px";

    var panelHeight = panel.offsetHeight || maxPanelHeight;
    var gap = 8;
    var left = Math.max(16, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 16));
    var top = rect.bottom + gap;

    if (top + panelHeight > window.innerHeight - 16) {
      top = rect.top - panelHeight - gap;
    }
    if (top < 16) {
      top = 16;
    }
    if (top + panelHeight > window.innerHeight - 16) {
      panel.style.maxHeight = Math.max(180, window.innerHeight - top - 16) + "px";
    }

    panel.style.top = Math.round(top) + "px";
    panel.style.left = Math.round(left) + "px";
    panel.style.zIndex = "10050";
    panel.style.visibility = "visible";
  }

  function togglePanel(event) {
    event.stopPropagation();
    var panel = $("portal-notification-panel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) positionPanel();
  }

  function closePanel() {
    var panel = $("portal-notification-panel");
    if (panel) {
      panel.hidden = true;
      panel.style.position = "";
      panel.style.top = "";
      panel.style.left = "";
      panel.style.right = "";
      panel.style.width = "";
      panel.style.maxHeight = "";
      panel.style.visibility = "";
      panel.style.display = "";
      panel.style.zIndex = "";
    }
  }

  function loadNotifications() {
    return apiFetch("/api/notifications").then(function (data) {
      var items = Array.isArray(data.items) ? data.items : [];
      var maxId = items.length ? Math.max.apply(null, items.map(function (n) { return n.id; })) : 0;
      if (data.unreadCount > lastUnread || maxId > lastMaxId) {
        if (lastMaxId > 0 && (data.unreadCount > lastUnread || maxId > lastMaxId)) {
          playNotificationSound();
          if (window.PortalSync && typeof window.PortalSync.refresh === "function") {
            window.PortalSync.refresh();
          }
        }
      }
      lastUnread = data.unreadCount || 0;
      lastMaxId = maxId;
      renderNotifications(data);
      return data;
    }).catch(function () {
      renderNotifications({ unreadCount: 0, items: [] });
    });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(loadNotifications, 8000);
  }

  function setupNotifications() {
    closePanel();
    var button = $("portal-notification-button");
    var markAllBtn = $("portal-notification-mark-all");
    var list = $("portal-notification-list");
    if (button) button.addEventListener("click", togglePanel);
    if (markAllBtn) markAllBtn.addEventListener("click", function (e) {
      e.preventDefault();
      markAllRead();
    });
    if (list) {
      list.addEventListener("click", function (event) {
        var item = event.target.closest("[data-notification-id]");
        if (!item) return;
        var note = {
          id: Number(item.getAttribute("data-notification-id")),
          eventType: item.getAttribute("data-event-type") || "",
          reference: item.getAttribute("data-reference") || "",
          title: item.querySelector("strong") ? item.querySelector("strong").textContent : "",
          message: item.querySelector("span") ? item.querySelector("span").textContent : "",
        };
        closePanel();
        markRead(note.id).then(function () {
          document.dispatchEvent(new CustomEvent("portal-notification-action", { detail: note }));
        });
      });
    }
    document.addEventListener("click", function (event) {
      if (!event.target.closest(".portal-notifications-wrap")) closePanel();
      if (event.target.closest("[data-screen], .staff-menu-button, .staff-modal-close, .staff-link-button")) {
        closePanel();
      }
    });
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    loadNotifications();
    startPolling();
  }

  window.PortalNotifications = { setup: setupNotifications, reload: loadNotifications, close: closePanel };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupNotifications);
  } else {
    setupNotifications();
  }
})();
