(function () {
  "use strict";

  function getAppRoot() {
    return document.querySelector(".staff-app");
  }

  function isMobileLayout() {
    return window.matchMedia("(max-width: 1100px)").matches;
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
  };
})();
