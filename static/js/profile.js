(function () {
  "use strict";
  var role = document.body.dataset.role;
  var $ = function (id) { return document.getElementById(id); };

  function toast(msg) {
    var el = $("staff-toast");
    if (!el) return;
    el.querySelector("span").textContent = msg;
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, 2800);
  }

  function setAvatar(data, fallbackText) {
    var img = $("profile-avatar-preview");
    var fb = $("profile-avatar-fallback");
    if (data) {
      img.src = data;
      img.hidden = false;
      fb.style.display = "none";
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      fb.style.display = "grid";
      fb.textContent = fallbackText || "BM";
    }
  }

  function readFile(file, cb) {
    var reader = new FileReader();
    reader.onload = function () { cb(reader.result); };
    reader.readAsDataURL(file);
  }

  var avatarData = "";

  async function loadProfile() {
    var res = await fetch("/api/profile", { credentials: "same-origin" });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load profile.");
    if (role === "supplier") {
      $("supplier-fields").hidden = false;
      $("manager-staff-fields").hidden = true;
      $("readonly-fields").hidden = true;
      $("avatar-section").querySelector("label").innerHTML = '<i class="ti ti-upload"></i> Upload Logo<input type="file" id="avatar-upload" accept="image/*" hidden>';
      $("profile-company").value = data.companyName || "";
      $("profile-contact-person").value = data.contactPerson || "";
      $("profile-supplier-email").value = data.email || "";
      $("profile-supplier-phone").value = data.contactNumber || "";
      $("profile-address").value = data.businessAddress || "";
      $("profile-supplier-id").textContent = data.supplierId || "—";
      avatarData = data.logoData || "";
      setAvatar(avatarData, (data.companyName || "S").charAt(0).toUpperCase());
    } else {
      $("profile-full-name").value = data.fullName || "";
      $("profile-email").value = data.email || "";
      $("profile-contact").value = data.contactNumber || "";
      if (role === "staff" && $("profile-account-status")) {
        $("profile-account-status").textContent = data.disabled ? "Disabled" : "Active";
      }
      avatarData = data.avatarData || "";
      var initials = (data.fullName || data.username || "BM").split(" ").map(function (p) { return p[0]; }).join("").slice(0, 2).toUpperCase();
      setAvatar(avatarData, initials);
    }
    bindUpload();
  }

  function bindUpload() {
    var input = $("avatar-upload");
    if (!input) return;
    input.addEventListener("change", function () {
      if (!input.files || !input.files[0]) return;
      readFile(input.files[0], function (data) {
        avatarData = data;
        setAvatar(avatarData, "BM");
      });
    });
    $("avatar-remove").addEventListener("click", function () {
      avatarData = "";
      setAvatar("", "BM");
    });
  }

  $("profile-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var body = {};
    if (role === "supplier") {
      body = {
        companyName: $("profile-company").value,
        contactPerson: $("profile-contact-person").value,
        email: $("profile-supplier-email").value,
        contactNumber: $("profile-supplier-phone").value,
        businessAddress: $("profile-address").value,
        logoData: avatarData,
      };
    } else {
      body = {
        fullName: $("profile-full-name").value,
        email: $("profile-email").value,
        contactNumber: $("profile-contact").value,
        avatarData: avatarData,
      };
    }
    var res = await fetch("/api/profile", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!res.ok) return toast(data.error || "Save failed.");
    toast("Profile updated successfully.");
  });

  document.addEventListener("DOMContentLoaded", function () {
    loadProfile().catch(function (err) { toast(err.message); });
  });
})();
