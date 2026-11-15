import webpush from 'web-push';
import { dbService } from './db.js';

class WebPushService {
  constructor() {
    this.initVapid();
  }

  initVapid() {
    const settings = dbService.getSettings();
    let vapidKeys = settings.vapidKeys;

    if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
      vapidKeys = webpush.generateVAPIDKeys();
      dbService.updateSettings({ vapidKeys });
      console.log('[WebPush] נוצרו מפתחות VAPID חדשים להתראות סמארטפון.');
    }

    this.publicKey = vapidKeys.publicKey;
    this.privateKey = vapidKeys.privateKey;

    webpush.setVapidDetails(
      'mailto:mivzakon-alerts@localhost',
      this.publicKey,
      this.privateKey
    );
  }

  getPublicKey() {
    return this.publicKey;
  }

  async sendPushNotification(cluster) {
    const subs = dbService.getAllPushSubscriptions();
    if (subs.length === 0) return;

    // ריבוי משתמשים: שולחים התראה רק למכשירים שבחרו לקבל נושא זה (או שלא הגבילו)
    const targetSubs = subs.filter(sub => {
      if (!sub.subscribedTopics || sub.subscribedTopics.length === 0) return true;
      return cluster.topicId ? sub.subscribedTopics.includes(cluster.topicId) : true;
    });

    if (targetSubs.length === 0) return;

    const payload = JSON.stringify({
      title: `[${cluster.topicTitle}] מבזק חדש 🔔`,
      body: cluster.title,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      data: {
        url: cluster.sources && cluster.sources[0] ? cluster.sources[0].url : '/',
        eventId: cluster.id
      }
    });

    console.log(`[WebPush] משדר התראת Push למסכי נעילה של ${targetSubs.length} מכשירים מתאימים...`);

    const promises = targetSubs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // מנוי פג תוקף או האפליקציה הוסרה מהטלפון
          dbService.removePushSubscription(sub.endpoint);
        }
      }
    });

    await Promise.allSettled(promises);
  }
}

export const webPushService = new WebPushService();
