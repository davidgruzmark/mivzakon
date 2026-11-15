import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { storage } from './src/services/storage.js';
import { poller } from './src/services/rssPoller.js';
import { notifier } from './src/services/notifier.js';
import { webPushService } from './src/services/webPushService.js';
import { dbService } from './src/services/db.js';
import { ISRAELI_NEWS_SOURCES } from './src/config/sources.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// פונקציית עזר למציאת כתובת ה-IP המקומית של המחשב ברשת ה-Wi-Fi
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// === API Routes ===

// 1. קבלת כל האשכולות והאירועים ישירות ממסד הנתונים SQLite
app.get('/api/events', (req, res) => {
  const { topicId, search, sort = 'desc' } = req.query;
  const clusters = storage.getClusters({ topicId, search, sort });
  res.json(clusters);
});

// מחיקת אירוע ספציפי ממסד הנתונים
app.delete('/api/events/:id', (req, res) => {
  storage.deleteCluster(req.params.id);
  notifier.broadcast('CLUSTER_DELETED', { id: req.params.id });
  res.json({ success: true });
});

// ניקוי כל האירועים ממסד הנתונים
app.delete('/api/events', (req, res) => {
  storage.clearAllClusters();
  notifier.broadcast('ALL_CLEARED', {});
  res.json({ success: true });
});

// 2. ניהול נושאי מעקב
app.get('/api/topics', (req, res) => {
  res.json(storage.getTopics());
});

app.post('/api/topics', (req, res) => {
  const { title, keywords, badgeColor } = req.body;
  if (!title || !keywords) {
    return res.status(400).json({ error: 'כותרת ומילות מפתח הן שדות חובה' });
  }

  const topics = storage.getTopics();
  const kwList = Array.isArray(keywords) 
    ? keywords 
    : keywords.split(',').map(s => s.trim()).filter(Boolean);

  const newTopic = {
    id: `topic_${Date.now()}`,
    title: title.trim(),
    keywords: kwList,
    enabled: true,
    badgeColor: badgeColor || 'border-blue-500/40 text-blue-400 bg-blue-500/10'
  };

  topics.push(newTopic);
  storage.saveTopics(topics);
  res.json(newTopic);
});

app.put('/api/topics/:id', (req, res) => {
  let topics = storage.getTopics();
  const index = topics.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'נושא לא נמצא' });

  const updateData = { ...req.body };
  if (updateData.keywords !== undefined) {
    updateData.keywords = Array.isArray(updateData.keywords)
      ? updateData.keywords
      : updateData.keywords.split(',').map(s => s.trim()).filter(Boolean);
  }

  topics[index] = { ...topics[index], ...updateData };
  storage.saveTopics(topics);
  res.json(topics[index]);
});

app.delete('/api/topics/:id', (req, res) => {
  let topics = storage.getTopics();
  topics = topics.filter(t => t.id !== req.params.id);
  storage.saveTopics(topics);
  res.json({ success: true });
});

// 3. מקורות, סטטיסטיקות ומידע רשת לחיבור מסמארטפון
app.get('/api/sources', (req, res) => {
  res.json(ISRAELI_NEWS_SOURCES);
});

app.get('/api/network-info', (req, res) => {
  const localIp = getLocalIpAddress();
  res.json({
    localIp,
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    mobileUrl: `http://${localIp}:${PORT}`
  });
});

app.get('/api/stats', (req, res) => {
  const clusters = storage.getClusters();
  const stats = poller.getStats();
  res.json({
    ...stats,
    cloudDbConnected: dbService.isCloudConnected(),
    totalClustersCount: clusters.length,
    totalSourcesReported: clusters.reduce((acc, c) => acc + (c.sources ? c.sources.length : 0), 0)
  });
});

// 4. סריקה יזומה מיידית
app.post('/api/poll-now', async (req, res) => {
  poller.pollAll();
  res.json({ message: 'סריקה הופעלה' });
});

// 5. נתיבי Web Push להתראות מסך נעילה בסמארטפון
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: webPushService.getPublicKey() });
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Missing subscription' });
  dbService.savePushSubscription(subscription, req.headers['user-agent'] || '');
  console.log('[WebPush] נרשם מכשיר סמארטפון חדש לקבלת התראות Push!');
  res.json({ success: true });
});

app.post('/api/push/update-topics', (req, res) => {
  const { endpoint, topics } = req.body;
  if (!endpoint || !topics) return res.status(400).json({ error: 'Missing parameters' });
  dbService.updatePushSubscriptionTopics(endpoint, topics);
  res.json({ success: true });
});

app.post('/api/push/test', async (req, res) => {
  await webPushService.sendPushNotification({
    id: 'test_' + Date.now(),
    topicTitle: 'בדיקת מערכת',
    title: 'התראת Push פועלת בהצלחה בסמארטפון שלך! 🔔',
    sources: [{ url: '/' }]
  });
  res.json({ success: true });
});

// 6. ערוץ עדכונים חי (Server-Sent Events)
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  notifier.addClient(res);

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'מחובר לזרם העדכונים החי' })}\n\n`);

  req.on('close', () => {
    notifier.removeClient(res);
  });
});

// הפעלת השרת והאזנה לכל ממשקי הרשת (0.0.0.0) לגישה מסמארטפונים ובענן
async function startServer() {
  await dbService.initCloudSync();
  webPushService.initVapid();

  app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIpAddress();
    const dbMode = dbService.isCloudConnected()
      ? '☁️ PostgreSQL בענן + מטמון SQLite מהיר'
      : '📁 SQLite מקומי (data/news.db)';
    console.log(`\n======================================================`);
    console.log(`🚀 אפליקציית התראות המבזקים פועלת!`);
    console.log(`🗄️ מסד נתונים:     ${dbMode}`);
    console.log(`💻 במחשב זה:      http://localhost:${PORT}`);
    console.log(`📱 מהסמארטפון שלך: http://${localIp}:${PORT} (באותה רשת Wi-Fi)`);
    console.log(`======================================================\n`);

    poller.start();
  });
}

startServer();
