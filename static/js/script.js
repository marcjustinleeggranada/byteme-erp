(function () {
  "use strict";

  const state = {
    inventory: [],
    purchaseOrders: [],
    deliveries: [],
    suppliers: [],
    activity: [],
    users: [],
    pendingCatalogItems: [],
    catalogSelections: {},
    qrScanner: null,
    qrScanning: false
  };

  const SCREEN_TITLES = {
    dashboard: "Dashboard Overview",
    inventory: "Inventory Monitoring",
    "purchase-orders": "Purchase Orders",
    "delivery-monitoring": "Delivery Monitoring",
    "delivery-check": "Delivery Check",
    suppliers: "Suppliers",
    reports: "Procurement Reports",
    "user-management": "User Management"
  };

  const isManager =
    document.body.dataset.manager === "true" ||
    !!document.getElementById("screen-purchase-orders");

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatCurrency(amount) {
    const num = Number(amount) || 0;
    return "₱" + num.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function showToast(message) {
    const toast = $("toast");
    const msg = $("toast-msg");
    if (!toast || !msg) return;
    msg.textContent = message;
    toast.style.display = "flex";
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      toast.style.display = "none";
    }, 3200);
  }

  async function apiGet(url) {
    const response = await fetch(url, { credentials: "same-origin" });
    const data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }
    return data;
  }

  async function apiPost(url, body) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }
    return data;
  }

  function getSupplierPrice(supplierName, itemName) {
    const supplier = state.suppliers.find(function (s) {
      return s.name === supplierName;
    });
    if (!supplier || !Array.isArray(supplier.catalog)) return 150;
    const entry = supplier.catalog.find(function (c) {
      return String(c.itemName || "").toLowerCase() === String(itemName || "").toLowerCase();
    });
    return entry ? Number(entry.price) || 150 : 150;
  }

  function stockLevel(item) {
    const stock = Number(item.stock) || 0;
    const threshold = Number(item.threshold) || 0;
    if (threshold <= 0) return { label: "OK", pill: "pill-ok", percent: 100 };
    const ratio = Math.min(100, Math.round((stock / Math.max(threshold * 2, 1)) * 100));
    if (stock <= threshold) return { label: "Low", pill: "pill-low", percent: Math.max(ratio, 8) };
    return { label: "OK", pill: "pill-ok", percent: ratio };
  }

  function poStatusPill(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized.includes("awaiting")) return "pill-pending";
    if (normalized.includes("transmit") || normalized.includes("approv")) return "pill-approved";
    if (normalized.includes("reject")) return "pill-low";
    return "pill-warn";
  }

  function deliveryStatusClass(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized.includes("transit")) return "delivery-in-transit";
    if (normalized.includes("deliver") || normalized.includes("verified")) return "delivery-delivered";
    if (normalized.includes("reject")) return "delivery-rejected";
    if (normalized.includes("arriv") || normalized.includes("partial")) return "delivery-arrived";
    return "delivery-preparation";
  }

  function isMobileViewport() {
    return window.matchMedia("(max-width: 1024px)").matches;
  }

  function getAppRoot() {
    return document.querySelector(".app") || document.body;
  }

  async function loadAllData() {
    const requests = [
      apiGet("/api/inventory").then(function (data) {
        state.inventory = data;
      }),
      apiGet("/api/purchase-orders").then(function (data) {
        state.purchaseOrders = data;
      }),
      apiGet("/api/activity").then(function (data) {
        state.activity = data;
      }),
      apiGet("/api/suppliers").then(function (data) {
        state.suppliers = data;
      })
    ];

    if (isManager) {
      requests.push(
        apiGet("/api/deliveries").then(function (data) {
          state.deliveries = data;
        }),
        apiGet("/api/users").then(function (data) {
          state.users = data;
        })
      );
    }

    await Promise.all(requests);
  }

  function renderDashboard() {
    const lowItems = state.inventory.filter(function (item) {
      return Number(item.stock) <= Number(item.threshold);
    });
    const pendingPos = state.purchaseOrders.filter(function (po) {
      return po.status === "Awaiting approval";
    });
    const inTransit = state.deliveries.filter(function (delivery) {
      return delivery.status === "In Transit";
    });

    setText("dash-items-count", state.inventory.length);
    setText("dash-low-count", lowItems.length);
    setText("dash-po-count", pendingPos.length);
    setText("dash-delivery-count", inTransit.length);
    setText("topbar-alert-count", lowItems.length + pendingPos.length);
    setText("nav-low-badge", lowItems.length);
    setText("nav-po-badge", pendingPos.length);

    const alertBox = $("dashboard-auto-alert");
    const alertText = $("dashboard-alert-text");
    if (alertBox) {
      const autoPending = pendingPos.filter(function (po) {
        return po.type === "Auto-Generated";
      });
      if (autoPending.length) {
        alertBox.style.display = "flex";
        if (alertText) {
          alertText.textContent =
            autoPending.length +
            " auto-draft PO" +
            (autoPending.length > 1 ? "s" : "") +
            " generated — awaiting approval.";
        }
      } else if (pendingPos.length) {
        alertBox.style.display = "flex";
        if (alertText) {
          alertText.textContent = pendingPos.length + " purchase order(s) awaiting approval.";
        }
      } else {
        alertBox.style.display = "none";
      }
    }

    renderActivityLog();
    renderNotifications();
  }

  function renderActivityLog() {
    const tbody = $("activity-log-tbody");
    if (!tbody) return;
    if (!state.activity.length) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="color:var(--brand-muted);">No activity recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = state.activity
      .slice(0, 12)
      .map(function (log) {
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(log.event) +
          "</td>" +
          "<td>" +
          escapeHtml(log.item || log.reference || "—") +
          "</td>" +
          '<td><span class="pill ' +
          poStatusPill(log.status) +
          '">' +
          escapeHtml(log.status || "—") +
          "</span></td>" +
          "<td>" +
          escapeHtml(log.time || "—") +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderInventory() {
    const tbody = $("inventory-table-body");
    if (!tbody) return;

    setText("inv-metrics-total", state.inventory.length);
    const lowCount = state.inventory.filter(function (item) {
      return Number(item.stock) <= Number(item.threshold);
    }).length;
    setText("inv-metrics-low", lowCount);
    setText("inv-metrics-time", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

    if (!state.inventory.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="color:var(--brand-muted);">No inventory items tracked.</td></tr>';
      return;
    }

    tbody.innerHTML = state.inventory
      .map(function (item) {
        const level = stockLevel(item);
        const unit = escapeHtml(item.unit || "pcs");
        let row =
          "<tr>" +
          "<td><strong>" +
          escapeHtml(item.name) +
          "</strong></td>" +
          "<td>" +
          escapeHtml(item.stock) +
          " " +
          unit +
          "</td>" +
          "<td>" +
          escapeHtml(item.threshold) +
          " " +
          unit +
          "</td>" +
          '<td><span class="pill ' +
          level.pill +
          '">' +
          level.label +
          '</span><div class="progress-bar" style="margin-top:8px;"><div class="progress-fill" style="width:' +
          level.percent +
          "%; background:" +
          (level.label === "Low" ? "#a32d2d" : "#3b6d11") +
          ';"></div></div></td>';

        if (!isManager) {
          row +=
            '<td><button class="btn btn-xs" onclick="window.adjustStock(' +
            item.id +
            ')"><i class="ti ti-edit"></i> Adjust</button></td>';
        }

        row += "</tr>";
        return row;
      })
      .join("");

    populateManualPoSelect();
    populateStaffSupplierSelect();
  }

  function populateManualPoSelect() {
    const select = $("manual-po-item");
    if (!select) return;
    const current = select.value;
    select.innerHTML =
      '<option value="">Select ingredient…</option>' +
      state.inventory
        .map(function (item) {
          return (
            '<option value="' +
            escapeHtml(item.name) +
            '" data-supplier="' +
            escapeHtml(item.supplier || "") +
            '" data-unit="' +
            escapeHtml(item.unit || "pcs") +
            '">' +
            escapeHtml(item.name) +
            "</option>"
          );
        })
        .join("");
    if (current) select.value = current;
    syncManualSupplierLabel();
  }

  function populateStaffSupplierSelect() {
    const select = $("new-item-supplier");
    if (!select) return;
    select.innerHTML = state.suppliers
      .map(function (supplier) {
        return '<option value="' + escapeHtml(supplier.name) + '">' + escapeHtml(supplier.name) + "</option>";
      })
      .join("");
  }

  function renderPurchaseOrders() {
    const container = $("po-list-container");
    if (!container) return;

    const orders = state.purchaseOrders.slice().sort(function (a, b) {
      return String(b.id).localeCompare(String(a.id));
    });

    if (!orders.length) {
      container.innerHTML =
        '<div class="card"><span style="color:var(--brand-muted);font-size:13px;">No purchase orders in the pipeline.</span></div>';
      return;
    }

    container.innerHTML = orders
      .map(function (po) {
        const typePill =
          po.type === "Auto-Generated"
            ? '<span class="pill pill-auto">Auto-Generated</span>'
            : '<span class="pill pill-manual">Manual Request</span>';
        const actions =
          po.status === "Awaiting approval"
            ? '<div class="po-actions">' +
              '<button class="btn btn-primary btn-xs" onclick="window.approvePO(\'' +
              escapeHtml(po.id) +
              '\')"><i class="ti ti-check"></i> Approve</button>' +
              '<button class="btn btn-danger btn-xs" onclick="window.rejectPO(\'' +
              escapeHtml(po.id) +
              '\')"><i class="ti ti-x"></i> Reject</button>' +
              "</div>"
            : '<div class="po-actions"><span class="pill ' +
              poStatusPill(po.status) +
              '">' +
              escapeHtml(po.status) +
              "</span></div>";

        return (
          '<div class="card">' +
          '<div class="po-header">' +
          "<div>" +
          '<div class="po-id">' +
          escapeHtml(po.id) +
          "</div>" +
          '<div class="po-date">' +
          escapeHtml(po.date || "—") +
          "</div>" +
          '<div class="po-meta-badges">' +
          typePill +
          '<span class="pill ' +
          poStatusPill(po.status) +
          '">' +
          escapeHtml(po.status) +
          "</span></div>" +
          "</div>" +
          '<div style="font-weight:600;">' +
          formatCurrency(po.total) +
          "</div>" +
          "</div>" +
          '<div class="po-items">' +
          escapeHtml(po.qty) +
          " " +
          escapeHtml(po.unit || "pcs") +
          " × " +
          escapeHtml(po.itemName) +
          " · Supplier: " +
          escapeHtml(po.supplier || "Unassigned") +
          "</div>" +
          actions +
          "</div>"
        );
      })
      .join("");
  }

  function renderDeliveries() {
    const tbody = $("delivery-monitoring-tbody");
    if (!tbody) return;

    if (!state.deliveries.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="color:var(--brand-muted);">No deliveries to monitor yet.</td></tr>';
      return;
    }

    tbody.innerHTML = state.deliveries
      .map(function (delivery) {
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(delivery.id) +
          "</td>" +
          "<td>" +
          escapeHtml(delivery.supplier) +
          "</td>" +
          "<td>" +
          escapeHtml(delivery.poNumber) +
          "</td>" +
          '<td><span class="delivery-status ' +
          deliveryStatusClass(delivery.status) +
          '">' +
          escapeHtml(delivery.status) +
          "</span></td>" +
          "<td>" +
          escapeHtml(delivery.date) +
          "</td>" +
          "<td>" +
          escapeHtml(delivery.receivedBy || "—") +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderNotifications() {
    if (!isManager) return;
    const inTransit = state.deliveries.filter(function (delivery) {
      return delivery.status === "In Transit";
    });
    const countEl = $("notification-count");
    const listEl = $("notification-list");

    if (countEl) {
      countEl.textContent = String(inTransit.length);
      countEl.style.display = inTransit.length ? "inline-flex" : "none";
    }

    if (!listEl) return;
    if (!inTransit.length) {
      listEl.innerHTML = '<div class="notification-empty">No deliveries in transit right now.</div>';
      return;
    }

    listEl.innerHTML = inTransit
      .map(function (delivery) {
        return (
          '<div class="notification-item">' +
          "<strong>" +
          escapeHtml(delivery.id) +
          " · " +
          escapeHtml(delivery.supplier) +
          "</strong>" +
          "<span>PO " +
          escapeHtml(delivery.poNumber) +
          " is in transit.</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderSuppliersList() {
    const container = $("suppliers-list-container");
    if (!container) return;

    if (!state.suppliers.length) {
      container.innerHTML =
        '<span style="color:var(--brand-muted);font-size:13px;">No suppliers registered yet.</span>';
      return;
    }

    const colors = ["#1e3d30", "#28633f", "#185fa5", "#854f0b", "#993c1d"];
    container.innerHTML = state.suppliers
      .map(function (supplier, index) {
        const initials = supplier.name
          .split(" ")
          .map(function (part) {
            return part.charAt(0);
          })
          .join("")
          .slice(0, 2)
          .toUpperCase();
        const catalogPreview = (supplier.catalog || [])
          .slice(0, 4)
          .map(function (entry) {
            return escapeHtml(entry.itemName) + " · " + formatCurrency(entry.price);
          })
          .join("<br>");
        const more =
          (supplier.catalog || []).length > 4
            ? "<br><em>+" + ((supplier.catalog || []).length - 4) + " more items</em>"
            : "";

        return (
          '<div class="supplier-row">' +
          '<div class="s-avatar" style="background:' +
          colors[index % colors.length] +
          ';color:#fff;">' +
          escapeHtml(initials) +
          "</div>" +
          "<div>" +
          '<div class="s-name">' +
          escapeHtml(supplier.name) +
          "</div>" +
          '<div class="s-contact"><i class="ti ti-mail"></i> ' +
          escapeHtml(supplier.email || "—") +
          ' · <i class="ti ti-phone"></i> ' +
          escapeHtml(supplier.phone || "—") +
          "</div>" +
          '<div class="s-catalog-box"><div class="s-catalog-title">Catalog</div>' +
          (catalogPreview || "No catalog items linked.") +
          more +
          "</div>" +
          "</div>" +
          '<div class="s-actions">' +
          '<button class="btn btn-xs" onclick="window.editSupplier(' +
          supplier.id +
          ')"><i class="ti ti-edit"></i> Edit</button>' +
          '<button class="btn btn-xs btn-danger" onclick="window.deleteSupplier(' +
          supplier.id +
          ')"><i class="ti ti-trash"></i> Delete</button>' +
          "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderCatalogMatrix(selectedCatalog) {
    const tbody = $("catalog-matrix-tbody");
    if (!tbody) return;

    const selectedMap = {};
    (selectedCatalog || []).forEach(function (entry) {
      selectedMap[String(entry.itemName).toLowerCase()] = entry;
    });

    const rows = [];
    state.inventory.forEach(function (item) {
      rows.push({
        itemName: item.name,
        unit: item.unit || "pcs",
        fromInventory: true
      });
    });
    state.pendingCatalogItems.forEach(function (item) {
      if (
        !rows.some(function (row) {
          return row.itemName.toLowerCase() === item.itemName.toLowerCase();
        })
      ) {
        rows.push(item);
      }
    });

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" style="color:var(--brand-muted);font-size:12px;">Add inventory items or create a new ingredient below.</td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map(function (row, index) {
        const key = row.itemName.toLowerCase();
        const existing = selectedMap[key] || state.catalogSelections[key];
        const checked = existing ? "checked" : "";
        const price = existing ? Number(existing.price) || 150 : 150;
        return (
          '<tr data-item-key="' +
          escapeHtml(key) +
          '">' +
          '<td><input type="checkbox" class="catalog-supply-check" data-index="' +
          index +
          '" ' +
          checked +
          "></td>" +
          "<td>" +
          escapeHtml(row.itemName) +
          " <span style='color:var(--brand-muted);'>(" +
          escapeHtml(row.unit || "pcs") +
          ")</span></td>" +
          '<td style="text-align:right;"><input type="number" class="price-input catalog-price-input" data-index="' +
          index +
          '" min="0" step="0.01" value="' +
          price +
          '" ' +
          (checked ? "" : "disabled") +
          "></td>" +
          "</tr>"
        );
      })
      .join("");

    tbody.querySelectorAll(".catalog-supply-check").forEach(function (checkbox) {
      checkbox.addEventListener("change", function () {
        const row = checkbox.closest("tr");
        const priceInput = row.querySelector(".catalog-price-input");
        if (priceInput) priceInput.disabled = !checkbox.checked;
      });
    });
  }

  function collectCatalogFromMatrix() {
    const tbody = $("catalog-matrix-tbody");
    if (!tbody) return [];
    const catalog = [];
    tbody.querySelectorAll("tr").forEach(function (row) {
      const checkbox = row.querySelector(".catalog-supply-check");
      const priceInput = row.querySelector(".catalog-price-input");
      if (!checkbox || !checkbox.checked || !priceInput) return;
      const labelCell = row.children[1];
      const labelText = labelCell ? labelCell.textContent.split("(")[0].trim() : "";
      if (!labelText) return;
      catalog.push({
        itemName: labelText,
        price: Number(priceInput.value) || 0
      });
    });
    return catalog;
  }

  function renderReports() {
    const totalValue = state.purchaseOrders.reduce(function (sum, po) {
      return sum + (Number(po.total) || 0);
    }, 0);
    const deliveredCount = state.deliveries.filter(function (delivery) {
      const status = String(delivery.status || "").toLowerCase();
      return status.includes("deliver") || status.includes("verified");
    }).length;

    setText("report-po-count", state.purchaseOrders.length);
    setText("report-total-value", formatCurrency(totalValue));
    setText("report-supplier-count", state.suppliers.length);
    setText("report-delivered-count", deliveredCount);

    const tbody = $("reports-tbody");
    if (!tbody) return;
    if (!state.purchaseOrders.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="color:var(--brand-muted);">No purchase orders to summarize.</td></tr>';
      return;
    }

    tbody.innerHTML = state.purchaseOrders
      .map(function (po) {
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(po.id) +
          "</td>" +
          "<td>" +
          escapeHtml(po.supplier || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(po.type || "—") +
          "</td>" +
          '<td><span class="pill ' +
          poStatusPill(po.status) +
          '">' +
          escapeHtml(po.status) +
          "</span></td>" +
          "<td>" +
          formatCurrency(po.total) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderUsers() {
    const tbody = $("user-management-tbody");
    if (!tbody) return;

    const staffCount = state.users.filter(function (user) {
      return user.role === "staff" && !user.disabled;
    }).length;
    const supplierCount = state.users.filter(function (user) {
      return user.role === "supplier" && !user.disabled;
    }).length;
    const disabledCount = state.users.filter(function (user) {
      return user.disabled;
    }).length;

    setText("staff-user-count", staffCount);
    setText("supplier-user-count", supplierCount);
    setText("disabled-user-count", disabledCount);

    if (!state.users.length) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="color:var(--brand-muted);">No managed accounts yet.</td></tr>';
      return;
    }

    tbody.innerHTML = state.users
      .map(function (user) {
        const statusPill = user.disabled
          ? '<span class="pill pill-low">Disabled</span>'
          : '<span class="pill pill-ok">Active</span>';
        const roleLabel = user.role === "supplier" ? "Supplier" : "Inventory Staff";
        return (
          "<tr>" +
          "<td><strong>" +
          escapeHtml(user.username) +
          "</strong></td>" +
          "<td>" +
          roleLabel +
          "</td>" +
          "<td>" +
          statusPill +
          "</td>" +
          '<td style="display:flex; gap:6px; flex-wrap:wrap;">' +
          '<button class="btn btn-xs" onclick="window.editManagedUser(' +
          user.id +
          ')"><i class="ti ti-edit"></i> Edit</button>' +
          '<button class="btn btn-xs" onclick="window.resetManagedUserPassword(' +
          user.id +
          ')"><i class="ti ti-key"></i> Reset Password</button>' +
          '<button class="btn btn-xs ' +
          (user.disabled ? "btn-primary" : "btn-danger") +
          '" onclick="window.toggleManagedUser(' +
          user.id +
          ')"><i class="ti ti-power"></i> ' +
          (user.disabled ? "Enable" : "Disable") +
          "</button>" +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderAll() {
    renderDashboard();
    renderInventory();
    if (isManager) {
      renderPurchaseOrders();
      renderDeliveries();
      renderSuppliersList();
      renderCatalogMatrix([]);
      renderReports();
      renderUsers();
    }
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
  }

  async function refreshData() {
    try {
      await loadAllData();
      renderAll();
    } catch (error) {
      showToast(error.message || "Failed to refresh data.");
    }
  }

  window.showScreen = function (screenId, navEl) {
    document.querySelectorAll(".screen").forEach(function (screen) {
      screen.classList.remove("active");
    });
    const target = $("screen-" + screenId);
    if (target) target.classList.add("active");

    document.querySelectorAll(".nav-item").forEach(function (item) {
      item.classList.remove("active");
    });
    if (navEl) navEl.classList.add("active");

    const title = isManager && screenId === "inventory" ? "Inventory Monitoring" : SCREEN_TITLES[screenId];
    setText("page-title", title || "Dashboard Overview");

    closeMobileSidebar();
    closeSettingsMenu();
    closeNotifications();

    if (screenId === "suppliers") {
      renderCatalogMatrix([]);
    }
  };

  window.openUserManagement = function () {
    closeSettingsMenu();
    window.showScreen("user-management", null);
  };

  window.toggleSettingsMenu = function (event) {
    if (event) event.stopPropagation();
    const menu = $("settings-menu");
    if (!menu) return;
    menu.hidden = !menu.hidden;
    closeNotifications();
  };

  function closeSettingsMenu() {
    const menu = $("settings-menu");
    if (menu) menu.hidden = true;
  }

  window.closeMobileSidebar = function () {
    getAppRoot().classList.remove("sidebar-open");
  };

  window.toggleNotifications = function (event) {
    if (event) event.stopPropagation();
    const panel = $("notification-panel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    closeSettingsMenu();
  };

  function closeNotifications() {
    const panel = $("notification-panel");
    if (panel) panel.hidden = true;
  }

  window.syncManualSupplierLabel = function () {
    const select = $("manual-po-item");
    const hint = $("manual-po-supplier-hint");
    if (!select || !hint) return;
    const option = select.options[select.selectedIndex];
    const supplier = option ? option.getAttribute("data-supplier") : "";
    hint.textContent = "Supplier: " + (supplier || "—");
  };

  window.submitManualPO = async function () {
    if (!isManager) return;
    const select = $("manual-po-item");
    const qtyInput = $("manual-po-qty");
    if (!select || !qtyInput) return;

    const itemName = select.value;
    const qty = Number(qtyInput.value);
    const option = select.options[select.selectedIndex];
    const supplier = option ? option.getAttribute("data-supplier") || "Default Supplier" : "Default Supplier";
    const unit = option ? option.getAttribute("data-unit") || "pcs" : "pcs";

    if (!itemName) {
      showToast("Select an ingredient for the purchase order.");
      return;
    }
    if (!qty || qty <= 0) {
      showToast("Enter a valid order quantity.");
      return;
    }

    const price = getSupplierPrice(supplier, itemName);
    const poId = "PO-" + Date.now();

    try {
      await apiPost("/api/purchase-orders/create", {
        id: poId,
        itemName: itemName,
        qty: qty,
        unit: unit,
        supplier: supplier,
        total: qty * price,
        type: "Manual Request"
      });
      qtyInput.value = "";
      showToast("Manual purchase order queued for approval.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.approvePO = async function (poId) {
    try {
      await apiPost("/api/purchase-orders/approve", { id: poId });
      showToast("Purchase order approved and transmitted.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.rejectPO = async function (poId) {
    try {
      await apiPost("/api/purchase-orders/reject", { id: poId });
      showToast("Purchase order rejected.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.addInventoryItem = async function () {
    if (isManager) return;
    const name = ($("new-item-name") && $("new-item-name").value.trim()) || "";
    const stock = Number($("new-item-stock") && $("new-item-stock").value) || 0;
    const threshold = Number($("new-item-threshold") && $("new-item-threshold").value) || 0;
    const unit = ($("new-item-unit") && $("new-item-unit").value) || "pcs";
    const supplier = ($("new-item-supplier") && $("new-item-supplier").value) || "";

    if (!name) {
      showToast("Enter an ingredient name.");
      return;
    }

    try {
      await apiPost("/api/inventory/add", {
        name: name,
        stock: stock,
        threshold: threshold,
        unit: unit,
        supplier: supplier
      });

      ["new-item-name", "new-item-stock", "new-item-threshold", "new-item-price"].forEach(function (id) {
        const input = $(id);
        if (input) input.value = "";
      });
      showToast("Ingredient added to inventory.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.startQRScanner = async function () {
    if (isManager || typeof Html5Qrcode === "undefined") return;
    const reader = $("qr-reader");
    const container = $("qr-reader-container");
    const result = $("delivery-result");
    if (!reader || !container) return;

    if (state.qrScanning && state.qrScanner) {
      try {
        await state.qrScanner.stop();
      } catch (e) {
        /* ignore */
      }
      state.qrScanner.clear();
      state.qrScanner = null;
      state.qrScanning = false;
      reader.style.display = "none";
      container.style.display = "block";
      return;
    }

    reader.style.display = "block";
    container.style.display = "none";
    state.qrScanner = new Html5Qrcode("qr-reader");
    state.qrScanning = true;

    state.qrScanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async function (decodedText) {
          try {
            const detail = await apiGet("/api/staff/deliveries/" + encodeURIComponent(decodedText));
            if (result) {
              result.innerHTML =
                "<strong>" +
                escapeHtml(detail.deliveryId) +
                "</strong><br>PO: " +
                escapeHtml(detail.poNumber) +
                "<br>Supplier: " +
                escapeHtml(detail.supplier) +
                "<br>Item: " +
                escapeHtml(detail.itemName) +
                " (" +
                escapeHtml(detail.expectedQuantity) +
                " " +
                escapeHtml(detail.unit || "pcs") +
                ")<br>Status: " +
                escapeHtml(detail.status);
            }
            showToast("Delivery matched successfully.");
          } catch (error) {
            if (result) {
              result.innerHTML =
                '<span style="color:#a32d2d;">' + escapeHtml(error.message) + "</span>";
            }
            showToast(error.message);
          } finally {
            try {
              await state.qrScanner.stop();
            } catch (e) {
              /* ignore */
            }
            state.qrScanner.clear();
            state.qrScanner = null;
            state.qrScanning = false;
            reader.style.display = "none";
            container.style.display = "block";
          }
        },
        function () {
          /* ignore scan errors */
        }
      )
      .catch(function (error) {
        state.qrScanning = false;
        reader.style.display = "none";
        container.style.display = "block";
        showToast(error.message || "Unable to start camera.");
      });
  };

  window.toggleInlineIngredientForm = function (forceState) {
    const box = $("inline-ingredient-box");
    if (!box) return;
    const show = typeof forceState === "boolean" ? forceState : box.style.display === "none";
    box.style.display = show ? "block" : "none";
    if (!show) {
      ["inline-ing-name", "inline-ing-price"].forEach(function (id) {
        const input = $(id);
        if (input) input.value = "";
      });
    }
  };

  window.submitInlineIngredient = function () {
    const name = ($("inline-ing-name") && $("inline-ing-name").value.trim()) || "";
    const unit = ($("inline-ing-unit") && $("inline-ing-unit").value) || "kg";
    const price = Number($("inline-ing-price") && $("inline-ing-price").value) || 0;

    if (!name) {
      showToast("Enter an ingredient name.");
      return;
    }
    if (price <= 0) {
      showToast("Enter a valid contract price.");
      return;
    }

    state.pendingCatalogItems.push({ itemName: name, unit: unit, price: price });
    state.catalogSelections[name.toLowerCase()] = { itemName: name, price: price };
    renderCatalogMatrix(collectCatalogFromMatrix());
    toggleInlineIngredientForm(false);
    showToast("Ingredient added to catalog matrix.");
  };

  window.resetSupplierForm = function () {
    ["supplier-edit-id", "supplier-name", "supplier-email", "supplier-phone"].forEach(function (id) {
      const input = $(id);
      if (input) input.value = "";
    });
    state.pendingCatalogItems = [];
    state.catalogSelections = {};
    renderCatalogMatrix([]);
    const submitBtn = $("supplier-submit-btn");
    const cancelBtn = $("supplier-cancel-btn");
    const sectionTitle = $("form-section-title");
    if (submitBtn) submitBtn.innerHTML = '<i class="ti ti-plus"></i> Register supplier';
    if (cancelBtn) cancelBtn.style.display = "none";
    if (sectionTitle) sectionTitle.textContent = "Register New Supplier";
    toggleInlineIngredientForm(false);
  };

  window.saveSupplier = async function () {
    if (!isManager) return;
    const editId = ($("supplier-edit-id") && $("supplier-edit-id").value) || "";
    const name = ($("supplier-name") && $("supplier-name").value.trim()) || "";
    const email = ($("supplier-email") && $("supplier-email").value.trim()) || "";
    const phone = ($("supplier-phone") && $("supplier-phone").value.trim()) || "";
    const catalog = collectCatalogFromMatrix();

    if (!name) {
      showToast("Enter a supplier name.");
      return;
    }

    try {
      if (editId) {
        await apiPost("/api/suppliers/delete", { id: Number(editId) });
      }
      await apiPost("/api/suppliers/add", {
        name: name,
        email: email,
        phone: phone,
        catalog: catalog
      });
      resetSupplierForm();
      showToast(editId ? "Supplier updated successfully." : "Supplier registered successfully.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.editSupplier = function (supplierId) {
    const supplier = state.suppliers.find(function (s) {
      return s.id === supplierId;
    });
    if (!supplier) return;

    $("supplier-edit-id").value = supplier.id;
    $("supplier-name").value = supplier.name;
    $("supplier-email").value = supplier.email || "";
    $("supplier-phone").value = supplier.phone || "";

    const submitBtn = $("supplier-submit-btn");
    const cancelBtn = $("supplier-cancel-btn");
    const sectionTitle = $("form-section-title");
    if (submitBtn) submitBtn.innerHTML = '<i class="ti ti-device-floppy"></i> Save supplier';
    if (cancelBtn) cancelBtn.style.display = "inline-flex";
    if (sectionTitle) sectionTitle.textContent = "Edit Supplier";

    state.pendingCatalogItems = [];
    state.catalogSelections = {};
    renderCatalogMatrix(supplier.catalog || []);
    window.showScreen("suppliers", document.querySelector('[onclick*="suppliers"]'));
    $("supplier-name").scrollIntoView({ behavior: "smooth", block: "start" });
  };

  window.deleteSupplier = async function (supplierId) {
    if (!confirm("Delete this supplier?")) return;
    try {
      await apiPost("/api/suppliers/delete", { id: supplierId });
      showToast("Supplier deleted.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.openUserModal = function (role) {
    const modal = $("user-modal");
    if (!modal) return;
    $("managed-user-id").value = "";
    $("managed-username").value = "";
    $("managed-password").value = "";
    $("managed-user-role").value = role || "staff";
    $("managed-password-group").style.display = "block";
    $("user-modal-title").textContent =
      role === "supplier" ? "Create Supplier Account" : "Create Inventory Staff Account";
    modal.hidden = false;
  };

  window.closeUserModal = function () {
    const modal = $("user-modal");
    if (modal) modal.hidden = true;
  };

  window.saveManagedUser = async function () {
    const id = ($("managed-user-id") && $("managed-user-id").value) || "";
    const username = ($("managed-username") && $("managed-username").value.trim()) || "";
    const role = ($("managed-user-role") && $("managed-user-role").value) || "staff";
    const password = ($("managed-password") && $("managed-password").value) || "";
    const payload = { username: username, role: role };
    if (id) payload.id = Number(id);
    if (!id) payload.password = password;

    if (!username) {
      showToast("Enter a username.");
      return;
    }
    if (!id && !password) {
      showToast("Enter a temporary password.");
      return;
    }

    try {
      await apiPost("/api/users/save", payload);
      closeUserModal();
      showToast(id ? "Account updated." : "Account created.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.editManagedUser = function (userId) {
    const user = state.users.find(function (entry) {
      return entry.id === userId;
    });
    if (!user) return;
    $("managed-user-id").value = user.id;
    $("managed-username").value = user.username;
    $("managed-user-role").value = user.role;
    $("managed-password").value = "";
    $("managed-password-group").style.display = "none";
    $("user-modal-title").textContent = "Edit Account";
    $("user-modal").hidden = false;
  };

  window.resetManagedUserPassword = async function (userId) {
    const password = prompt("Enter a new temporary password:");
    if (!password) return;
    try {
      await apiPost("/api/users/reset-password", { id: userId, password: password });
      showToast("Password reset successfully.");
    } catch (error) {
      showToast(error.message);
    }
  };

  window.toggleManagedUser = async function (userId) {
    try {
      await apiPost("/api/users/toggle-disabled", { id: userId });
      showToast("Account status updated.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  window.adjustStock = async function (itemId) {
    if (isManager) return;
    const item = state.inventory.find(function (entry) {
      return entry.id === itemId;
    });
    if (!item) return;
    const newStock = prompt("Enter new stock quantity for " + item.name + ":", item.stock);
    if (newStock === null) return;
    try {
      await apiPost("/api/inventory/update", { id: itemId, stock: Number(newStock) });
      showToast("Stock updated.");
      await refreshData();
    } catch (error) {
      showToast(error.message);
    }
  };

  function bindGlobalEvents() {
    const sidebarToggle = $("sidebar-toggle");
    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", function () {
        const root = getAppRoot();
        if (isMobileViewport()) {
          root.classList.toggle("sidebar-open");
        } else {
          root.classList.toggle("sidebar-collapsed");
          sidebarToggle.setAttribute(
            "aria-expanded",
            root.classList.contains("sidebar-collapsed") ? "false" : "true"
          );
        }
      });
    }

    document.addEventListener("click", function (event) {
      const settingsWrap = document.querySelector(".settings-wrap");
      if (settingsWrap && !settingsWrap.contains(event.target)) {
        closeSettingsMenu();
      }
      const notificationsWrap = document.querySelector(".notifications-wrap");
      if (notificationsWrap && !notificationsWrap.contains(event.target)) {
        closeNotifications();
      }
    });

    const userModal = $("user-modal");
    if (userModal) {
      userModal.addEventListener("click", function (event) {
        if (event.target === userModal) closeUserModal();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    bindGlobalEvents();
    if (!isManager && SCREEN_TITLES.inventory) {
      SCREEN_TITLES.inventory = "Inventory";
    }
    try {
      await loadAllData();
      renderAll();
    } catch (error) {
      showToast(error.message || "Failed to load portal data.");
    }
  });
})();
