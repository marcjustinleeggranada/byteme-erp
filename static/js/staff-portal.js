(function () {
  "use strict";

  var PAGE_SIZE = 5;
  var SCREEN_META = {
    dashboard: { title: "Dashboard Overview", subtitle: "Inventory operations and receiving activity" },
    "inventory-list": { title: "Inventory List", subtitle: "Browse and filter current stock levels" },
    "low-stock": { title: "Low Stock Items", subtitle: "Items at or below reorder level" },
    "stock-adjustments": { title: "Stock Adjustments", subtitle: "Record damaged, expired, or corrected inventory" },
    "purchase-requests": { title: "Purchase Requests", subtitle: "Submit and track restock requests" },
    "pending-deliveries": { title: "Pending Deliveries", subtitle: "Deliveries awaiting receipt" },
    "receive-deliveries": { title: "Scan Delivery QR Code", subtitle: "Scan or search to verify incoming stock" },
    "delivery-history": { title: "Delivery History", subtitle: "Completed, partial, and rejected receipts" },
    "inventory-reports": { title: "Inventory Report", subtitle: "Current stock position and reorder risk" },
    "receiving-reports": { title: "Receiving Report", subtitle: "Completed, partial, and rejected deliveries" },
    support: { title: "My Support Tickets", subtitle: "Submit and track support requests" }
  };

  var inventory = [];
  var adjustments = [];
  var deliveries = [];
  var purchaseRequests = [];
  var suppliers = [];
  var activity = [];
  var inventoryPage = 1;
  var currentDelivery = null;
  var qrScanner = null;
  var qrScannerStopping = null;
  var adjustmentBaselineStock = null;
  var toastTimer = null;

  var $ = function (id) { return document.getElementById(id); };

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

  function showToast(message, type) {
    var toast = $("staff-toast");
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
    return fetch(url, Object.assign({}, options, { headers: headers }))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
          return data;
        });
      });
  }

  function parseDeliveryLookup(raw) {
    var text = String(raw || "").trim();
    if (!text) return "";
    if (text.toUpperCase().indexOf("BYTEME:") === 0) text = text.split(":").slice(1).join(":").trim();
    if (text.charAt(0) === "{") {
      try {
        var payload = JSON.parse(text);
        return String(payload.deliveryId || payload.poId || "").trim();
      } catch (e) { /* ignore */ }
    }
    return text;
  }

  function stockPriority(status) {
    var order = { "out-of-stock": 0, critical: 1, "low-stock": 2, "in-stock": 3 };
    return order[status] != null ? order[status] : 9;
  }

  function getStockStatus(item) {
    var stock = Number(item.stock) || 0;
    var threshold = Number(item.threshold) || 0;
    if (stock <= 0) return "out-of-stock";
    if (threshold <= 0) return "in-stock";
    if (stock <= threshold * 0.5) return "critical";
    if (stock <= threshold) return "low-stock";
    return "in-stock";
  }

  function statusLabel(status) {
    var labels = {
      "in-stock": "In Stock",
      "low-stock": "Low Stock",
      critical: "Critical",
      "out-of-stock": "Out of Stock",
      pending: "Pending",
      approved: "Approved",
      delivered: "Delivered",
      partial: "Partial",
      rejected: "Rejected"
    };
    return labels[status] || status;
  }

  function statusBadge(status, text) {
    var cls = status.toLowerCase().replace(/\s+/g, "-");
    if (cls === "delivered" || cls === "approved") cls = "delivered";
    if (cls === "good-condition") cls = "in-stock";
    return '<span class="staff-badge ' + escapeHtml(cls) + '">' + escapeHtml(text || statusLabel(status)) + "</span>";
  }

  function isOutOfStock(item) {
    return (Number(item.stock) || 0) <= 0;
  }

  function isCompletedDelivery(d) {
    var s = (d.status || "").toLowerCase();
    return s === "delivered" || s === "partial";
  }

  function isPendingRequest(r) {
    return (r.status || "").toLowerCase() === "pending";
  }

  function isPendingDelivery(d) {
    var s = (d.status || "").toLowerCase();
    return s === "pending" || s === "transmitted" || s === "in transit" || s === "in preparation";
  }

  function isToday(dateStr) {
    if (!dateStr || dateStr === "—") return false;
    var today = new Date();
    var monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    var month = monthNames[today.getMonth()];
    var day = today.getDate();
    var year = today.getFullYear();
    return dateStr.indexOf(month) !== -1 && dateStr.indexOf(String(day)) !== -1 && dateStr.indexOf(String(year)) !== -1;
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
    var target = $("staff-screen-" + screen);
    if (target) target.classList.add("active");
    setActiveNav(screen);
    var meta = SCREEN_META[screen] || { title: "Staff Portal", subtitle: "" };
    var titleEl = $("staff-page-title");
    var subtitleEl = $("staff-page-subtitle");
    if (titleEl) titleEl.textContent = meta.title;
    if (subtitleEl) subtitleEl.textContent = meta.subtitle;
    closeMobileSidebar();
    if (screen === "receive-deliveries") stopQrScanner();
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
      window.PortalSidebar.setup("staff-menu-button", "staff-sidebar-overlay");
    }
  }

  function startLiveSync() {
    setInterval(function () {
      refreshData().catch(function () { /* ignore transient sync errors */ });
    }, 8000);
  }

  function loadInventory() {
    return apiFetch("/api/inventory").then(function (data) {
      inventory = Array.isArray(data) ? data : [];
      return inventory;
    });
  }

  function loadAdjustments() {
    return apiFetch("/api/staff/adjustments").then(function (data) {
      adjustments = Array.isArray(data) ? data : [];
      return adjustments;
    });
  }

  function loadDeliveries() {
    return apiFetch("/api/staff/deliveries").then(function (data) {
      deliveries = Array.isArray(data) ? data : [];
      return deliveries;
    });
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

  function loadSuppliers() {
    return apiFetch("/api/suppliers").then(function (data) {
      suppliers = Array.isArray(data) ? data : [];
      return suppliers;
    });
  }

  function populateSupplierSelect() {
    var select = $("pr-supplier");
    if (!select) return;
    var current = select.value;
    select.innerHTML = '<option value="">Select supplier</option>' + suppliers.map(function (supplier) {
      return '<option value="' + escapeHtml(supplier.name) + '">' + escapeHtml(supplier.name) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  function loadPurchaseRequests() {
    return apiFetch("/api/purchase-requests").then(function (data) {
      purchaseRequests = Array.isArray(data) ? data : [];
      return purchaseRequests;
    });
  }

  function renderDashboard() {
    var lowCount = inventory.filter(function (item) {
      var s = getStockStatus(item);
      return s === "low-stock" || s === "critical";
    }).length;
    var pendingRequestCount = purchaseRequests.filter(isPendingRequest).length;
    var todayCount = deliveries.filter(function (d) {
      return isToday(d.dateReceived) && isCompletedDelivery(d);
    }).length;
    var completedCount = deliveries.filter(isCompletedDelivery).length;

    if ($("kpi-total-items")) $("kpi-total-items").textContent = inventory.length;
    if ($("kpi-low-items")) $("kpi-low-items").textContent = lowCount;
    if ($("kpi-pending-requests")) $("kpi-pending-requests").textContent = pendingRequestCount;
    if ($("kpi-today-deliveries")) $("kpi-today-deliveries").textContent = todayCount;
    if ($("kpi-completed-deliveries")) $("kpi-completed-deliveries").textContent = completedCount;

    var actFeed = $("staff-activity-feed");
    if (actFeed) {
      if (!activity.length) {
        actFeed.innerHTML = emptyFeed("No recent activity to display.");
      } else {
        actFeed.innerHTML = activity.slice(0, 6).map(function (log) {
          var icon = "ti-activity";
          var eventLower = (log.event || "").toLowerCase();
          if (eventLower.indexOf("delivery") !== -1) icon = "ti-truck-delivery";
          if (eventLower.indexOf("adjustment") !== -1) icon = "ti-adjustments";
          if (eventLower.indexOf("purchase") !== -1) icon = "ti-file-plus";
          return feedItem(icon, log.event, (log.item || "") + (log.reference ? " · " + log.reference : ""), log.time);
        }).join("");
      }
    }

    var alertsFeed = $("dashboard-inventory-alerts");
    if (alertsFeed) {
      var alertItems = inventory.filter(function (item) {
        return isOutOfStock(item) || getStockStatus(item) !== "in-stock";
      }).slice(0, 6);
      if (!alertItems.length) {
        alertsFeed.innerHTML = emptyFeed("No inventory alerts right now.");
      } else {
        alertsFeed.innerHTML = alertItems.map(function (item) {
          var out = isOutOfStock(item);
          var icon = out ? "ti-ban" : "ti-alert-triangle";
          var label = out ? "Out of stock" : statusLabel(getStockStatus(item));
          return feedItem(
            icon,
            item.name,
            label + " · " + formatQty(item.stock, item.unit) + " on hand",
            "Reorder: " + formatQty(item.threshold, item.unit)
          );
        }).join("");
      }
    }

    var pendingFeed = $("dashboard-pending-deliveries");
    if (pendingFeed) {
      var pendingList = deliveries.filter(isPendingDelivery).slice(0, 5);
      if (!pendingList.length) {
        pendingFeed.innerHTML = emptyFeed("No pending deliveries right now.");
      } else {
        pendingFeed.innerHTML = pendingList.map(function (d) {
          return feedItem(
            "ti-truck-loading",
            d.deliveryId + " · " + d.supplier,
            d.itemName + " · " + formatQty(d.expectedQuantity, d.unit),
            d.status || "Pending"
          );
        }).join("");
      }
    }

    var summaryFeed = $("dashboard-request-summary");
    if (summaryFeed) {
      if (!purchaseRequests.length) {
        summaryFeed.innerHTML = emptyFeed("No purchase requests submitted yet.");
      } else {
        var counts = { pending: 0, approved: 0, rejected: 0 };
        purchaseRequests.forEach(function (r) {
          var s = (r.status || "").toLowerCase();
          if (s === "approved") counts.approved++;
          else if (s === "rejected") counts.rejected++;
          else counts.pending++;
        });
        var summaryHtml =
          '<div class="feed-item"><div class="feed-icon"><i class="ti ti-clock"></i></div><div class="feed-copy"><strong>Pending</strong><span>' + counts.pending + " request" + (counts.pending === 1 ? "" : "s") + " awaiting review</span></div></div>" +
          '<div class="feed-item"><div class="feed-icon"><i class="ti ti-circle-check"></i></div><div class="feed-copy"><strong>Approved</strong><span>' + counts.approved + " request" + (counts.approved === 1 ? "" : "s") + " approved</span></div></div>" +
          '<div class="feed-item"><div class="feed-icon"><i class="ti ti-x"></i></div><div class="feed-copy"><strong>Rejected</strong><span>' + counts.rejected + " request" + (counts.rejected === 1 ? "" : "s") + " rejected</span></div></div>";
        var recent = purchaseRequests.slice(0, 3).map(function (r) {
          return feedItem(
            "ti-file-plus",
            r.itemName + " · " + formatQty(r.qty, r.unit),
            r.id + " · " + (r.status || "Pending"),
            r.date
          );
        }).join("");
        summaryFeed.innerHTML = summaryHtml + recent;
      }
    }
  }

  function filteredInventory() {
    var query = ($("inventory-search") && $("inventory-search").value || "").trim().toLowerCase();
    var statusFilter = ($("inventory-status-filter") && $("inventory-status-filter").value) || "all";
    return inventory.filter(function (item) {
      var matchesQuery = !query ||
        String(item.id).toLowerCase().indexOf(query) !== -1 ||
        (item.name || "").toLowerCase().indexOf(query) !== -1;
      var status = getStockStatus(item);
      var matchesStatus = statusFilter === "all" || status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }

  function renderInventoryList() {
    var tbody = $("staff-inventory-tbody");
    if (!tbody) return;
    var items = filteredInventory();
    var totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (inventoryPage > totalPages) inventoryPage = totalPages;
    if (inventoryPage < 1) inventoryPage = 1;
    var start = (inventoryPage - 1) * PAGE_SIZE;
    var pageItems = items.slice(start, start + PAGE_SIZE);

    if (!pageItems.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No inventory items match your filters.</td></tr>';
    } else {
      tbody.innerHTML = pageItems.map(function (item) {
        var status = getStockStatus(item);
        return (
          "<tr>" +
          "<td>#" + escapeHtml(item.id) + "</td>" +
          "<td>" + escapeHtml(item.name) + "</td>" +
          "<td>" + escapeHtml(item.supplier || "—") + "</td>" +
          "<td>" + escapeHtml(formatQty(item.stock)) + "</td>" +
          "<td>" + escapeHtml(item.unit || "—") + "</td>" +
          "<td>" + statusBadge(status) + "</td>" +
          "<td>—</td>" +
          "</tr>"
        );
      }).join("");
    }

    var pageInfo = $("inventory-page-info");
    if (pageInfo) pageInfo.textContent = "Page " + inventoryPage + " of " + totalPages + " (" + items.length + " items)";
    var prevBtn = $("inventory-prev");
    var nextBtn = $("inventory-next");
    if (prevBtn) prevBtn.disabled = inventoryPage <= 1;
    if (nextBtn) nextBtn.disabled = inventoryPage >= totalPages;
  }

  function renderLowStock() {
    var lowItems = inventory.filter(function (item) {
      return getStockStatus(item) !== "in-stock";
    }).sort(function (a, b) {
      var diff = stockPriority(getStockStatus(a)) - stockPriority(getStockStatus(b));
      if (diff !== 0) return diff;
      return (a.name || "").localeCompare(b.name || "");
    });
    var criticalCount = lowItems.filter(function (item) {
      return getStockStatus(item) === "critical";
    }).length;

    if ($("low-alert-count")) $("low-alert-count").textContent = lowItems.length + " item" + (lowItems.length === 1 ? "" : "s") + " require attention";
    if ($("critical-alert-count")) $("critical-alert-count").textContent = criticalCount + " critical item" + (criticalCount === 1 ? "" : "s");

    var tbody = $("low-stock-tbody");
    if (!tbody) return;
    if (!lowItems.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">All items are above reorder level.</td></tr>';
      return;
    }
    tbody.innerHTML = lowItems.map(function (item) {
      var status = getStockStatus(item);
      return (
        "<tr>" +
        "<td>" + escapeHtml(item.name) + "</td>" +
        "<td>" + escapeHtml(formatQty(item.stock, item.unit)) + "</td>" +
        "<td>" + escapeHtml(formatQty(item.threshold, item.unit)) + "</td>" +
        "<td>" + statusBadge(status) + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderAdjustmentItemSelect() {
    var select = $("adjustment-item");
    if (!select) return;
    var current = select.value;
    select.innerHTML = '<option value="">Select item</option>' + inventory.map(function (item) {
      return '<option value="' + item.id + '">' + escapeHtml(item.name) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  function renderAdjustmentHistory() {
    var container = $("adjustment-history");
    if (!container) return;
    if (!adjustments.length) {
      container.innerHTML = emptyFeed("No adjustment history yet.");
      return;
    }
    container.innerHTML = adjustments.slice(0, 12).map(function (adj) {
      var qty = Number(adj.quantity);
      var sign = qty >= 0 ? "+" : "";
      return feedItem(
        "ti-adjustments",
        adj.itemName + " · " + adj.type,
        sign + formatQty(qty) + " → " + formatQty(adj.newStock) + " · " + adj.staff,
        adj.date
      );
    }).join("");
  }

  function renderPendingDeliveries() {
    var tbody = $("pending-deliveries-tbody");
    if (!tbody) return;
    var pending = deliveries.filter(isPendingDelivery);
    if (!pending.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No pending deliveries right now.</td></tr>';
      return;
    }
    tbody.innerHTML = pending.map(function (d) {
      return (
        "<tr>" +
        "<td>" + escapeHtml(d.deliveryId) + "</td>" +
        "<td>" + escapeHtml(d.supplier) + "</td>" +
        "<td>" + escapeHtml(d.poNumber) + "</td>" +
        "<td>" + escapeHtml(d.itemName) + "</td>" +
        "<td>" + escapeHtml(formatQty(d.expectedQuantity, d.unit)) + "</td>" +
        "<td>" + statusBadge("pending", d.status) + "</td>" +
        '<td><button type="button" class="staff-btn secondary receive-delivery-btn" data-delivery-id="' + escapeHtml(d.deliveryId) + '"><i class="ti ti-package-import"></i> Receive</button></td>' +
        "</tr>"
      );
    }).join("");

    tbody.querySelectorAll(".receive-delivery-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-delivery-id");
        showScreen("receive-deliveries");
        if ($("delivery-id-input")) $("delivery-id-input").value = id;
        loadDeliveryDetail(id);
      });
    });
  }

  function filteredHistory() {
    var query = ($("history-search") && $("history-search").value || "").trim().toLowerCase();
    var statusFilter = ($("history-filter") && $("history-filter").value) || "all";
    var sort = ($("history-sort") && $("history-sort").value) || "newest";
    var items = deliveries.filter(function (d) {
      return !isPendingDelivery(d);
    });
    items = items.filter(function (d) {
      var hay = [d.deliveryId, d.supplier, d.poNumber, d.itemName, d.status].join(" ").toLowerCase();
      var matchesQuery = !query || hay.indexOf(query) !== -1;
      var matchesStatus = statusFilter === "all" || (d.status || "").toLowerCase() === statusFilter.toLowerCase();
      return matchesQuery && matchesStatus;
    });
    items.sort(function (a, b) {
      var aVal = a.dateReceived || a.date || "";
      var bVal = b.dateReceived || b.date || "";
      if (sort === "oldest") return aVal.localeCompare(bVal);
      return bVal.localeCompare(aVal);
    });
    return items;
  }

  function renderDeliveryHistory() {
    var tbody = $("delivery-history-tbody");
    if (!tbody) return;
    var items = filteredHistory();
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No delivery history found.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (d) {
      var badgeStatus = (d.status || "").toLowerCase();
      if (badgeStatus === "delivered") badgeStatus = "delivered";
      else if (badgeStatus === "partial") badgeStatus = "partial";
      else if (badgeStatus === "rejected") badgeStatus = "rejected";
      return (
        "<tr>" +
        "<td>" + escapeHtml(d.deliveryId) + "</td>" +
        "<td>" + escapeHtml(d.supplier) + "</td>" +
        "<td>" + escapeHtml(d.poNumber) + "</td>" +
        "<td>" + statusBadge(badgeStatus, d.status) + "</td>" +
        "<td>" + escapeHtml(d.dateReceived || d.date) + "</td>" +
        "<td>" + escapeHtml(d.receivedBy) + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderInventoryReport() {
    var tbody = $("inventory-report-tbody");
    if (!tbody) return;
    if (!inventory.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No inventory data available.</td></tr>';
      return;
    }
    tbody.innerHTML = inventory.map(function (item) {
      var status = getStockStatus(item);
      return (
        "<tr>" +
        "<td>#" + escapeHtml(item.id) + "</td>" +
        "<td>" + escapeHtml(item.name) + "</td>" +
        "<td>" + escapeHtml(formatQty(item.stock, item.unit)) + "</td>" +
        "<td>" + escapeHtml(formatQty(item.threshold, item.unit)) + "</td>" +
        "<td>" + statusBadge(status) + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderReceivingReport() {
    var tbody = $("receiving-report-tbody");
    if (!tbody) return;
    var received = deliveries.filter(function (d) { return !isPendingDelivery(d); });
    if (!received.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No receiving records yet.</td></tr>';
      return;
    }
    tbody.innerHTML = received.map(function (d) {
      var badgeStatus = (d.status || "").toLowerCase();
      return (
        "<tr>" +
        "<td>" + escapeHtml(d.deliveryId) + "</td>" +
        "<td>" + escapeHtml(d.supplier) + "</td>" +
        "<td>" + escapeHtml(d.poNumber) + "</td>" +
        "<td>" + escapeHtml(formatQty(d.receivedQuantity, d.unit)) + "</td>" +
        "<td>" + statusBadge(badgeStatus, d.status) + "</td>" +
        "<td>" + escapeHtml(d.dateReceived || d.date) + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderPurchaseRequestItemSelect() {
    var select = $("pr-item");
    if (!select) return;
    var current = select.value;
    select.innerHTML = '<option value="">Select item</option>' + inventory.map(function (item) {
      return '<option value="' + item.id + '" data-unit="' + escapeHtml(item.unit || "pcs") + '" data-reorder-qty="' + escapeHtml(item.reorderQty || "") + '" data-supplier="' + escapeHtml(item.supplier || "") + '">' + escapeHtml(item.name) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  function renderPurchaseRequests() {
    var tbody = $("purchase-requests-tbody");
    if (!tbody) return;
    if (!purchaseRequests.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No purchase requests submitted yet.</td></tr>';
      return;
    }
    tbody.innerHTML = purchaseRequests.map(function (r) {
      var badgeStatus = (r.status || "Pending").toLowerCase();
      return (
        "<tr>" +
        "<td>" + escapeHtml(r.id) + "</td>" +
        "<td>" + escapeHtml(r.itemName) + "</td>" +
        "<td>" + escapeHtml(r.supplierName || "—") + "</td>" +
        "<td>" + escapeHtml(formatQty(r.qty, r.unit)) + "</td>" +
        "<td>" + statusBadge(badgeStatus, r.status) + "</td>" +
        "<td>" + escapeHtml(r.date || "—") + "</td>" +
        "<td>" + escapeHtml(r.reviewNote || "—") + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderAll() {
    renderDashboard();
    renderInventoryList();
    renderLowStock();
    renderAdjustmentItemSelect();
    renderAdjustmentHistory();
    renderPurchaseRequestItemSelect();
    populateSupplierSelect();
    renderPurchaseRequests();
    renderPendingDeliveries();
    renderDeliveryHistory();
    renderInventoryReport();
    renderReceivingReport();
  }

  function refreshData() {
    return Promise.all([
      loadInventory(),
      loadAdjustments(),
      loadDeliveries(),
      loadPurchaseRequests(),
      loadSuppliers(),
      loadActivity(),
      loadSupportTickets()
    ]).then(renderAll).catch(function (err) {
      showToast(err.message || "Failed to load portal data.", "error");
    });
  }

  function setupPurchaseRequestForm() {
    var form = $("purchase-request-form");
    var itemSelect = $("pr-item");
    var cancelBtn = $("pr-cancel");

    if (itemSelect) {
      itemSelect.addEventListener("change", function () {
        var option = itemSelect.options[itemSelect.selectedIndex];
        var unitInput = $("pr-unit");
        var qtyInput = $("pr-qty");
        if (unitInput && option) {
          unitInput.value = option.getAttribute("data-unit") || "pcs";
        }
        if (qtyInput && option) {
          var reorderQty = option.getAttribute("data-reorder-qty");
          qtyInput.value = reorderQty || "";
        }
        var supplierSelect = $("pr-supplier");
        var supplierName = option ? option.getAttribute("data-supplier") : "";
        if (supplierSelect && supplierName) supplierSelect.value = supplierName;
      });
    }

    if (cancelBtn && form) {
      cancelBtn.addEventListener("click", function () {
        form.reset();
        if ($("pr-unit")) $("pr-unit").value = "pcs";
      });
    }

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var item = inventory.find(function (i) { return String(i.id) === String($("pr-item") && $("pr-item").value); });
        if (!item) {
          showToast("Select an inventory item.", "error");
          return;
        }
        var payload = {
          itemName: item.name,
          supplierName: ($("pr-supplier") && $("pr-supplier").value || "").trim(),
          qty: parseFloat($("pr-qty") && $("pr-qty").value) || 0,
          unit: ($("pr-unit") && $("pr-unit").value || "pcs").trim() || "pcs",
          reason: ($("pr-reason") && $("pr-reason").value || "").trim()
        };
        if (!payload.supplierName) {
          showToast("Select a supplier for this request.", "error");
          return;
        }
        if (!payload.qty || payload.qty <= 0 || !payload.reason) {
          showToast("Enter quantity and reason.", "error");
          return;
        }
        apiFetch("/api/purchase-requests", { method: "POST", body: JSON.stringify(payload) })
          .then(function () {
            showToast("Purchase request submitted.");
            form.reset();
            if ($("pr-unit")) $("pr-unit").value = "pcs";
            return refreshData();
          })
          .catch(function (err) {
            showToast(err.message || "Could not submit request.", "error");
          });
      });
    }
  }

  function setupAdjustmentForm() {
    var form = $("adjustment-form");
    var itemSelect = $("adjustment-item");
    var cancelBtn = $("adjustment-cancel");
    var typeSelect = $("adjustment-type");
    var quantityInput = $("adjustment-quantity");
    var stockInput = $("adjustment-current-stock");
    var newStockInput = $("adjustment-new-stock");

    function setBaselineStock(item) {
      adjustmentBaselineStock = item ? Number(item.stock || 0) : null;
      if (stockInput) {
        stockInput.value = adjustmentBaselineStock != null ? formatQty(adjustmentBaselineStock, item && item.unit) : "";
      }
      previewStockFromQuantity();
    }

    function previewStockFromQuantity() {
      if (adjustmentBaselineStock == null || !typeSelect || !quantityInput) return;
      var qty = parseFloat(quantityInput.value);
      if (!qty || qty <= 0) {
        if (newStockInput) newStockInput.value = adjustmentBaselineStock != null ? formatQty(adjustmentBaselineStock) : "";
        return;
      }
      var type = typeSelect.value;
      var nextStock = adjustmentBaselineStock;
      if (type === "Add") nextStock = Math.max(0, adjustmentBaselineStock + qty);
      else if (type === "Deduct") nextStock = Math.max(0, adjustmentBaselineStock - qty);
      if (newStockInput) newStockInput.value = formatQty(nextStock);
    }

    if (itemSelect) {
      itemSelect.addEventListener("change", function () {
        var item = inventory.find(function (i) { return String(i.id) === String(itemSelect.value); });
        setBaselineStock(item);
      });
    }

    if (typeSelect) typeSelect.addEventListener("change", previewStockFromQuantity);
    if (quantityInput) quantityInput.addEventListener("input", previewStockFromQuantity);

    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        if (form) form.reset();
        adjustmentBaselineStock = null;
        if (stockInput) stockInput.value = "";
        if (newStockInput) newStockInput.value = "";
      });
    }

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var payload = {
          itemId: Number($("adjustment-item") && $("adjustment-item").value),
          type: typeSelect && typeSelect.value,
          quantity: parseFloat(quantityInput && quantityInput.value),
          reason: ($("adjustment-reason") && $("adjustment-reason").value || "").trim()
        };
        if (!payload.itemId || !payload.type || !payload.reason || !payload.quantity || payload.quantity <= 0) {
          showToast("Complete all adjustment fields.", "error");
          return;
        }
        apiFetch("/api/staff/adjustments", { method: "POST", body: JSON.stringify(payload) })
          .then(function () {
            showToast("Stock adjustment saved.");
            form.reset();
            adjustmentBaselineStock = null;
            if (stockInput) stockInput.value = "";
            if (newStockInput) newStockInput.value = "";
            return refreshData();
          })
          .catch(function (err) {
            showToast(err.message || "Could not save adjustment.", "error");
          });
      });
    }
  }

  function resetDeliveryView() {
    currentDelivery = null;
    var placeholder = $("delivery-placeholder");
    var form = $("delivery-verification");
    if (placeholder) placeholder.hidden = false;
    if (form) {
      form.hidden = true;
      form.reset();
    }
  }

  function showDeliveryDetail(detail) {
    currentDelivery = detail;
    var placeholder = $("delivery-placeholder");
    var form = $("delivery-verification");
    if (placeholder) placeholder.hidden = true;
    if (form) form.hidden = false;

    if ($("verify-delivery-id")) $("verify-delivery-id").textContent = detail.deliveryId || "—";
    if ($("verify-po-number")) $("verify-po-number").textContent = detail.poNumber || "—";
    if ($("verify-supplier")) $("verify-supplier").textContent = detail.supplier || "—";
    if ($("verify-item")) $("verify-item").textContent = detail.itemName || "—";
    if ($("verify-item-name")) $("verify-item-name").textContent = detail.itemName || "—";
    if ($("verify-expected-quantity")) {
      $("verify-expected-quantity").textContent = formatQty(detail.expectedQuantity, detail.unit);
    }

    var statusText = detail.alreadyReceived ? "Already received" : (detail.status || "Pending verification");
    if ($("verify-delivery-status")) $("verify-delivery-status").textContent = statusText;

    var badge = form && form.querySelector(".staff-badge");
    if (badge) {
      if (detail.alreadyReceived) {
        badge.className = "staff-badge delivered";
        badge.textContent = "Received";
      } else {
        badge.className = "staff-badge pending";
        badge.textContent = detail.status || "Pending";
      }
    }

    var receivedInput = $("received-quantity");
    if (receivedInput && !detail.alreadyReceived) {
      receivedInput.value = detail.expectedQuantity != null ? detail.expectedQuantity : "";
    }

    var submitBtn = form && form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = !!detail.alreadyReceived;
  }

  function loadDeliveryDetail(id) {
    if (!id) {
      showToast("Enter a Delivery ID or PO number.", "error");
      return;
    }
    apiFetch("/api/staff/deliveries/" + encodeURIComponent(parseDeliveryLookup(id)))
      .then(function (detail) {
        showDeliveryDetail(detail);
        showToast("Delivery details loaded. Review and confirm when ready.");
      })
      .catch(function (err) {
        resetDeliveryView();
        showToast(err.message || "Delivery not found.", "error");
      });
  }

  function setupDeliveryVerification() {
    var searchBtn = $("delivery-search-button");
    var cancelBtn = $("delivery-cancel");
    var form = $("delivery-verification");
    var idInput = $("delivery-id-input");

    if (searchBtn) {
      searchBtn.addEventListener("click", function () {
        loadDeliveryDetail(idInput && idInput.value);
      });
    }
    if (idInput) {
      idInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          loadDeliveryDetail(idInput.value);
        }
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        resetDeliveryView();
        stopQrScanner();
        if (idInput) idInput.value = "";
      });
    }
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!currentDelivery || currentDelivery.alreadyReceived) return;
        var decisionEl = form.querySelector('input[name="delivery-decision"]:checked');
        var payload = {
          poNumber: currentDelivery.poNumber,
          receivedQuantity: parseFloat($("received-quantity") && $("received-quantity").value) || 0,
          condition: $("delivery-condition") && $("delivery-condition").value,
          decision: decisionEl && decisionEl.value,
          rejectionReason: $("rejection-reason") && $("rejection-reason").value || ""
        };
        apiFetch("/api/staff/deliveries/confirm", { method: "POST", body: JSON.stringify(payload) })
          .then(function (result) {
            showToast(result.message || ("Delivery " + (result.deliveryStatus || "recorded") + " successfully."));
            resetDeliveryView();
            if (idInput) idInput.value = "";
            return refreshData();
          })
          .catch(function (err) {
            showToast(err.message || "Could not confirm delivery.", "error");
          });
      });
    }
  }

  function stopQrScanner() {
    var readerEl = $("staff-qr-reader");
    if (qrScannerStopping) return qrScannerStopping;

    if (!qrScanner) {
      if (readerEl) {
        readerEl.innerHTML = "";
        readerEl.hidden = true;
      }
      return Promise.resolve();
    }

    var scanner = qrScanner;
    qrScanner = null;
    qrScannerStopping = scanner.stop()
      .catch(function () { return null; })
      .then(function () { return scanner.clear().catch(function () { return null; }); })
      .then(function () {
        if (readerEl) {
          readerEl.innerHTML = "";
          readerEl.hidden = true;
        }
      })
      .finally(function () {
        qrScannerStopping = null;
      });
    return qrScannerStopping;
  }

  function startQrScanner() {
    if (typeof Html5Qrcode === "undefined") {
      showToast("QR scanner library is not loaded.", "error");
      return;
    }
    var readerEl = $("staff-qr-reader");
    if (!readerEl) return;

    stopQrScanner().then(function () {
      readerEl.hidden = false;
      readerEl.innerHTML = "";
      qrScanner = new Html5Qrcode("staff-qr-reader");
      return qrScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        function (decodedText) {
          stopQrScanner();
          var lookup = parseDeliveryLookup(decodedText);
          if ($("delivery-id-input")) $("delivery-id-input").value = lookup;
          loadDeliveryDetail(lookup);
        },
        function () { /* ignore scan errors */ }
      );
    }).catch(function () {
      showToast("Could not access camera. Use manual search instead.", "error");
      stopQrScanner();
    });
  }

  function setupQrScanner() {
    var openBtn = $("open-camera");
    if (openBtn) {
      openBtn.addEventListener("click", function () {
        if (qrScanner || qrScannerStopping) {
          stopQrScanner();
        } else {
          startQrScanner();
        }
      });
    }
  }

  function setupInventoryControls() {
    var search = $("inventory-search");
    var filter = $("inventory-status-filter");
    var prev = $("inventory-prev");
    var next = $("inventory-next");

    if (search) search.addEventListener("input", function () { inventoryPage = 1; renderInventoryList(); });
    if (filter) filter.addEventListener("change", function () { inventoryPage = 1; renderInventoryList(); });
    if (prev) prev.addEventListener("click", function () {
      if (inventoryPage > 1) {
        inventoryPage--;
        renderInventoryList();
      }
    });
    if (next) next.addEventListener("click", function () {
      var items = filteredInventory();
      var totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      if (inventoryPage < totalPages) {
        inventoryPage++;
        renderInventoryList();
      }
    });
  }

  function setupHistoryControls() {
    ["history-search", "history-filter", "history-sort"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("input", renderDeliveryHistory);
      if (el && el.tagName === "SELECT") el.addEventListener("change", renderDeliveryHistory);
    });
  }

  function downloadSpreadsheet(filename, headers, rows) {
    var lines = [headers.join("\t")].concat(rows.map(function (row) {
      return row.map(function (cell) { return String(cell == null ? "" : cell).replace(/\t/g, " "); }).join("\t");
    }));
    var blob = new Blob(["\ufeff" + lines.join("\n")], { type: "application/vnd.ms-excel;charset=utf-8" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  function downloadPdfReport(title, headers, rows, filename) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      showToast("PDF library is loading. Try again in a moment.", "error");
      return;
    }
    var doc = new window.jspdf.jsPDF();
    doc.setFontSize(14);
    doc.text(title, 14, 16);
    if (doc.autoTable) {
      doc.autoTable({ head: [headers], body: rows, startY: 22, styles: { fontSize: 9 } });
    }
    doc.save(filename);
  }

  function setupExportButtons() {
    document.querySelectorAll("[data-export]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-export") || "";
        if (kind === "inventory-excel") {
          downloadSpreadsheet(
            "inventory-report.xls",
            ["Item ID", "Item", "Stock", "Reorder Level", "Unit", "Status"],
            inventory.map(function (item) {
              return [item.id, item.name, item.stock, item.threshold, item.unit, getStockStatus(item)];
            })
          );
          showToast("Inventory Excel report downloaded.");
        } else if (kind === "inventory-pdf") {
          downloadPdfReport(
            "Inventory Report",
            ["Item ID", "Item", "Stock", "Reorder Level", "Status"],
            inventory.map(function (item) {
              return [item.id, item.name, item.stock, item.threshold, getStockStatus(item)];
            }),
            "inventory-report.pdf"
          );
        } else if (kind === "receiving-excel") {
          downloadSpreadsheet(
            "receiving-report.xls",
            ["Delivery ID", "Supplier", "PO", "Item", "Received Qty", "Status", "Date"],
            deliveries.map(function (d) {
              return [d.deliveryId, d.supplier, d.poNumber, d.itemName, d.receivedQuantity, d.status, d.dateReceived || d.date];
            })
          );
          showToast("Receiving Excel report downloaded.");
        } else if (kind === "receiving-pdf") {
          downloadPdfReport(
            "Receiving Report",
            ["Delivery", "Supplier", "PO", "Qty", "Status", "Date"],
            deliveries.map(function (d) {
              return [d.deliveryId, d.supplier, d.poNumber, d.receivedQuantity, d.status, d.dateReceived || d.date];
            }),
            "receiving-report.pdf"
          );
        }
      });
    });
  }

  var supportTickets = [];

  function loadSupportTickets() {
    return apiFetch("/api/support").then(function (data) {
      supportTickets = Array.isArray(data) ? data : [];
      renderSupportTickets();
      return supportTickets;
    }).catch(function () {
      supportTickets = [];
      renderSupportTickets();
      return supportTickets;
    });
  }

  function renderSupportTickets() {
    var list = $("staff-support-ticket-list");
    if (!list) return;
    if (!supportTickets.length) {
      list.innerHTML = emptyFeed("No support tickets submitted yet.");
      return;
    }
    list.innerHTML = supportTickets.map(function (ticket) {
      return feedItem(
        "ti-headset",
        ticket.subject + " · " + ticket.status,
        ticket.category + " · " + ticket.ticketId,
        ticket.date
      );
    }).join("");
  }

  function setupSupportForm() {
    var form = $("staff-support-form");
    var resetBtn = $("staff-support-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (form) form.reset();
      });
    }
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = {
        category: $("staff-support-category") && $("staff-support-category").value,
        subject: $("staff-support-subject") && $("staff-support-subject").value.trim(),
        message: $("staff-support-message") && $("staff-support-message").value.trim(),
      };
      apiFetch("/api/support", { method: "POST", body: JSON.stringify(payload) })
        .then(function () {
          showToast("Support request submitted.");
          form.reset();
          return loadSupportTickets();
        })
        .catch(function (err) {
          showToast(err.message || "Could not submit support request.", "error");
        });
    });
  }

  function setupRejectionReasonToggle() {
    var form = $("delivery-verification");
    if (!form) return;
    var reasonWrap = $("rejection-reason-wrap");
    form.querySelectorAll('input[name="delivery-decision"]').forEach(function (input) {
      input.addEventListener("change", function () {
        if (reasonWrap) reasonWrap.hidden = input.value !== "reject";
      });
    });
  }

  function init() {
    if (window.PortalProfile) window.PortalProfile.loadHeaderProfile();
    setupNavigation();
    setupNavGroups();
    setupMobileNav();
    setupAdjustmentForm();
    setupPurchaseRequestForm();
    setupDeliveryVerification();
    setupQrScanner();
    setupInventoryControls();
    setupHistoryControls();
    setupExportButtons();
    setupSupportForm();
    setupRejectionReasonToggle();
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
