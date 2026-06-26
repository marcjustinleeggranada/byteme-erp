(function () {
  "use strict";

  var PAGE_SIZE = 10;
  var SCREEN_META = {
    dashboard: { title: "Dashboard Overview", subtitle: "Procurement, inventory, and team oversight" },
    "inventory-list": { title: "Inventory Management", subtitle: "Monitor stock levels and reorder risk" },
    "purchase-requests": { title: "Purchase Requests", subtitle: "Review staff-submitted procurement requests" },
    "purchase-orders": { title: "Purchase Orders", subtitle: "Approve, reject, and create purchase orders" },
    "delivery-monitoring": { title: "Delivery Monitoring", subtitle: "Read-only delivery pipeline tracking" },
    "user-management": { title: "User Management", subtitle: "Create and maintain staff and supplier accounts" },
    "support-requests": { title: "Support Requests", subtitle: "Respond to staff and supplier support tickets" }
  };

  var dashboard = {};
  var inventory = [];
  var purchaseRequests = [];
  var purchaseOrders = [];
  var deliveries = [];
  var users = [];
  var support = [];
  var activity = [];
  var suppliers = [];
  var inventoryPage = 1;
  var toastTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }

  function formatQty(value, unit) {
    var num = Number(value);
    var text = Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, "");
    return unit ? text + " " + unit : text;
  }

  function formatCurrency(amount) {
    var num = Number(amount) || 0;
    return "₱" + num.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      rejected: "Rejected",
      delivered: "Delivered",
      partial: "Partial",
      open: "Open",
      "in progress": "In Progress",
      resolved: "Resolved",
      closed: "Closed"
    };
    return labels[String(status || "").toLowerCase()] || status;
  }

  function statusBadge(status, text) {
    var cls = String(status || "").toLowerCase().replace(/\s+/g, "-");
    if (cls === "out-of-stock") cls = "critical";
    if (cls === "approved" || cls === "accepted" || cls === "resolved" || cls === "closed") cls = "in-stock";
    if (cls === "pending" || cls === "open" || cls === "in-progress" || cls === "waiting-for-supplier") cls = "pending";
    if (cls === "rejected" || cls === "critical") cls = "rejected";
    return '<span class="staff-badge ' + escapeHtml(cls) + '">' + escapeHtml(text || statusLabel(status)) + "</span>";
  }

  function deliveryStatusBadge(status) {
    var normalized = String(status || "").toLowerCase();
    var cls = "pending";
    if (normalized.indexOf("deliver") !== -1 || normalized.indexOf("partial") !== -1) cls = "delivered";
    else if (normalized.indexOf("reject") !== -1) cls = "rejected";
    else if (normalized.indexOf("transit") !== -1) cls = "low-stock";
    return statusBadge(cls, status);
  }

  function getSupplierPrice(supplierName, itemName) {
    var supplier = suppliers.find(function (s) { return s.name === supplierName; });
    if (!supplier || !Array.isArray(supplier.catalog)) return 150;
    var entry = supplier.catalog.find(function (c) {
      return String(c.itemName || "").toLowerCase() === String(itemName || "").toLowerCase();
    });
    return entry ? Number(entry.price) || 150 : 150;
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

  function emptyRow(colspan, message) {
    return '<tr><td colspan="' + colspan + '" class="empty-state">' + escapeHtml(message) + "</td></tr>";
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = String(value);
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
    var meta = SCREEN_META[screen] || { title: "Manager Portal", subtitle: "" };
    if ($("staff-page-title")) $("staff-page-title").textContent = meta.title;
    if ($("staff-page-subtitle")) $("staff-page-subtitle").textContent = meta.subtitle;
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
    var menuBtn = $("staff-menu-button");
    var overlay = $("staff-sidebar-overlay");
    if (menuBtn) {
      menuBtn.addEventListener("click", function () {
        if (document.body.classList.contains("mobile-sidebar-open")) closeMobileSidebar();
        else openMobileSidebar();
      });
    }
    if (overlay) overlay.addEventListener("click", closeMobileSidebar);
  }

  function setupAvatar() {
    var avatar = $("manager-avatar");
    var username = document.body.getAttribute("data-username") || "MG";
    if (avatar) {
      var parts = username.split(/[\s._-]+/).filter(Boolean);
      var initials = parts.length >= 2
        ? (parts[0][0] + parts[1][0]).toUpperCase()
        : username.slice(0, 2).toUpperCase();
      avatar.textContent = initials;
    }
  }

  function loadDashboard() {
    return apiFetch("/api/dashboard/manager").then(function (data) {
      dashboard = data || {};
      return dashboard;
    });
  }

  function loadInventory() {
    return apiFetch("/api/inventory").then(function (data) {
      inventory = Array.isArray(data) ? data : [];
      return inventory;
    });
  }

  function loadPurchaseRequests() {
    return apiFetch("/api/purchase-requests").then(function (data) {
      purchaseRequests = Array.isArray(data) ? data : [];
      return purchaseRequests;
    });
  }

  function loadPurchaseOrders() {
    return apiFetch("/api/purchase-orders").then(function (data) {
      purchaseOrders = Array.isArray(data) ? data : [];
      return purchaseOrders;
    });
  }

  function loadDeliveries() {
    return apiFetch("/api/deliveries").then(function (data) {
      deliveries = Array.isArray(data) ? data : [];
      return deliveries;
    });
  }

  function loadUsers() {
    return apiFetch("/api/users").then(function (data) {
      users = Array.isArray(data) ? data : [];
      return users;
    });
  }

  function loadSupport() {
    return apiFetch("/api/support").then(function (data) {
      support = Array.isArray(data) ? data : [];
      return support;
    });
  }

  function loadSuppliers() {
    return apiFetch("/api/suppliers").then(function (data) {
      suppliers = Array.isArray(data) ? data : [];
      return suppliers;
    });
  }

  function loadActivity() {
    return fetch("/api/activity", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) return [];
        return res.json();
      })
      .then(function (data) {
        activity = Array.isArray(data) ? data : [];
        return activity;
      })
      .catch(function () {
        activity = [];
        return activity;
      });
  }

  function renderDashboard() {
    setText("kpi-total-inventory", dashboard.totalInventory || 0);
    setText("kpi-low-stock", dashboard.lowStock || 0);
    setText("kpi-pending-pr", dashboard.pendingPurchaseRequests || 0);
    setText("kpi-pending-po", dashboard.pendingPurchaseOrders || 0);
    setText("kpi-active-suppliers", dashboard.activeSuppliers || 0);
    setText("kpi-pending-deliveries", dashboard.pendingDeliveries || 0);
    setText("kpi-completed-deliveries", dashboard.completedDeliveries || 0);
    setText("kpi-open-support", dashboard.openSupportTickets || 0);

    var prSummary = dashboard.purchaseRequestSummary || {};
    setText("dash-pr-pending", prSummary.pending || 0);
    setText("dash-pr-approved", prSummary.approved || 0);
    setText("dash-pr-rejected", prSummary.rejected || 0);

    var poSummary = dashboard.purchaseOrderSummary || {};
    setText("dash-po-waiting", poSummary.waiting || 0);
    setText("dash-po-accepted", poSummary.accepted || 0);
    setText("dash-po-rejected", poSummary.rejected || 0);
    setText("dash-po-completed", poSummary.completed || 0);

    setText("dash-del-pending", dashboard.pendingDeliveries || 0);
    setText("dash-del-completed", dashboard.completedDeliveries || 0);

    var activityBody = $("dashboard-activity-tbody");
    if (activityBody) {
      if (!activity.length) {
        activityBody.innerHTML = emptyRow(4, "No recent activity to display.");
      } else {
        activityBody.innerHTML = activity.slice(0, 10).map(function (log) {
          return (
            "<tr>" +
            "<td>" + escapeHtml(log.event) + "</td>" +
            "<td>" + escapeHtml(log.item || log.reference || "—") + "</td>" +
            "<td>" + statusBadge(log.status) + "</td>" +
            "<td>" + escapeHtml(log.time || "—") + "</td>" +
            "</tr>"
          );
        }).join("");
      }
    }

    var lowItems = inventory.filter(function (item) {
      var status = getStockStatus(item);
      return status === "low-stock" || status === "critical";
    });
    var outItems = inventory.filter(function (item) {
      return getStockStatus(item) === "out-of-stock";
    });

    var lowList = $("dashboard-low-stock-list");
    if (lowList) {
      if (!lowItems.length) {
        lowList.innerHTML = emptyFeed("No low stock items.");
      } else {
        lowList.innerHTML = lowItems.slice(0, 6).map(function (item) {
          return (
            '<div class="mini-list-item">' +
            "<strong>" + escapeHtml(item.name) + "</strong>" +
            "<span>" + escapeHtml(formatQty(item.stock, item.unit)) + "</span>" +
            "</div>"
          );
        }).join("");
      }
    }

    var outList = $("dashboard-out-stock-list");
    if (outList) {
      if (!outItems.length) {
        outList.innerHTML = emptyFeed("No out-of-stock items.");
      } else {
        outList.innerHTML = outItems.slice(0, 6).map(function (item) {
          return (
            '<div class="mini-list-item">' +
            "<strong>" + escapeHtml(item.name) + "</strong>" +
            "<span>0 " + escapeHtml(item.unit || "") + "</span>" +
            "</div>"
          );
        }).join("");
      }
    }

    var deliveryFeed = $("dashboard-delivery-feed");
    if (deliveryFeed) {
      var pendingDeliveries = deliveries.filter(function (d) {
        var s = String(d.status || "").toLowerCase();
        return s.indexOf("transit") !== -1 || s.indexOf("preparation") !== -1 || s.indexOf("pending") !== -1;
      });
      if (!pendingDeliveries.length) {
        deliveryFeed.innerHTML = emptyFeed("No pending deliveries in the pipeline.");
      } else {
        deliveryFeed.innerHTML = pendingDeliveries.slice(0, 4).map(function (d) {
          return feedItem("ti-truck-delivery", d.id + " · " + d.supplier, "PO " + d.poNumber + " · " + d.status, d.date);
        }).join("");
      }
    }

    var supportFeed = $("dashboard-support-feed");
    if (supportFeed) {
      var openTickets = support.filter(function (t) {
        return t.status === "Open" || t.status === "In Progress";
      });
      if (!openTickets.length) {
        supportFeed.innerHTML = emptyFeed("No open support tickets.");
      } else {
        supportFeed.innerHTML = openTickets.slice(0, 5).map(function (t) {
          return feedItem("ti-lifebuoy", t.ticketId + " · " + t.subject, t.username + " · " + t.category, t.date);
        }).join("");
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
    var tbody = $("manager-inventory-tbody");
    if (!tbody) return;
    var items = filteredInventory();
    var totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (inventoryPage > totalPages) inventoryPage = totalPages;
    if (inventoryPage < 1) inventoryPage = 1;
    var start = (inventoryPage - 1) * PAGE_SIZE;
    var pageItems = items.slice(start, start + PAGE_SIZE);

    if (!pageItems.length) {
      tbody.innerHTML = emptyRow(7, "No inventory items match your filters.");
    } else {
      tbody.innerHTML = pageItems.map(function (item) {
        var status = getStockStatus(item);
        return (
          "<tr>" +
          "<td>#" + escapeHtml(item.id) + "</td>" +
          "<td>" + escapeHtml(item.name) + "</td>" +
          "<td>" + escapeHtml(item.supplier || "—") + "</td>" +
          "<td>" + escapeHtml(formatQty(item.stock)) + "</td>" +
          "<td>" + escapeHtml(formatQty(item.threshold)) + "</td>" +
          "<td>" + escapeHtml(item.unit || "—") + "</td>" +
          "<td>" + statusBadge(status) + "</td>" +
          "</tr>"
        );
      }).join("");
    }

    if ($("inventory-page-info")) {
      $("inventory-page-info").textContent = "Page " + inventoryPage + " of " + totalPages + " (" + items.length + " items)";
    }
    if ($("inventory-prev")) $("inventory-prev").disabled = inventoryPage <= 1;
    if ($("inventory-next")) $("inventory-next").disabled = inventoryPage >= totalPages;
  }

  function renderPurchaseRequests() {
    var tbody = $("purchase-requests-tbody");
    if (!tbody) return;
    if (!purchaseRequests.length) {
      tbody.innerHTML = emptyRow(8, "No purchase requests submitted yet.");
      return;
    }
    tbody.innerHTML = purchaseRequests.map(function (req) {
      var actions = req.status === "Pending"
        ? (
          '<div class="staff-table-actions">' +
          '<button type="button" class="staff-btn primary compact" data-pr-action="approve" data-pr-id="' + escapeAttr(req.id) + '"><i class="ti ti-check"></i> Approve</button>' +
          '<button type="button" class="staff-btn danger compact" data-pr-action="reject" data-pr-id="' + escapeAttr(req.id) + '"><i class="ti ti-x"></i> Reject</button>' +
          "</div>"
        )
        : '<span style="color:var(--muted);font-size:9px">—</span>';
      return (
        "<tr>" +
        "<td>" + escapeHtml(req.id) + "</td>" +
        "<td>" + escapeHtml(req.itemName) + "</td>" +
        "<td>" + escapeHtml(formatQty(req.qty, req.unit)) + "</td>" +
        "<td>" + escapeHtml(req.requestedBy || "—") + "</td>" +
        "<td>" + escapeHtml(req.reason || "—") + "</td>" +
        "<td>" + escapeHtml(req.date || "—") + "</td>" +
        "<td>" + statusBadge(req.status) + "</td>" +
        "<td>" + actions + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function populateManualPoSelect() {
    var select = $("manual-po-item");
    if (!select) return;
    var current = select.value;
    select.innerHTML = '<option value="">Select ingredient…</option>' + inventory.map(function (item) {
      return (
        '<option value="' + escapeAttr(item.name) + '" data-supplier="' + escapeAttr(item.supplier || "") + '" data-unit="' + escapeAttr(item.unit || "pcs") + '">' +
        escapeHtml(item.name) +
        "</option>"
      );
    }).join("");
    if (current) select.value = current;
    syncManualSupplierLabel();
  }

  function syncManualSupplierLabel() {
    var select = $("manual-po-item");
    var hint = $("manual-po-supplier-hint");
    if (!select || !hint) return;
    var option = select.options[select.selectedIndex];
    var supplier = option ? option.getAttribute("data-supplier") : "";
    hint.textContent = "Supplier: " + (supplier || "—");
  }

  function renderPurchaseOrders() {
    populateManualPoSelect();
    var tbody = $("purchase-orders-tbody");
    if (!tbody) return;
    var orders = purchaseOrders.slice().sort(function (a, b) {
      return String(b.id).localeCompare(String(a.id));
    });
    if (!orders.length) {
      tbody.innerHTML = emptyRow(9, "No purchase orders in the pipeline.");
      return;
    }
    tbody.innerHTML = orders.map(function (po) {
      var actions = po.status === "Awaiting approval"
        ? (
          '<div class="staff-table-actions">' +
          '<button type="button" class="staff-btn primary compact" data-po-action="approve" data-po-id="' + escapeAttr(po.id) + '"><i class="ti ti-check"></i> Approve</button>' +
          '<button type="button" class="staff-btn danger compact" data-po-action="reject" data-po-id="' + escapeAttr(po.id) + '"><i class="ti ti-x"></i> Reject</button>' +
          "</div>"
        )
        : '<span style="color:var(--muted);font-size:9px">—</span>';
      return (
        "<tr>" +
        "<td>" + escapeHtml(po.id) + "</td>" +
        "<td>" + escapeHtml(po.itemName) + "</td>" +
        "<td>" + escapeHtml(formatQty(po.qty, po.unit)) + "</td>" +
        "<td>" + escapeHtml(po.supplier || "—") + "</td>" +
        "<td>" + escapeHtml(po.type || "—") + "</td>" +
        "<td>" + escapeHtml(formatCurrency(po.total)) + "</td>" +
        "<td>" + statusBadge(po.status) + "</td>" +
        "<td>" + escapeHtml(po.date || "—") + "</td>" +
        "<td>" + actions + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderDeliveries() {
    var tbody = $("delivery-monitoring-tbody");
    if (!tbody) return;
    if (!deliveries.length) {
      tbody.innerHTML = emptyRow(6, "No deliveries to monitor yet.");
      return;
    }
    tbody.innerHTML = deliveries.map(function (d) {
      return (
        "<tr>" +
        "<td>" + escapeHtml(d.id) + "</td>" +
        "<td>" + escapeHtml(d.supplier) + "</td>" +
        "<td>" + escapeHtml(d.poNumber) + "</td>" +
        "<td>" + deliveryStatusBadge(d.status) + "</td>" +
        "<td>" + escapeHtml(d.date) + "</td>" +
        "<td>" + escapeHtml(d.receivedBy || "—") + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderUsers() {
    var tbody = $("user-management-tbody");
    if (!tbody) return;

    var staffCount = users.filter(function (u) { return u.role === "staff" && !u.disabled; }).length;
    var supplierCount = users.filter(function (u) { return u.role === "supplier" && !u.disabled; }).length;
    var disabledCount = users.filter(function (u) { return u.disabled; }).length;

    setText("staff-user-count", staffCount);
    setText("supplier-user-count", supplierCount);
    setText("disabled-user-count", disabledCount);

    if (!users.length) {
      tbody.innerHTML = emptyRow(4, "No managed accounts yet.");
      return;
    }

    tbody.innerHTML = users.map(function (user) {
      var roleLabel = user.role === "supplier" ? "Supplier" : "Inventory Staff";
      var statusBadgeHtml = user.disabled ? statusBadge("rejected", "Disabled") : statusBadge("in-stock", "Active");
      return (
        "<tr>" +
        "<td><strong>" + escapeHtml(user.username) + "</strong></td>" +
        "<td>" + escapeHtml(roleLabel) + "</td>" +
        "<td>" + statusBadgeHtml + "</td>" +
        '<td><div class="staff-table-actions">' +
        '<button type="button" class="staff-btn secondary compact" data-user-action="edit" data-user-id="' + user.id + '"><i class="ti ti-edit"></i> Edit</button>' +
        '<button type="button" class="staff-btn secondary compact" data-user-action="reset" data-user-id="' + user.id + '"><i class="ti ti-key"></i> Reset</button>' +
        '<button type="button" class="staff-btn ' + (user.disabled ? "primary" : "danger") + ' compact" data-user-action="toggle" data-user-id="' + user.id + '">' +
        '<i class="ti ti-power"></i> ' + (user.disabled ? "Enable" : "Disable") +
        "</button></div></td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderSupport() {
    var tbody = $("support-requests-tbody");
    if (!tbody) return;
    if (!support.length) {
      tbody.innerHTML = emptyRow(8, "No support requests submitted yet.");
      return;
    }
    tbody.innerHTML = support.map(function (ticket) {
      var statusSelect =
        '<select class="support-status-select" data-support-id="' + ticket.id + '" style="padding:6px 8px;border:1px solid var(--line);border-radius:7px;font-size:10px">' +
        ["Open", "In Progress", "Resolved", "Closed"].map(function (status) {
          return '<option value="' + status + '"' + (ticket.status === status ? " selected" : "") + ">" + status + "</option>";
        }).join("") +
        "</select>";
      return (
        "<tr>" +
        "<td>" + escapeHtml(ticket.ticketId) + "</td>" +
        "<td>" + escapeHtml(ticket.username) + "</td>" +
        "<td>" + escapeHtml(ticket.role) + "</td>" +
        "<td>" + escapeHtml(ticket.category) + "</td>" +
        "<td>" + escapeHtml(ticket.subject) + "</td>" +
        "<td>" + escapeHtml(ticket.date) + "</td>" +
        "<td>" + statusBadge(ticket.status) + "</td>" +
        "<td>" + statusSelect + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderAll() {
    renderDashboard();
    renderInventoryList();
    renderPurchaseRequests();
    renderPurchaseOrders();
    renderDeliveries();
    renderUsers();
    renderSupport();
  }

  function refreshData() {
    return Promise.all([
      loadDashboard(),
      loadInventory(),
      loadPurchaseRequests(),
      loadPurchaseOrders(),
      loadDeliveries(),
      loadUsers(),
      loadSupport(),
      loadSuppliers(),
      loadActivity()
    ]).then(function () {
      renderAll();
    }).catch(function (err) {
      showToast(err.message || "Failed to load portal data.", "error");
    });
  }

  function reviewPurchaseRequest(id, action) {
    var note = "";
    if (action === "reject") {
      note = prompt("Optional rejection note:") || "";
    }
    apiFetch("/api/purchase-requests/review", {
      method: "POST",
      body: JSON.stringify({ id: id, action: action, note: note })
    }).then(function () {
      showToast("Purchase request " + (action === "approve" ? "approved" : "rejected") + ".");
      return refreshData();
    }).catch(function (err) {
      showToast(err.message, "error");
    });
  }

  function approvePurchaseOrder(id) {
    apiFetch("/api/purchase-orders/approve", {
      method: "POST",
      body: JSON.stringify({ id: id })
    }).then(function () {
      showToast("Purchase order approved and sent to supplier.");
      return refreshData();
    }).catch(function (err) {
      showToast(err.message, "error");
    });
  }

  function rejectPurchaseOrder(id) {
    apiFetch("/api/purchase-orders/reject", {
      method: "POST",
      body: JSON.stringify({ id: id })
    }).then(function () {
      showToast("Purchase order rejected.");
      return refreshData();
    }).catch(function (err) {
      showToast(err.message, "error");
    });
  }

  function submitManualPO() {
    var select = $("manual-po-item");
    var qtyInput = $("manual-po-qty");
    if (!select || !qtyInput) return;

    var itemName = select.value;
    var qty = Number(qtyInput.value);
    var option = select.options[select.selectedIndex];
    var supplier = option ? option.getAttribute("data-supplier") || "Default Supplier" : "Default Supplier";
    var unit = option ? option.getAttribute("data-unit") || "pcs" : "pcs";

    if (!itemName) {
      showToast("Select an ingredient for the purchase order.", "error");
      return;
    }
    if (!qty || qty <= 0) {
      showToast("Enter a valid order quantity.", "error");
      return;
    }

    var price = getSupplierPrice(supplier, itemName);
    var poId = "PO-" + Date.now();

    apiFetch("/api/purchase-orders/create", {
      method: "POST",
      body: JSON.stringify({
        id: poId,
        itemName: itemName,
        qty: qty,
        unit: unit,
        supplier: supplier,
        total: qty * price,
        type: "Manual Request"
      })
    }).then(function () {
      qtyInput.value = "";
      showToast("Manual purchase order queued for approval.");
      return refreshData();
    }).catch(function (err) {
      showToast(err.message, "error");
    });
  }

  function openUserModal(role) {
    var modal = $("user-modal");
    if (!modal) return;
    $("managed-user-id").value = "";
    $("managed-username").value = "";
    $("managed-password").value = "";
    $("managed-user-role").value = role || "staff";
    $("managed-password-group").style.display = "block";
    $("user-modal-title").textContent = role === "supplier" ? "Create Supplier Account" : "Create Inventory Staff Account";
    modal.hidden = false;
  }

  function closeUserModal() {
    var modal = $("user-modal");
    if (modal) modal.hidden = true;
  }

  function editUser(userId) {
    var user = users.find(function (u) { return u.id === userId; });
    if (!user) return;
    $("managed-user-id").value = user.id;
    $("managed-username").value = user.username;
    $("managed-user-role").value = user.role;
    $("managed-password").value = "";
    $("managed-password-group").style.display = "none";
    $("user-modal-title").textContent = "Edit Account";
    $("user-modal").hidden = false;
  }

  function saveManagedUser() {
    var id = ($("managed-user-id") && $("managed-user-id").value) || "";
    var username = ($("managed-username") && $("managed-username").value.trim()) || "";
    var role = ($("managed-user-role") && $("managed-user-role").value) || "staff";
    var password = ($("managed-password") && $("managed-password").value) || "";
    var payload = { username: username, role: role };
    if (id) payload.id = Number(id);
    if (!id) payload.password = password;

    if (!username) {
      showToast("Enter a username.", "error");
      return;
    }
    if (!id && !password) {
      showToast("Enter a temporary password.", "error");
      return;
    }

    apiFetch("/api/users/save", { method: "POST", body: JSON.stringify(payload) })
      .then(function () {
        closeUserModal();
        showToast(id ? "Account updated." : "Account created.");
        return refreshData();
      })
      .catch(function (err) {
        showToast(err.message, "error");
      });
  }

  function resetUserPassword(userId) {
    var password = prompt("Enter a new temporary password:");
    if (!password) return;
    apiFetch("/api/users/reset-password", { method: "POST", body: JSON.stringify({ id: userId, password: password }) })
      .then(function () {
        showToast("Password reset successfully.");
      })
      .catch(function (err) {
        showToast(err.message, "error");
      });
  }

  function toggleUserDisabled(userId) {
    apiFetch("/api/users/toggle-disabled", { method: "POST", body: JSON.stringify({ id: userId }) })
      .then(function () {
        showToast("Account status updated.");
        return refreshData();
      })
      .catch(function (err) {
        showToast(err.message, "error");
      });
  }

  function updateSupportStatus(id, status) {
    apiFetch("/api/support/update", { method: "POST", body: JSON.stringify({ id: id, status: status }) })
      .then(function () {
        showToast("Support ticket updated.");
        return refreshData();
      })
      .catch(function (err) {
        showToast(err.message, "error");
      });
  }

  function setupInventoryControls() {
    var search = $("inventory-search");
    var filter = $("inventory-status-filter");
    var prev = $("inventory-prev");
    var next = $("inventory-next");

    if (search) search.addEventListener("input", function () { inventoryPage = 1; renderInventoryList(); });
    if (filter) filter.addEventListener("change", function () { inventoryPage = 1; renderInventoryList(); });
    if (prev) prev.addEventListener("click", function () { if (inventoryPage > 1) { inventoryPage--; renderInventoryList(); } });
    if (next) next.addEventListener("click", function () { inventoryPage++; renderInventoryList(); });
  }

  function setupManualPoForm() {
    var select = $("manual-po-item");
    var submit = $("manual-po-submit");
    if (select) select.addEventListener("change", syncManualSupplierLabel);
    if (submit) submit.addEventListener("click", submitManualPO);
  }

  function setupUserModal() {
    var createStaff = $("btn-create-staff");
    var createSupplier = $("btn-create-supplier");
    var closeBtn = $("user-modal-close");
    var cancelBtn = $("user-modal-cancel");
    var saveBtn = $("user-modal-save");
    var modal = $("user-modal");

    if (createStaff) createStaff.addEventListener("click", function () { openUserModal("staff"); });
    if (createSupplier) createSupplier.addEventListener("click", function () { openUserModal("supplier"); });
    if (closeBtn) closeBtn.addEventListener("click", closeUserModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeUserModal);
    if (saveBtn) saveBtn.addEventListener("click", saveManagedUser);
    if (modal) {
      modal.addEventListener("click", function (event) {
        if (event.target === modal) closeUserModal();
      });
    }
  }

  function setupDelegatedActions() {
    document.addEventListener("click", function (event) {
      var prBtn = event.target.closest("[data-pr-action]");
      if (prBtn) {
        reviewPurchaseRequest(prBtn.getAttribute("data-pr-id"), prBtn.getAttribute("data-pr-action"));
        return;
      }

      var poBtn = event.target.closest("[data-po-action]");
      if (poBtn) {
        var poAction = poBtn.getAttribute("data-po-action");
        var poId = poBtn.getAttribute("data-po-id");
        if (poAction === "approve") approvePurchaseOrder(poId);
        else rejectPurchaseOrder(poId);
        return;
      }

      var userBtn = event.target.closest("[data-user-action]");
      if (userBtn) {
        var userAction = userBtn.getAttribute("data-user-action");
        var userId = Number(userBtn.getAttribute("data-user-id"));
        if (userAction === "edit") editUser(userId);
        else if (userAction === "reset") resetUserPassword(userId);
        else if (userAction === "toggle") toggleUserDisabled(userId);
      }
    });

    document.addEventListener("change", function (event) {
      var select = event.target.closest(".support-status-select");
      if (select) {
        updateSupportStatus(Number(select.getAttribute("data-support-id")), select.value);
      }
    });
  }

  function init() {
    setupAvatar();
    setupNavigation();
    setupNavGroups();
    setupMobileNav();
    setupInventoryControls();
    setupManualPoForm();
    setupUserModal();
    setupDelegatedActions();
    refreshData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
