import { webPushService } from './webPushService.js';

export class NotifierService {
  constructor() {
    this.clients = new Set();
    this.alertHistory = [];
  }

  addClient(res) {
    this.clients.add(res);
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  broadcast(type, data) {
    const payload = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch (err) {
        this.clients.delete(res);
      }
    }
  }

  notifyNewAlert(cluster) {
    console.log(`\n🔔 [התראה חדשה נשלחה!]`);
    console.log(`📌 נושא: ${cluster.topicTitle}`);
    console.log(`📰 כותרת: ${cluster.title}`);
    console.log(`🌐 מקור: ${cluster.sources[0]?.source || 'לא ידוע'}\n`);

    // 1. שידור חי בדפדפנים פתוחים (SSE)
    this.broadcast('NEW_ALERT', cluster);

    // 2. שליחת Web Push ישירות למסכי הנעילה של סמארטפונים
    webPushService.sendPushNotification(cluster).catch(err => {
      console.error('[WebPush] שגיאה בשליחת Push:', err);
    });
  }

  notifyClusterUpdated(cluster, addedSource) {
    console.log(`🔗 [אירוע עודכן] "${cluster.title.slice(0, 35)}..." קיבל דיווח נוסף מ-${addedSource.source}`);
    this.broadcast('CLUSTER_UPDATED', cluster);
  }

  notifyStatus(status) {
    this.broadcast('STATUS_UPDATE', status);
  }
}

export const notifier = new NotifierService();
