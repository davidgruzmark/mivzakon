import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_TOPICS } from '../config/defaultTopics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'news.db');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'store.json');

export class DatabaseService {
  constructor() {
    this.ensureDir();
    this.db = new DatabaseSync(DB_FILE);
    this.initSchema();
    this.migrateFromLegacyJson();
  }

  ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  initSchema() {
    // מפעילים מצב WAL לביצועים גבוהים וסינכרון בטוח
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        keywords TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        badge_color TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS clusters (
        id TEXT PRIMARY KEY,
        topic_id TEXT,
        topic_title TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        first_reported_at TEXT NOT NULL,
        last_updated_at TEXT NOT NULL,
        alert_sent INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cluster_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        pub_date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
        UNIQUE (cluster_id, url)
      );

      CREATE INDEX IF NOT EXISTS idx_clusters_time ON clusters (first_reported_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clusters_topic ON clusters (topic_id);
      CREATE INDEX IF NOT EXISTS idx_sources_cluster ON cluster_sources (cluster_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        subscribed_topics TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // מיגרציה לעמודת subscribed_topics אם הטבלה כבר נוצרה קודם
    try {
      this.db.exec('ALTER TABLE push_subscriptions ADD COLUMN subscribed_topics TEXT;');
    } catch (e) {
      // העמודה כבר קיימת
    }
  }

  migrateFromLegacyJson() {
    const topicCount = this.db.prepare('SELECT COUNT(*) as count FROM topics').get().count;
    
    // אם טבלת הנושאים ריקה, מייבאים מ-store.json הקיים או מברירת המחדל
    if (topicCount === 0) {
      let topicsToSeed = DEFAULT_TOPICS;
      let clustersToSeed = [];

      if (fs.existsSync(LEGACY_JSON_FILE)) {
        try {
          const raw = fs.readFileSync(LEGACY_JSON_FILE, 'utf8');
          const data = JSON.parse(raw);
          if (data.topics && data.topics.length > 0) topicsToSeed = data.topics;
          if (data.clusters && data.clusters.length > 0) clustersToSeed = data.clusters;
          console.log(`[Database] ייבוא אוטומטי מ-store.json: ${topicsToSeed.length} נושאים, ${clustersToSeed.length} אירועים.`);
        } catch (e) {
          console.error('[Database] שגיאה בקריאת store.json הישן:', e);
        }
      }

      this.saveTopics(topicsToSeed);
      if (clustersToSeed.length > 0) {
        this.saveClusters(clustersToSeed);
      }
    }
  }

  // === Topics ===
  getTopics() {
    const rows = this.db.prepare('SELECT * FROM topics ORDER BY created_at ASC').all();
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      keywords: JSON.parse(r.keywords || '[]'),
      enabled: Boolean(r.enabled),
      badgeColor: r.badge_color
    }));
  }

  saveTopics(topics) {
    const insertOrReplace = this.db.prepare(`
      INSERT INTO topics (id, title, keywords, enabled, badge_color, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        keywords = excluded.keywords,
        enabled = excluded.enabled,
        badge_color = excluded.badge_color,
        updated_at = CURRENT_TIMESTAMP
    `);

    // מוחקים נושאים שכבר לא קיימים במערך
    const existing = this.getTopics();
    const newIds = new Set(topics.map(t => t.id));
    for (const ex of existing) {
      if (!newIds.has(ex.id)) {
        this.db.prepare('DELETE FROM topics WHERE id = ?').run(ex.id);
      }
    }

    for (const t of topics) {
      insertOrReplace.run(
        t.id,
        t.title,
        JSON.stringify(t.keywords || []),
        t.enabled ? 1 : 0,
        t.badgeColor || ''
      );
    }

    return this.getTopics();
  }

  // === Clusters & Sources ===
  getClusters({ topicId, search, sort = 'desc' } = {}) {
    let sql = 'SELECT * FROM clusters';
    const params = [];
    const conditions = [];

    if (topicId && topicId !== 'all') {
      conditions.push('topic_id = ?');
      params.push(topicId);
    }

    if (search) {
      conditions.push('(title LIKE ? OR summary LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += sort === 'asc' 
      ? ' ORDER BY first_reported_at ASC' 
      : ' ORDER BY first_reported_at DESC';

    const clusterRows = this.db.prepare(sql).all(...params);
    if (clusterRows.length === 0) return [];

    // טעינת כל המקורות עבור האשכולות
    const clusterIds = clusterRows.map(c => c.id);
    const placeholders = clusterIds.map(() => '?').join(',');
    const sourcesRows = this.db.prepare(`
      SELECT * FROM cluster_sources 
      WHERE cluster_id IN (${placeholders})
      ORDER BY id ASC
    `).all(...clusterIds);

    // מיפוי מקורות לפי cluster_id
    const sourcesMap = new Map();
    for (const s of sourcesRows) {
      if (!sourcesMap.has(s.cluster_id)) {
        sourcesMap.set(s.cluster_id, []);
      }
      sourcesMap.get(s.cluster_id).push({
        title: s.title,
        url: s.url,
        source: s.source_name,
        sourceId: s.source_id,
        pubDate: s.pub_date
      });
    }

    return clusterRows.map(r => ({
      id: r.id,
      topicId: r.topic_id,
      topicTitle: r.topic_title,
      title: r.title,
      summary: r.summary || '',
      firstReportedAt: r.first_reported_at,
      lastUpdatedAt: r.last_updated_at,
      alertSent: Boolean(r.alert_sent),
      sources: sourcesMap.get(r.id) || []
    }));
  }

  saveClusters(clusters) {
    const insertCluster = this.db.prepare(`
      INSERT INTO clusters (id, topic_id, topic_title, title, summary, first_reported_at, last_updated_at, alert_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        topic_id = excluded.topic_id,
        topic_title = excluded.topic_title,
        title = excluded.title,
        summary = excluded.summary,
        first_reported_at = excluded.first_reported_at,
        last_updated_at = excluded.last_updated_at,
        alert_sent = excluded.alert_sent
    `);

    const insertSource = this.db.prepare(`
      INSERT OR IGNORE INTO cluster_sources (cluster_id, title, url, source_name, source_id, pub_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const c of clusters) {
      insertCluster.run(
        c.id,
        c.topicId || '',
        c.topicTitle || '',
        c.title,
        c.summary || '',
        c.firstReportedAt,
        c.lastUpdatedAt,
        c.alertSent ? 1 : 0
      );

      if (c.sources && Array.isArray(c.sources)) {
        for (const s of c.sources) {
          insertSource.run(
            c.id,
            s.title || c.title,
            s.url,
            s.source || 'לא ידוע',
            s.sourceId || 'generic',
            s.pubDate || c.firstReportedAt
          );
        }
      }
    }

    return clusters;
  }

  deleteCluster(id) {
    this.db.prepare('DELETE FROM cluster_sources WHERE cluster_id = ?').run(id);
    this.db.prepare('DELETE FROM clusters WHERE id = ?').run(id);
    return true;
  }

  clearAllClusters() {
    this.db.prepare('DELETE FROM cluster_sources').run();
    this.db.prepare('DELETE FROM clusters').run();
    return true;
  }

  // === Settings ===
  getSettings() {
    const rows = this.db.prepare('SELECT * FROM settings').all();
    const settings = {
      pollIntervalSeconds: 30,
      similarityThreshold: 0.30,
      timeWindowHours: 12,
      soundAlerts: true
    };
    for (const r of rows) {
      try {
        settings[r.key] = JSON.parse(r.value);
      } catch (e) {
        settings[r.key] = r.value;
      }
    }
    return settings;
  }

  updateSettings(newSettings) {
    const upsert = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [k, v] of Object.entries(newSettings)) {
      upsert.run(k, JSON.stringify(v));
    }
    return this.getSettings();
  }

  // === Push Subscriptions (מכשירי סמארטפון וריבוי משתמשים) ===
  savePushSubscription(sub, userAgent = '', subscribedTopics = null) {
    if (!sub || !sub.endpoint || !sub.keys) return false;
    const upsert = this.db.prepare(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, subscribed_topics, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        subscribed_topics = COALESCE(excluded.subscribed_topics, push_subscriptions.subscribed_topics)
    `);
    const topicsJson = subscribedTopics ? JSON.stringify(subscribedTopics) : null;
    upsert.run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent, topicsJson);
    return true;
  }

  updatePushSubscriptionTopics(endpoint, topics) {
    this.db.prepare('UPDATE push_subscriptions SET subscribed_topics = ? WHERE endpoint = ?')
      .run(JSON.stringify(topics), endpoint);
    return true;
  }

  getAllPushSubscriptions() {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions').all();
    return rows.map(r => ({
      endpoint: r.endpoint,
      keys: {
        p256dh: r.p256dh,
        auth: r.auth
      },
      userAgent: r.user_agent,
      subscribedTopics: r.subscribed_topics ? JSON.parse(r.subscribed_topics) : null,
      createdAt: r.created_at
    }));
  }

  removePushSubscription(endpoint) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    return true;
  }
}

export const dbService = new DatabaseService();
