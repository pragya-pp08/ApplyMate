(() => {
  const storageKey = "applymateTheme";
  const preferredTheme = () => {
    const saved = localStorage.getItem(storageKey);
    if (["light", "dark"].includes(saved)) return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const button = document.querySelector("#themeToggle");
    if (!button) return;
    const dark = theme === "dark";
    button.setAttribute("aria-pressed", String(dark));
    button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    button.querySelector("span").textContent = dark ? "☀" : "☾";
    button.querySelector("b").textContent = dark ? "Light mode" : "Dark mode";
  };

  applyTheme(preferredTheme());
  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(preferredTheme());
    document.querySelector("#themeToggle")?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem(storageKey, next);
      applyTheme(next);
    });
  });
})();
