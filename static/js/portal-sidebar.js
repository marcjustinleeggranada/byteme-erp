(function () {
  "use strict";

  function getAppRoot() {
    return document.querySelector(".staff-app");
  }

  function isMobileLayout() {
    return window.matchMedia("(max-width: 1100px)").matches;
  }

  function isSidebarCollapsed() {
    var app = getAppRoot();
    return !!(app && app.classList.contains("sidebar-collapsed"));
  }

  function expandSidebar() {
    var app = getAppRoot();
    if (app) app.classList.remove("sidebar-collapsed");
  }

  function closeMobileSidebar() {
    document.body.classList.remove("mobile-sidebar-open");
  }

  function openMobileSidebar() {
    document.body.classList.add("mobile-sidebar-open");
  }

  function toggleSidebar() {
    if (isMobileLayout()) {
      if (document.body.classList.contains("mobile-sidebar-open")) closeMobileSidebar();
      else openMobileSidebar();
      return;
    }
    var app = getAppRoot();
    if (app) app.classList.toggle("sidebar-collapsed");
  }

  function handleNavGroupToggle(toggle) {
    var group = toggle.closest(".staff-nav-group");
    if (!group) return;
    if (isSidebarCollapsed()) {
      expandSidebar();
      document.querySelectorAll(".staff-nav-group.open").forEach(function (g) {
        if (g !== group) g.classList.remove("open");
      });
      group.classList.add("open");
      return;
    }
    group.classList.toggle("open");
  }

  function setupNavGroups() {
    document.querySelectorAll(".staff-nav-group .group-toggle").forEach(function (toggle) {
      if (toggle.dataset.sidebarNavBound === "1") return;
      toggle.dataset.sidebarNavBound = "1";
      toggle.addEventListener("click", function () {
        handleNavGroupToggle(toggle);
      });
    });
  }

  function setupSettingsFooter() {
    document.querySelectorAll(".staff-sidebar-footer .staff-nav-item").forEach(function (item) {
      if (item.dataset.sidebarFooterBound === "1") return;
      item.dataset.sidebarFooterBound = "1";
      item.addEventListener("click", function (event) {
        if (!isSidebarCollapsed() || isMobileLayout()) return;
        event.preventDefault();
        expandSidebar();
      });
    });
  }

  function setupSidebarToggle(buttonId, overlayId) {
    var menuBtn = document.getElementById(buttonId);
    var overlay = overlayId ? document.getElementById(overlayId) : null;
    if (menuBtn) menuBtn.addEventListener("click", toggleSidebar);
    if (overlay) overlay.addEventListener("click", closeMobileSidebar);
  }

  window.PortalSidebar = {
    setup: setupSidebarToggle,
    toggle: toggleSidebar,
    closeMobile: closeMobileSidebar,
    expand: expandSidebar,
    isCollapsed: isSidebarCollapsed,
    setupNavGroups: setupNavGroups,
    setupSettingsFooter: setupSettingsFooter,
  };
})();
