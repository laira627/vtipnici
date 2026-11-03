// Service worker appky Vtipníci - jen pro push notifikace termínů (3. 11. 2026).
//
// Záměrně NEMÁ žádný "fetch" handler: nic necachuje a do načítání stránek
// appky (index.html, quick.html, water.html, fasting.html) nijak nezasahuje.
// Jeho jediná práce je:
//   1. přijmout push zprávu, kterou každou hodinu pošle skript na GitHubu
//      (notifikace/posli-notifikace.mjs), a zobrazit z ní notifikaci,
//   2. po kliknutí na notifikaci otevřít appku rovnou na dané poznámce
//      (index.html?note=<id> - appka pak otevře dialog rychlé úpravy).
//
// Musí ležet v kořeni repozitáře vedle index.html, aby jeho rozsah (scope)
// pokrýval celou appku.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Vtipníci", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "📌 Termín";
  const options = {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "favicon-32.png",
    // Stejná poznámka = stejný tag: kdyby přišla notifikace pro tutéž
    // poznámku dvakrát, nahradí se místo zdvojení.
    tag: data.noteId ? "termin-" + data.noteId : undefined,
    renotify: !!data.noteId,
    data: { noteId: data.noteId || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const noteId = event.notification.data && event.notification.data.noteId;
  const target = new URL(noteId ? "index.html?note=" + encodeURIComponent(noteId) : "index.html", self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Je-li appka (index.html) už otevřená, přepne se na ni a načte poznámku;
    // jinak se otevře nové okno/karta.
    const appWindow = windows.find(w => {
      const path = new URL(w.url).pathname;
      return path.endsWith("/") || path.endsWith("/index.html");
    });
    if (appWindow) {
      try {
        const navigated = await appWindow.navigate(target);
        return (navigated || appWindow).focus();
      } catch (e) {
        // navigate() selže u okna, které tenhle service worker neovládá -
        // v tom případě prostě otevřeme nové.
      }
    }
    return self.clients.openWindow(target);
  })());
});
