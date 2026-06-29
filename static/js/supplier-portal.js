(function () {
  "use strict";

  var QR_STORAGE_KEY = "supplier_generated_qrs";

  var SCREEN_META = {
    dashboard: { title: "Dashboard Overview", subtitle: "Purchase orders, deliveries, and company activity" },
    "po-new": { title: "New Purchase Orders", subtitle: "Orders waiting for your response" },
    "po-accepted": { title: "Accepted Orders", subtitle: "Confirmed orders ready for delivery" },
    "po-rejected": { title: "Rejected Orders", subtitle: "Orders declined by your company" },
    catalog: { title: "Ingredient Pricing", subtitle: "Update agreed prices for your supplied ingredients" },
    "generate-qr": { title: "Generate Delivery QR Code", subtitle: "Create scannable codes for accepted orders" },
    "delivery-history": { title: "Delivery History", subtitle: "Track shipments and generated QR codes" },
    support: { title: "Support Request", subtitle: "Get help from Byte Me procurement" }
  };

  var purchaseOrders = [];
  var deliveries = [];
  var activity = [];
  var profile = {};
  var dashboard = {};
  var supportTickets = [];
  var catalog = [];
  var pendingConfirm = null;
  var toastTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  /* ── Minimal QR Code encoder (byte mode, EC level M) ── */
  var QR = (function () {
    var EC_LEVEL = 1;
    var PAD0 = 236;
    var PAD1 = 17;

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);
    (function initGalois() {
      var x = 1;
      for (var i = 0; i < 255; i++) {
        EXP_TABLE[i] = x;
        LOG_TABLE[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
    })();

    function gfMul(a, b) {
      if (!a || !b) return 0;
      return EXP_TABLE[(LOG_TABLE[a] + LOG_TABLE[b]) % 255];
    }

    function rsGenPoly(n) {
      var poly = [1];
      for (var i = 0; i < n; i++) {
        var next = new Array(poly.length + 1);
        for (var j = 0; j < next.length; j++) next[j] = 0;
        for (var k = 0; k < poly.length; k++) {
          next[k] ^= poly[k];
          next[k + 1] ^= gfMul(poly[k], EXP_TABLE[i]);
        }
        poly = next;
      }
      return poly;
    }

    function rsEncode(data, ecCount) {
      var gen = rsGenPoly(ecCount);
      var msg = data.slice();
      for (var i = 0; i < ecCount; i++) msg.push(0);
      for (var j = 0; j < data.length; j++) {
        var factor = msg[j];
        if (factor) {
          for (var k = 0; k < gen.length; k++) {
            msg[j + k] ^= gfMul(gen[k], factor);
          }
        }
      }
      return msg.slice(data.length);
    }

    var CAPACITY = [
      null,
      { total: 26, data: 16, ec: 10, blocks: 1 },
      { total: 44, data: 28, ec: 16, blocks: 1 },
      { total: 70, data: 44, ec: 26, blocks: 1 },
      { total: 100, data: 64, ec: 36, blocks: 1 },
      { total: 134, data: 86, ec: 48, blocks: 1 },
      { total: 172, data: 108, ec: 64, blocks: 2 },
      { total: 196, data: 124, ec: 72, blocks: 2 }
    ];

    function pickVersion(text) {
      var len = text.length + 3;
      for (var v = 1; v < CAPACITY.length; v++) {
        if (CAPACITY[v] && len <= CAPACITY[v].data) return v;
      }
      return 7;
    }

    function encodeData(text, version) {
      var cap = CAPACITY[version];
      var bits = [];
      function push(val, count) {
        for (var i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
      }
      push(4, 4);
      push(text.length, version < 10 ? 8 : 16);
      for (var i = 0; i < text.length; i++) push(text.charCodeAt(i), 8);
      push(0, Math.min(4, cap.data * 8 - bits.length));
      while (bits.length % 8) bits.push(0);
      var bytes = [];
      for (var j = 0; j < bits.length; j += 8) {
        var b = 0;
        for (var k = 0; k < 8; k++) b = (b << 1) | bits[j + k];
        bytes.push(b);
      }
      var pad = 0;
      while (bytes.length < cap.data) bytes.push(pad++ % 2 ? PAD1 : PAD0);
      var ec = rsEncode(bytes, cap.ec);
      return bytes.concat(ec);
    }

    function createMatrix(version) {
      var size = version * 4 + 17;
      var m = [];
      for (var r = 0; r < size; r++) {
        m[r] = new Array(size);
        for (var c = 0; c < size; c++) m[r][c] = null;
      }
      return m;
    }

    function setFinder(m, row, col) {
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var rr = row + r;
          var cc = col + c;
          if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
          if ((r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
              (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
              (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            m[rr][cc] = true;
          } else if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
            m[rr][cc] = false;
          }
        }
      }
    }

    function setAlignment(m, row, col) {
      for (var r = -2; r <= 2; r++) {
        for (var c = -2; c <= 2; c++) {
          var rr = row + r;
          var cc = col + c;
          if (m[rr][cc] !== null) continue;
          m[rr][cc] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
        }
      }
    }

    var ALIGN = {
      1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
      6: [6, 34], 7: [6, 22, 38]
    };

    function setupPatterns(m, version) {
      var size = m.length;
      setFinder(m, 0, 0);
      setFinder(m, 0, size - 7);
      setFinder(m, size - 7, 0);
      for (var i = 8; i < size - 8; i++) {
        if (m[6][i] === null) m[6][i] = i % 2 === 0;
        if (m[i][6] === null) m[i][6] = i % 2 === 0;
      }
      var align = ALIGN[version] || [];
      for (var a = 0; a < align.length; a++) {
        for (var b = 0; b < align.length; b++) {
          if (m[align[a]][align[b]] === null) setAlignment(m, align[a], align[b]);
        }
      }
      for (var c = 0; c < 8; c++) {
        if (m[8][c] === null) m[8][c] = false;
        if (m[c][8] === null) m[c][8] = false;
      }
      if (m[8][size - 8] === null) m[8][size - 8] = true;
    }

    function reserveFormat(m) {
      for (var i = 0; i <= 8; i++) {
        if (i !== 6) { m[8][i] = m[8][i] || false; m[i][8] = m[i][8] || false; }
      }
      var s = m.length;
      for (var j = 0; j < 8; j++) {
        m[8][s - 1 - j] = m[8][s - 1 - j] || false;
        m[s - 1 - j][8] = m[s - 1 - j][8] || false;
      }
    }

    function placeData(m, data, mask) {
      var size = m.length;
      var bitIndex = 0;
      var dir = -1;
      var row = size - 1;
      for (var col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (var c = 0; c < 2; c++) {
            var cc = col - c;
            if (m[row][cc] === null) {
              var bit = bitIndex < data.length * 8 ? ((data[Math.floor(bitIndex / 8)] >> (7 - (bitIndex % 8))) & 1) : 0;
              bitIndex++;
              var dark = !!bit;
              if (mask === 0) dark = dark ^ ((row + cc) % 2 === 0);
              if (mask === 1) dark = dark ^ (row % 2 === 0);
              if (mask === 2) dark = dark ^ (cc % 3 === 0);
              if (mask === 3) dark = dark ^ ((row + cc) % 3 === 0);
              if (mask === 4) dark = dark ^ (Math.floor(row / 2) + Math.floor(cc / 3) % 2 === 0);
              if (mask === 5) dark = dark ^ ((row * cc) % 2 + (row * cc) % 3 === 0);
              if (mask === 6) dark = dark ^ (((row * cc) % 2 + (row * cc) % 3) % 2 === 0);
              if (mask === 7) dark = dark ^ (((row + cc) % 2 + (row * cc) % 3) % 2 === 0);
              m[row][cc] = dark;
            }
          }
          row += dir;
          if (row < 0 || row >= size) {
            row -= dir;
            dir = -dir;
            break;
          }
        }
      }
    }

    var FORMAT_BITS = [
      0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
      0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
      0x1689, 0x13be, 0x1ce1, 0x19d6, 0x0765, 0x0252, 0x0d0b, 0x080c,
      0x355f, 0x3068, 0x3f11, 0x3a26, 0x24b4, 0x21a3, 0x2e5a, 0x2b6d
    ];

    function writeFormat(m, mask) {
      var bits = FORMAT_BITS[EC_LEVEL * 8 + mask];
      var size = m.length;
      var coords = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
        [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
      ];
      for (var i = 0; i < 15; i++) {
        var dark = ((bits >> i) & 1) === 1;
        var a = coords[i];
        m[a[0]][a[1]] = dark;
        if (i < 8) m[size - 1 - i][8] = dark;
        else m[8][size - 15 + i] = dark;
      }
    }

    function penalty(m) {
      var size = m.length;
      var score = 0;
      for (var r = 0; r < size; r++) {
        var run = 0;
        var prev = null;
        for (var c = 0; c < size; c++) {
          if (m[r][c] === prev) run++;
          else { if (run >= 5) score += run - 2; run = 1; prev = m[r][c]; }
        }
        if (run >= 5) score += run - 2;
      }
      for (var cc = 0; cc < size; cc++) {
        var run2 = 0;
        var prev2 = null;
        for (var rr = 0; rr < size; rr++) {
          if (m[rr][cc] === prev2) run2++;
          else { if (run2 >= 5) score += run2 - 2; run2 = 1; prev2 = m[rr][cc]; }
        }
        if (run2 >= 5) score += run2 - 2;
      }
      return score;
    }

    function build(text) {
      var version = pickVersion(text);
      var data = encodeData(text, version);
      var best = null;
      var bestScore = Infinity;
      for (var mask = 0; mask < 8; mask++) {
        var m = createMatrix(version);
        setupPatterns(m, version);
        reserveFormat(m);
        placeData(m, data, mask);
        writeFormat(m, mask);
        var s = penalty(m);
        if (s < bestScore) { bestScore = s; best = m; }
      }
      return best;
    }

    function draw(canvas, text) {
      var matrix = build(text);
      if (!matrix) return false;
      var n = matrix.length;
      var px = 220;
      var cell = Math.max(2, Math.floor(px / n));
      var quiet = 4;
      var total = (n + quiet * 2) * cell;
      canvas.width = canvas.height = total;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, total, total);
      ctx.fillStyle = "#1e3d30";
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (matrix[r][c]) {
            ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
          }
        }
      }
      return true;
    }

    return { draw: draw };
  })();

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatQty(value, unit) {
    var num = Number(value);
    var text = Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, "");
    return unit ? text + " " + unit : text;
  }

  function formatMoney(value) {
    var num = Number(value) || 0;
    return "₱" + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function showToast(message, type) {
    var toast = $("supplier-toast");
    if (!toast) return;
    var icon = toast.querySelector("i");
    var span = toast.querySelector("span");
    toast.classList.remove("show", "error");
    if (type === "error") {
      toast.style.background = "var(--danger)";
      if (icon) icon.className = "ti ti-alert-circle";
    } else {
      toast.style.background = "";
      if (icon) icon.className = "ti ti-circle-check";
    }
    if (span) span.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 3200);
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
          if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
          return data;
        });
      });
  }

  function qrPayloadForPo(po) {
    return JSON.stringify({ deliveryId: po.deliveryId, poId: po.id });
  }

  function loadActivity() {
    return apiFetch("/api/activity")
      .then(function (data) {
        activity = Array.isArray(data) ? data : [];
        return activity;
      })
      .catch(function () {
        activity = [];
        return activity;
      });
  }

  function statusBadge(status, text) {
    var raw = (status || "").toLowerCase();
    var cls = "pending";
    if (raw.indexOf("reject") !== -1) cls = "rejected";
    else if (raw.indexOf("accept") !== -1 || raw === "delivered") cls = "delivered";
    else if (raw.indexOf("transit") !== -1 || raw.indexOf("transmit") !== -1) cls = "partial";
    else if (raw.indexOf("partial") !== -1) cls = "partial";
    else if (raw.indexOf("wait") !== -1) cls = "pending";
    return '<span class="staff-badge ' + escapeHtml(cls) + '">' + escapeHtml(text || status || "—") + "</span>";
  }

  function feedItem(icon, title, meta, time) {
    return (
      '<div class="feed-item">' +
      '<div class="feed-icon"><i class="ti ' + icon + '"></i></div>' +
      '<div class="feed-copy"><strong>' + escapeHtml(title) + "</strong><span>" + escapeHtml(meta) + "</span></div>" +
      '<span class="feed-time">' + escapeHtml(time || "") + "</span></div>"
    );
  }

  function emptyFeed(message) {
    return '<div class="empty-state">' + escapeHtml(message) + "</div>";
  }

  function isNewPo(po) {
    return po.status === "Waiting for Supplier" || po.status === "Transmitted";
  }

  function isAcceptedPo(po) {
    return po.status === "Accepted" || po.status === "In Transit";
  }

  function isRejectedPo(po) {
    return (po.status || "").indexOf("Rejected") !== -1;
  }

  function getStoredQrs() {
    try {
      var raw = localStorage.getItem(QR_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveStoredQr(entry) {
    var list = getStoredQrs().filter(function (item) {
      return item.deliveryId !== entry.deliveryId;
    });
    list.unshift(entry);
    localStorage.setItem(QR_STORAGE_KEY, JSON.stringify(list.slice(0, 100)));
  }

  function closeMobileSidebar() {
    document.body.classList.remove("mobile-sidebar-open");
  }

  function openMobileSidebar() {
    document.body.classList.add("mobile-sidebar-open");
  }

  function setActiveNav(screen) {
    document.querySelectorAll("[data-screen]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-screen") === screen);
    });
    document.querySelectorAll(".staff-nav-group").forEach(function (group) {
      var hasActive = group.querySelector('[data-screen="' + screen + '"]');
      if (hasActive) group.classList.add("open");
    });
  }

  function showScreen(screen) {
    document.querySelectorAll(".staff-screen").forEach(function (section) {
      section.classList.remove("active");
    });
    var target = $("supplier-screen-" + screen);
    if (target) target.classList.add("active");
    setActiveNav(screen);
    var meta = SCREEN_META[screen] || { title: "Supplier Portal", subtitle: "" };
    var titleEl = $("supplier-page-title");
    var subtitleEl = $("supplier-page-subtitle");
    if (titleEl) titleEl.textContent = meta.title;
    if (subtitleEl) subtitleEl.textContent = meta.subtitle;
    closeMobileSidebar();
  }

  function setupNavigation() {
    document.querySelectorAll("[data-screen]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var screen = btn.getAttribute("data-screen");
        if (screen) showScreen(screen);
      });
    });
  }

  function setupNavGroups() {
    document.querySelectorAll(".staff-nav-group .group-toggle").forEach(function (toggle) {
      toggle.addEventListener("click", function () {
        var group = toggle.closest(".staff-nav-group");
        if (group) group.classList.toggle("open");
      });
    });
  }

  function setupMobileNav() {
    if (window.PortalSidebar) {
      window.PortalSidebar.setup("supplier-menu-button", "supplier-sidebar-overlay");
    }
  }

  function startLiveSync() {
    setInterval(function () {
      refreshData().catch(function () { /* ignore transient sync errors */ });
    }, 8000);
  }

  function showConfirmModal(title, message, onConfirm) {
    var modal = $("supplier-confirm-modal");
    var titleEl = $("confirm-modal-title");
    var msgEl = $("confirm-modal-message");
    if (!modal) return;
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    pendingConfirm = onConfirm;
    modal.hidden = false;
  }

  function hideConfirmModal() {
    var modal = $("supplier-confirm-modal");
    if (modal) modal.hidden = true;
    pendingConfirm = null;
  }

  function setupConfirmModal() {
    var cancelBtn = $("confirm-modal-cancel");
    var confirmBtn = $("confirm-modal-confirm");
    var modal = $("supplier-confirm-modal");
    if (cancelBtn) cancelBtn.addEventListener("click", hideConfirmModal);
    if (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target === modal) hideConfirmModal();
      });
    }
    if (confirmBtn) {
      confirmBtn.addEventListener("click", function () {
        if (typeof pendingConfirm === "function") pendingConfirm();
        hideConfirmModal();
      });
    }
  }

  function respondToPo(id, action) {
    var po = purchaseOrders.find(function (o) { return String(o.id) === String(id); });
    if (!po) return;
    var verb = action === "accept" ? "accept" : "reject";
    showConfirmModal(
      action === "accept" ? "Accept Purchase Order" : "Reject Purchase Order",
      "Are you sure you want to " + verb + " PO #" + po.id + " for " + po.itemName + "?",
      function () {
        apiFetch("/api/supplier/purchase-orders/respond", {
          method: "POST",
          body: JSON.stringify({ id: po.id, action: action })
        })
          .then(function (result) {
            showToast("Purchase order " + (action === "accept" ? "accepted" : "rejected") + ".");
            if (action === "accept" && result.deliveryId) {
              saveStoredQr({
                deliveryId: result.deliveryId,
                poNumber: po.id,
                itemName: po.itemName,
                qty: po.qty,
                unit: po.unit,
                status: "QR Generated",
                date: new Date().toLocaleString(),
                source: "local"
              });
            }
            return refreshData();
          })
          .catch(function (err) {
            showToast(err.message || "Could not update purchase order.", "error");
          });
      }
    );
  }

  function bindPoActions(container) {
    if (!container) return;
    container.querySelectorAll("[data-po-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        respondToPo(btn.getAttribute("data-po-id"), btn.getAttribute("data-po-action"));
      });
    });
    container.querySelectorAll("[data-show-qr]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var poId = btn.getAttribute("data-show-qr");
        showScreen("generate-qr");
        var select = $("qr-po-select");
        if (select) select.value = poId;
        generateQrPreview();
      });
    });
  }

  function filterPoList(list, query) {
    query = (query || "").trim().toLowerCase();
    if (!query) return list;
    return list.filter(function (po) {
      var hay = [po.id, po.itemName, po.status, po.deliveryId, po.supplier].join(" ").toLowerCase();
      return hay.indexOf(query) !== -1;
    });
  }

  function renderPoNew() {
    var tbody = $("po-new-tbody");
    if (!tbody) return;
    var query = $("po-new-search") && $("po-new-search").value;
    var items = filterPoList(purchaseOrders.filter(isNewPo), query);
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No new purchase orders at this time.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (po) {
      return (
        "<tr>" +
        "<td>#" + escapeHtml(po.id) + "</td>" +
        "<td>" + escapeHtml(po.itemName) + "</td>" +
        "<td>" + escapeHtml(formatQty(po.qty, po.unit)) + "</td>" +
        "<td>" + escapeHtml(formatMoney(po.total)) + "</td>" +
        "<td>" + statusBadge(po.status) + "</td>" +
        "<td>" + escapeHtml(po.date || "—") + "</td>" +
        '<td><div class="po-actions">' +
        '<button type="button" class="staff-btn primary" data-po-action="accept" data-po-id="' + escapeHtml(po.id) + '"><i class="ti ti-check"></i> Accept</button>' +
        '<button type="button" class="staff-btn secondary" data-po-action="reject" data-po-id="' + escapeHtml(po.id) + '"><i class="ti ti-x"></i> Reject</button>' +
        "</div></td></tr>"
      );
    }).join("");
    bindPoActions(tbody);
  }

  function renderPoAccepted() {
    var tbody = $("po-accepted-tbody");
    if (!tbody) return;
    var query = $("po-accepted-search") && $("po-accepted-search").value;
    var items = filterPoList(purchaseOrders.filter(isAcceptedPo), query);
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No accepted orders yet.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (po) {
      return (
        "<tr>" +
        "<td>#" + escapeHtml(po.id) + "</td>" +
        "<td>" + escapeHtml(po.itemName) + "</td>" +
        "<td>" + escapeHtml(formatQty(po.qty, po.unit)) + "</td>" +
        "<td>" + escapeHtml(formatMoney(po.total)) + "</td>" +
        "<td>" + statusBadge(po.status) + "</td>" +
        "<td>" + escapeHtml(po.deliveryId || "—") + "</td>" +
        "<td>" + escapeHtml(po.date || "—") + "</td>" +
        '<td><button type="button" class="staff-btn secondary" data-show-qr="' + escapeHtml(po.id) + '"><i class="ti ti-qrcode"></i> QR</button></td>' +
        "</tr>"
      );
    }).join("");
    bindPoActions(tbody);
  }

  function renderPoRejected() {
    var tbody = $("po-rejected-tbody");
    if (!tbody) return;
    var query = $("po-rejected-search") && $("po-rejected-search").value;
    var items = filterPoList(purchaseOrders.filter(isRejectedPo), query);
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No rejected orders on record.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (po) {
      return (
        "<tr>" +
        "<td>#" + escapeHtml(po.id) + "</td>" +
        "<td>" + escapeHtml(po.itemName) + "</td>" +
        "<td>" + escapeHtml(formatQty(po.qty, po.unit)) + "</td>" +
        "<td>" + escapeHtml(formatMoney(po.total)) + "</td>" +
        "<td>" + statusBadge(po.status) + "</td>" +
        "<td>" + escapeHtml(po.date || "—") + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderQrSelect() {
    var select = $("qr-po-select");
    if (!select) return;
    var accepted = purchaseOrders.filter(function (po) {
      return po.status === "Accepted" || po.status === "In Transit";
    });
    var current = select.value;
    select.innerHTML = '<option value="">Choose a purchase order</option>' + accepted.map(function (po) {
      return '<option value="' + escapeHtml(po.id) + '">PO #' + escapeHtml(po.id) + " — " + escapeHtml(po.itemName) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  function generateQrPreview() {
    var select = $("qr-po-select");
    var area = $("qr-preview-area");
    if (!select || !area) return;
    var po = purchaseOrders.find(function (o) { return String(o.id) === String(select.value); });
    if (!po || !po.deliveryId) {
      area.innerHTML = '<i class="ti ti-qrcode" style="font-size:48px;color:#b8c6be"></i><p class="empty-state" style="padding:0">Select an accepted order and generate a QR code.</p>';
      return;
    }
    var canvas = document.createElement("canvas");
    if (!QR.draw(canvas, qrPayloadForPo(po))) {
      showToast("Could not generate QR code.", "error");
      return;
    }
    saveStoredQr({
      deliveryId: po.deliveryId,
      poNumber: po.id,
      itemName: po.itemName,
      qty: po.qty,
      unit: po.unit,
      status: "QR Generated",
      date: new Date().toLocaleString(),
      source: "local"
    });
    area.innerHTML = "";
    area.appendChild(canvas);
    var meta = document.createElement("div");
    meta.className = "qr-meta";
    meta.innerHTML = "<strong>" + escapeHtml(po.deliveryId) + "</strong><span>PO #" + escapeHtml(po.id) + " · " + escapeHtml(po.itemName) + "</span>";
    area.appendChild(meta);
    showToast("QR code generated and saved to delivery history.");
    renderDeliveryHistory();
  }

  function mergedDeliveryHistory() {
    var apiRows = deliveries.map(function (d) {
      return {
        deliveryId: d.deliveryId,
        poNumber: d.poNumber,
        itemName: d.itemName,
        qty: d.qty,
        unit: d.unit,
        status: d.status,
        date: d.date,
        rejectionReason: d.rejectionReason || "",
        resolutionAction: d.resolutionAction || "",
        resolutionStatus: d.resolutionStatus || "",
        source: "server"
      };
    });
    var localRows = getStoredQrs();
    var seen = {};
    var merged = [];
    apiRows.forEach(function (row) {
      seen[row.deliveryId] = true;
      merged.push(row);
    });
    localRows.forEach(function (row) {
      if (!seen[row.deliveryId]) merged.unshift(row);
    });
    return merged;
  }

  function renderDeliveryHistory() {
    var tbody = $("delivery-history-tbody");
    if (!tbody) return;
    var query = ($("delivery-history-search") && $("delivery-history-search").value || "").trim().toLowerCase();
    var filter = ($("delivery-history-filter") && $("delivery-history-filter").value) || "all";
    var items = mergedDeliveryHistory().filter(function (row) {
      var hay = [row.deliveryId, row.poNumber, row.itemName, row.status].join(" ").toLowerCase();
      if (query && hay.indexOf(query) === -1) return false;
      var status = (row.status || "").toLowerCase();
      if (filter === "pending") return status.indexOf("transit") !== -1 || status.indexOf("accept") !== -1 || status.indexOf("pending") !== -1 || status.indexOf("preparation") !== -1;
      if (filter === "completed") return status.indexOf("deliver") !== -1 || status.indexOf("partial") !== -1;
      if (filter === "rejected") return status.indexOf("reject") !== -1;
      if (filter === "generated") return row.source === "local" || status.indexOf("qr") !== -1;
      return true;
    });
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No delivery records found.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (row) {
      var actions = "";
      if ((row.status || "").toLowerCase().indexOf("reject") !== -1) {
        actions = '<div class="staff-table-actions">' +
          ['Redelivery', 'Replace Item', 'Refund', 'Contact Manager'].map(function (action) {
            return '<button type="button" class="staff-btn secondary compact resolve-delivery-btn" data-delivery-id="' + escapeHtml(row.deliveryId) + '" data-action="' + escapeHtml(action) + '">' + escapeHtml(action) + '</button>';
          }).join("") +
          "</div>";
        if (row.rejectionReason) {
          actions = '<span class="staff-badge rejected">' + escapeHtml(row.rejectionReason) + "</span>" + actions;
        }
      } else {
        actions = escapeHtml(row.source === "local" ? "Local QR" : "System");
      }
      return (
        "<tr>" +
        "<td>" + escapeHtml(row.deliveryId) + "</td>" +
        "<td>#" + escapeHtml(row.poNumber) + "</td>" +
        "<td>" + escapeHtml(row.itemName) + "</td>" +
        "<td>" + escapeHtml(formatQty(row.qty, row.unit)) + "</td>" +
        "<td>" + statusBadge(row.status) + "</td>" +
        "<td>" + escapeHtml(row.date || "—") + "</td>" +
        "<td>" + actions + "</td>" +
        "</tr>"
      );
    }).join("");

    tbody.querySelectorAll(".resolve-delivery-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        apiFetch("/api/supplier/deliveries/resolve", {
          method: "POST",
          body: JSON.stringify({
            deliveryId: btn.getAttribute("data-delivery-id"),
            action: btn.getAttribute("data-action"),
          }),
        }).then(function () {
          showToast("Resolution request submitted.");
          return refreshData();
        }).catch(function (err) {
          showToast(err.message || "Could not submit resolution.", "error");
        });
      });
    });
  }

  function renderSupportTickets() {
    var container = $("support-ticket-list");
    if (!container) return;
    if (!supportTickets.length) {
      container.innerHTML = emptyFeed("No support tickets submitted yet.");
      return;
    }
    container.innerHTML = supportTickets.slice(0, 12).map(function (ticket) {
      return feedItem(
        "ti-headset",
        ticket.subject,
        ticket.category + " · " + ticket.status + (ticket.ticketId ? " · " + ticket.ticketId : ""),
        ticket.date
      );
    }).join("");
  }

  function renderDashboard() {
    var stats = dashboard || {};
    if ($("kpi-new-orders")) $("kpi-new-orders").textContent = stats.newOrders || 0;
    if ($("kpi-accepted-orders")) $("kpi-accepted-orders").textContent = stats.acceptedOrders || 0;
    if ($("kpi-pending-deliveries")) $("kpi-pending-deliveries").textContent = stats.pendingDeliveries || 0;
    if ($("kpi-completed-deliveries")) $("kpi-completed-deliveries").textContent = stats.completedDeliveries || 0;

    if ($("dash-po-new")) $("dash-po-new").textContent = stats.newOrders || 0;
    if ($("dash-po-accepted")) $("dash-po-accepted").textContent = stats.acceptedOrders || 0;
    if ($("dash-po-rejected")) $("dash-po-rejected").textContent = stats.rejectedOrders || 0;

    var transit = deliveries.filter(function (d) {
      var s = (d.status || "").toLowerCase();
      return s.indexOf("transit") !== -1 || s === "accepted";
    }).length;
    var completed = deliveries.filter(function (d) {
      var s = (d.status || "").toLowerCase();
      return s.indexOf("deliver") !== -1 || s.indexOf("partial") !== -1;
    }).length;
    var pending = (stats.pendingDeliveries || 0) - transit;
    if (pending < 0) pending = 0;

    if ($("dash-delivery-pending")) $("dash-delivery-pending").textContent = pending;
    if ($("dash-delivery-transit")) $("dash-delivery-transit").textContent = transit;
    if ($("dash-delivery-completed")) $("dash-delivery-completed").textContent = completed || stats.completedDeliveries || 0;

    var actFeed = $("supplier-activity-feed");
    if (actFeed) {
      if (!activity.length) {
        actFeed.innerHTML = emptyFeed("No recent activity yet.");
      } else {
        actFeed.innerHTML = activity.slice(0, 6).map(function (log) {
          var icon = "ti-activity";
          if ((log.event || "").toLowerCase().indexOf("purchase") !== -1) icon = "ti-file-invoice";
          if ((log.event || "").toLowerCase().indexOf("delivery") !== -1) icon = "ti-truck-delivery";
          if ((log.event || "").toLowerCase().indexOf("support") !== -1) icon = "ti-headset";
          return feedItem(icon, log.event, (log.item || "") + (log.reference ? " · " + log.reference : ""), log.time);
        }).join("");
      }
    }

    var prof = profile || stats.profile || {};
    if ($("dash-company-name")) $("dash-company-name").textContent = prof.companyName || "—";
    if ($("dash-supplier-id")) $("dash-supplier-id").textContent = prof.supplierId || "—";
    if ($("dash-contact-person")) $("dash-contact-person").textContent = prof.contactPerson || "—";
    if ($("dash-email")) $("dash-email").textContent = prof.email || "—";
    if ($("dash-contact-number")) $("dash-contact-number").textContent = prof.contactNumber || "—";
    if ($("dash-business-address")) $("dash-business-address").textContent = prof.businessAddress || "—";
  }

  function renderCatalogPricing() {
    var tbody = $("catalog-pricing-tbody");
    if (!tbody) return;
    if (!catalog.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No ingredients assigned to your company yet.</td></tr>';
      return;
    }
    tbody.innerHTML = catalog.map(function (entry, index) {
      return (
        "<tr>" +
        "<td>" + escapeHtml(entry.itemName) + "</td>" +
        "<td>" + formatMoney(entry.price) + "</td>" +
        '<td><input type="number" min="0" step="0.01" data-catalog-index="' + index + '" class="catalog-price-input" value="' + escapeHtml(entry.price) + '"></td>' +
        "</tr>"
      );
    }).join("");
  }

  function loadCatalog() {
    return apiFetch("/api/supplier/catalog").then(function (data) {
      catalog = Array.isArray(data.catalog) ? data.catalog : [];
      return catalog;
    }).catch(function () {
      catalog = [];
      return catalog;
    });
  }

  function saveCatalogPrices() {
    var updates = Array.prototype.slice.call(document.querySelectorAll(".catalog-price-input")).map(function (input) {
      var index = Number(input.getAttribute("data-catalog-index"));
      return {
        itemName: catalog[index] && catalog[index].itemName,
        price: parseFloat(input.value) || 0,
      };
    }).filter(function (entry) { return entry.itemName && entry.price > 0; });
    if (!updates.length) {
      showToast("No valid price updates to save.", "error");
      return;
    }
    apiFetch("/api/supplier/catalog", { method: "POST", body: JSON.stringify({ catalog: updates }) })
      .then(function (result) {
        showToast("Prices updated. The manager has been notified.");
        return loadCatalog().then(renderCatalogPricing);
      })
      .catch(function (err) {
        showToast(err.message || "Could not save prices.", "error");
      });
  }

  function renderAll() {
    renderDashboard();
    renderPoNew();
    renderPoAccepted();
    renderPoRejected();
    renderQrSelect();
    renderDeliveryHistory();
    renderSupportTickets();
    renderCatalogPricing();
  }

  function loadDashboard() {
    return apiFetch("/api/dashboard/supplier").then(function (data) {
      dashboard = data || {};
      if (data.profile) profile = data.profile;
      return dashboard;
    });
  }

  function loadPurchaseOrders() {
    return apiFetch("/api/supplier/purchase-orders").then(function (data) {
      purchaseOrders = Array.isArray(data) ? data : [];
      return purchaseOrders;
    });
  }

  function loadDeliveries() {
    return apiFetch("/api/supplier/deliveries").then(function (data) {
      deliveries = Array.isArray(data) ? data : [];
      return deliveries;
    });
  }

  function loadProfile() {
    return apiFetch("/api/profile").then(function (data) {
      profile = data || {};
      return profile;
    }).catch(function () {
      return profile;
    });
  }

  function loadSupport() {
    return apiFetch("/api/support").then(function (data) {
      supportTickets = Array.isArray(data) ? data : [];
      return supportTickets;
    }).catch(function () {
      supportTickets = [];
      return supportTickets;
    });
  }

  function refreshData() {
    return Promise.all([
      loadDashboard(),
      loadPurchaseOrders(),
      loadDeliveries(),
      loadActivity(),
      loadProfile(),
      loadSupport(),
      loadCatalog()
    ]).then(renderAll).catch(function (err) {
      showToast(err.message || "Failed to load portal data.", "error");
    });
  }

  function setupPoSearch() {
    ["po-new-search", "po-accepted-search", "po-rejected-search"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("input", function () {
        if (id === "po-new-search") renderPoNew();
        if (id === "po-accepted-search") renderPoAccepted();
        if (id === "po-rejected-search") renderPoRejected();
      });
    });
  }

  function setupDeliveryHistoryControls() {
    ["delivery-history-search", "delivery-history-filter"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("input", renderDeliveryHistory);
      if (el.tagName === "SELECT") el.addEventListener("change", renderDeliveryHistory);
    });
  }

  function setupQrGenerator() {
    var btn = $("generate-qr-button");
    if (btn) btn.addEventListener("click", generateQrPreview);
  }

  function setupSupportForm() {
    var form = $("support-form");
    var resetBtn = $("support-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (form) form.reset();
      });
    }
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var payload = {
          category: $("support-category") && $("support-category").value,
          subject: ($("support-subject") && $("support-subject").value || "").trim(),
          message: ($("support-message") && $("support-message").value || "").trim()
        };
        if (!payload.category || !payload.subject || !payload.message) {
          showToast("Complete all support request fields.", "error");
          return;
        }
        apiFetch("/api/support", { method: "POST", body: JSON.stringify(payload) })
          .then(function () {
            showToast("Support request submitted.");
            form.reset();
            return loadSupport().then(renderSupportTickets);
          })
          .catch(function (err) {
            showToast(err.message || "Could not submit support request.", "error");
          });
      });
    }
  }

  function setupAvatar() {
    var avatar = $("supplier-avatar");
    var username = document.body.getAttribute("data-username") || "";
    if (avatar && username) {
      avatar.textContent = username.slice(0, 2).toUpperCase();
    }
  }

  function setupCatalogPricing() {
    var saveBtn = $("catalog-save-btn");
    if (saveBtn) saveBtn.addEventListener("click", saveCatalogPrices);
  }

  function init() {
    if (window.PortalProfile) window.PortalProfile.loadHeaderProfile();
    setupNavigation();
    setupNavGroups();
    setupMobileNav();
    setupConfirmModal();
    setupPoSearch();
    setupDeliveryHistoryControls();
    setupQrGenerator();
    setupSupportForm();
    setupCatalogPricing();
    window.PortalSync = { refresh: refreshData };
    refreshData();
    startLiveSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
