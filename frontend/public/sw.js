self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const title = payload.title || "Stellar SolarGrid";
  const options = {
    body: payload.body,
    icon: payload.icon || "/icons/push-warning.svg",
    badge: payload.badge || "/icons/push-badge.svg",
    tag: payload.tag || "solargrid-alert",
    data: payload.data || {},
    actions: payload.actions || [],
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action;
  const topUpPath = event.notification?.data?.topUpPath || "/pay";
  event.notification.close();

  if (action === "top-up" || !action) {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        const matchingClient = clients.find((client) => client.url.includes(topUpPath));
        if (matchingClient) {
          matchingClient.focus();
          return matchingClient.navigate(topUpPath);
        }
        return self.clients.openWindow(topUpPath);
      }),
    );
  }
});
