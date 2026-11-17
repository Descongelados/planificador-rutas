"use strict";

// Registro del service worker (solo en producción) y botón de instalación en Android.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* sin soporte: la app sigue funcionando */ });
  });
}

let installEvent = null;
const installBtn = document.getElementById("install");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  installBtn.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  installBtn.classList.add("hidden");
});

window.addEventListener("appinstalled", () => installBtn.classList.add("hidden"));
