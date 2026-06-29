(function () {
  "use strict";

  function enhancePasswordField(input) {
    if (!input || input.dataset.passwordToggle === "true") return;
    var wrapper = input.closest(".input-wrapper, .password-field-wrap");
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "password-field-wrap";
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);
    }
    wrapper.classList.add("has-password-toggle");
    input.dataset.passwordToggle = "true";

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "password-toggle-btn";
    toggle.setAttribute("aria-label", "Show password");
    toggle.innerHTML = '<i class="fa-solid fa-eye"></i>';
    toggle.addEventListener("click", function () {
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      toggle.innerHTML = showing
        ? '<i class="fa-solid fa-eye"></i>'
        : '<i class="fa-solid fa-eye-slash"></i>';
    });
    wrapper.appendChild(toggle);
  }

  function initPasswordToggles(root) {
    (root || document).querySelectorAll('input[type="password"]').forEach(enhancePasswordField);
  }

  window.PasswordToggle = { init: initPasswordToggles };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { initPasswordToggles(); });
  } else {
    initPasswordToggles();
  }
})();
