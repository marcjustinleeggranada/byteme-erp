(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function initialsFromName(name) {
    if (!name) return "BM";
    var parts = name.trim().split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function applyAvatar(el, imageData, fallbackInitials) {
    if (!el) return;
    var existing = el.querySelector("img");
    if (imageData) {
      if (!existing) {
        existing = document.createElement("img");
        existing.alt = "Profile";
        el.textContent = "";
        el.appendChild(existing);
      }
      existing.src = imageData;
      el.classList.add("has-image");
    } else {
      if (existing) existing.remove();
      el.classList.remove("has-image");
      el.textContent = fallbackInitials;
    }
  }

  function applyProfile(profile) {
    if (!profile) return;
    var role = String(profile.role || "").toLowerCase();
    var isSupplier = role.indexOf("supplier") !== -1;
    var displayName = isSupplier
      ? (profile.companyName || profile.fullName || profile.username || "User")
      : (profile.fullName || profile.username || "User");
    var avatarData = isSupplier ? (profile.logoData || profile.avatarData) : profile.avatarData;
    var fallback = initialsFromName(displayName);

    var nameEl = $("portal-user-name");
    if (nameEl) nameEl.textContent = displayName;

    applyAvatar($("portal-user-avatar"), avatarData, fallback);

    var subtitle = $("profile-page-subtitle");
    if (subtitle) {
      subtitle.textContent = displayName + " · " + (profile.role || "");
    }
  }

  function loadHeaderProfile() {
    return fetch("/api/profile", { credentials: "same-origin" })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) return null;
          applyProfile(data);
          return data;
        });
      })
      .catch(function () { return null; });
  }

  window.PortalProfile = {
    applyProfile: applyProfile,
    loadHeaderProfile: loadHeaderProfile,
  };

  document.addEventListener("DOMContentLoaded", function () {
    if ($("portal-user-name") || $("portal-user-avatar") || $("profile-page-subtitle")) {
      loadHeaderProfile();
    }
  });

  window.addEventListener("pageshow", function () {
    if (sessionStorage.getItem("profileUpdated")) {
      sessionStorage.removeItem("profileUpdated");
      loadHeaderProfile();
    }
  });
})();
