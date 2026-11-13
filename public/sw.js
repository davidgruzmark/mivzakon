// Service Worker - מבזקון PWA & Push Notifications

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// קבלת התראת Push מהשרת (גם כשהמסך נעול והדפדפן סגור!)
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'מבזק חדש 🔔', body: event.data.text() };
  }

  const options = {
    body: data.body || 'דיווח חדש נקלט במערכת',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',
    vibrate: [200, 100, 200, 100, 300],
    tag: data.data?.eventId || 'news_alert',
    renotify: true,
    data: data.data || { url: '/' },
    dir: 'rtl',
    lang: 'he'
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'מבזקון', options)
  );
});

// לחיצה על ההתראה בסמארטפון – פותחת ישירות את הכתבה או מתמקדת באפליקציה
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
