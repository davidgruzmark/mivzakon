import Parser from 'rss-parser';
import zlib from 'zlib';
import { ISRAELI_NEWS_SOURCES } from '../config/sources.js';
import { storage } from './storage.js';
import { NewsDeduplicator } from './deduplicator.js';
import { notifier } from './notifier.js';
import {
  stripAndDecodeHtml,
  normalizeHebrewQuotes,
  containsHebrewKeyword
} from '../utils/textProcessor.js';
import { telegramPoller, TELEGRAM_CHANNELS } from './telegramPoller.js';
import { aiClassifier } from './aiClassifier.js';

const SECURITY_TOPIC_IDS = new Set(['security_attacks', 'lebanon', 'yemen', 'hostages']);
const SECURITY_NOISE_REGEX = /(בורסה|וול סטריט|דאו ג'ונס|נאסד"ק|מניית|ענני עדשה|צלחת מעופפת)/;
const METAPHOR_NOISE_REGEX = /(הפגישה עם נתניהו - פיגוע|פיגוע פוליטי|פיגוע כלכלי|פיגוע תדמיתי)/;

export class RssPoller {
  constructor() {
    this.parser = new Parser({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 10000
    });

    this.settings = storage.getSettings();
    this.deduplicator = new NewsDeduplicator({
      similarityThreshold: this.settings.similarityThreshold || 0.30,
      timeWindowHours: this.settings.timeWindowHours || 12
    });

    this.isPolling = false;
    this.timer = null;
    this.aiRejectedUrls = new Set();
    this.sourcesHealth = {};
    this.stats = {
      lastPollTime: null,
      totalScans: 0,
      totalItemsChecked: 0,
      newAlertsCount: 0,
      dedupedCount: 0
    };
  }

  start() {
    this.settings = storage.getSettings();
    this.revalidateExistingClusters();

    const intervalSec = this.settings.pollIntervalSeconds || 20;
    const aiMode = aiClassifier.isEnabled() ? ' + אימות Gemini AI' : '';
    console.log(`[RssPoller] מפעיל סורק מבזקים מהיר (כל ${intervalSec} שניות) הכולל RSS וטלגרם${aiMode}...`);
    
    this.pollAll();

    this.timer = setInterval(() => {
      this.pollAll();
    }, intervalSec * 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async fetchAndParseFeed(url) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        throw new Error(`Status code ${res.status}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      // בדיקה אם השרת החזיר gzip גולמי גם אם הכותרת חסרה
      const xmlText = (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)
        ? zlib.gunzipSync(buf).toString('utf8')
        : buf.toString('utf8');

      return await this.parser.parseString(xmlText);
    } catch (fetchErr) {
      return await this.parser.parseURL(url);
    }
  }

  matchTopic(item, activeTopics) {
    const normalizedTitle = normalizeHebrewQuotes(item.title || '').toLowerCase();
    const normalizedSummary = normalizeHebrewQuotes(item.summary || '').toLowerCase();
    const combinedText = `${normalizedTitle} ${normalizedSummary}`;

    const isSecurityNoise = SECURITY_NOISE_REGEX.test(combinedText);
    const isMetaphorNoise = METAPHOR_NOISE_REGEX.test(combinedText);

    let bestTopic = null;
    let bestScore = 0;

    for (const topic of activeTopics) {
      if (!topic.enabled) continue;
      if (isSecurityNoise && SECURITY_TOPIC_IDS.has(topic.id)) continue;

      let score = 0;
      for (const kw of topic.keywords || []) {
        const normalizedKw = normalizeHebrewQuotes(kw).toLowerCase().trim();
        if (!normalizedKw) continue;
        if (isMetaphorNoise && normalizedKw.includes('פיגוע')) continue;

        const isPhrase = normalizedKw.includes(' ');
        if (containsHebrewKeyword(normalizedTitle, normalizedKw)) {
          score += isPhrase ? 5 : 3;
        } else if (normalizedSummary && containsHebrewKeyword(normalizedSummary, normalizedKw)) {
          score += isPhrase ? 2 : 1;
        }
      }

      if (score >= 2 && score > bestScore) {
        bestScore = score;
        bestTopic = topic;
      }
    }

    return bestTopic;
  }

  revalidateExistingClusters() {
    const activeTopics = storage.getTopics().filter(t => t.enabled);
    const existing = storage.getClusters({ sort: 'asc' });
    if (existing.length === 0) return;

    let deletedCount = 0;
    let reclassifiedCount = 0;
    let mergedCount = 0;
    const cleanedClusters = [];

    for (const cluster of existing) {
      const matchedTopic = this.matchTopic(cluster, activeTopics);
      if (!matchedTopic) {
        storage.deleteCluster(cluster.id);
        deletedCount++;
        continue;
      }

      if (cluster.topicId !== matchedTopic.id || cluster.topicTitle !== matchedTopic.title) {
        reclassifiedCount++;
      }

      // סינון מקורות כפולים מאותו אתר+כותרת בתוך אותו אשכול
      const uniqueSources = [];
      for (const src of cluster.sources || []) {
        const dup = uniqueSources.some(
          u => u.url === src.url || (u.sourceId && src.sourceId && u.sourceId === src.sourceId && u.title === src.title)
        );
        if (!dup) uniqueSources.push(src);
      }

      const candidate = {
        ...cluster,
        topicId: matchedTopic.id,
        topicTitle: matchedTopic.title,
        sources: uniqueSources
      };

      // בדיקה אם קיים כבר אשכול זהה שאפשר לאחד אליו
      let mergedIntoExisting = false;
      for (const target of cleanedClusters) {
        if (target.topicId && candidate.topicId && target.topicId !== candidate.topicId) continue;
        const t1 = new Date(target.firstReportedAt).getTime();
        const t2 = new Date(candidate.firstReportedAt).getTime();
        if (Math.abs(t2 - t1) / (1000 * 60 * 60) > this.deduplicator.timeWindowHours) continue;

        if (this.deduplicator.isSameEvent({ title: target.title, summary: target.summary }, { title: candidate.title, summary: candidate.summary })) {
          for (const s of candidate.sources) {
            const exists = target.sources.some(
              ts => ts.url === s.url || (ts.sourceId && s.sourceId && ts.sourceId === s.sourceId && ts.title === s.title)
            );
            if (!exists) target.sources.push(s);
          }
          target.lastUpdatedAt = candidate.lastUpdatedAt > target.lastUpdatedAt ? candidate.lastUpdatedAt : target.lastUpdatedAt;
          storage.saveClusters([target]);
          storage.deleteCluster(candidate.id);
          mergedCount++;
          mergedIntoExisting = true;
          break;
        }
      }

      if (!mergedIntoExisting) {
        cleanedClusters.push(candidate);
        storage.saveClusters([candidate]);
      }
    }

    if (deletedCount > 0 || reclassifiedCount > 0 || mergedCount > 0) {
      console.log(
        `✨ [Revalidate] נוקו ${deletedCount} התראות שווא, סווגו מחדש ${reclassifiedCount} אירועים, ואוחדו ${mergedCount} כפילויות.`
      );
    }
  }

  isItemTooOld(pubDateIso, retentionHours = 48) {
    if (!pubDateIso) return false;
    const itemTime = new Date(pubDateIso).getTime();
    if (Number.isNaN(itemTime)) return false;
    const cutoffMs = retentionHours * 60 * 60 * 1000;
    return (Date.now() - itemTime) > cutoffMs;
  }

  async handleIngestedItem(item, clusters, activeTopics, onNew, onDedup) {
    const retentionHours = this.settings.retentionHours || 48;
    if (this.isItemTooOld(item.pubDate, retentionHours)) {
      return; // מתעלמים מידיעות ישנות מעל 48 שעות כדי שלא ייקלטו מחדש אחרי מחיקה אוטומטית
    }

    let matchedTopic = this.matchTopic(item, activeTopics);
    if (!matchedTopic) return;

    if (aiClassifier.isEnabled()) {
      const alreadyStored = item.url && clusters.some(c => (c.sources || []).some(s => s.url === item.url));
      if (!alreadyStored) {
        if (item.url && this.aiRejectedUrls.has(item.url)) return;
        matchedTopic = await aiClassifier.verifyTopicMatch(item, matchedTopic, activeTopics);
        if (!matchedTopic) {
          if (item.url) {
            if (this.aiRejectedUrls.size > 1000) this.aiRejectedUrls.clear();
            this.aiRejectedUrls.add(item.url);
          }
          return;
        }
      }
    }

    item.topicId = matchedTopic.id;
    item.topicTitle = matchedTopic.title;

    const result = this.deduplicator.processItem(clusters, item);

    if (result.isNew) {
      if (onNew) onNew();
      this.stats.newAlertsCount++;
      clusters.unshift(result.cluster);

      clusters.sort((a, b) => {
        const timeA = new Date(a.firstReportedAt || a.lastUpdatedAt || 0).getTime();
        const timeB = new Date(b.firstReportedAt || b.lastUpdatedAt || 0).getTime();
        return timeB - timeA;
      });

      if (clusters.length > 400) {
        clusters = clusters.slice(0, 400);
      }

      storage.saveClusters([result.cluster]);
      notifier.notifyNewAlert(result.cluster);
    } else if (result.matched && !result.alreadyRecorded) {
      if (onDedup) onDedup();
      this.stats.dedupedCount++;

      clusters.sort((a, b) => {
        const timeA = new Date(a.firstReportedAt || a.lastUpdatedAt || 0).getTime();
        const timeB = new Date(b.firstReportedAt || b.lastUpdatedAt || 0).getTime();
        return timeB - timeA;
      });

      storage.saveClusters([result.cluster]);
      notifier.notifyClusterUpdated(result.cluster, item);
    }
  }

  async pollAll() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const retentionHours = this.settings.retentionHours || 48;
      storage.pruneOldClusters(retentionHours);

      const activeTopics = storage.getTopics().filter(t => t.enabled);
      let clusters = storage.getClusters();
      let newAlertsThisRun = 0;
      let dedupedThisRun = 0;
      let itemsCheckedThisRun = 0;

      notifier.notifyStatus({ isScanning: true, message: 'סורק מבזקים וטלגרם כעת...' });

      // 1. סריקת ערוצי טלגרם רשמיים למבזקים מהירים ראשוניים
      for (const tg of TELEGRAM_CHANNELS) {
        if (!tg.enabled) continue;
        try {
          const tgItems = await telegramPoller.fetchChannel(tg.channel);
          this.sourcesHealth[tg.id] = {
            status: 'ok',
            name: tg.name,
            lastChecked: new Date().toISOString(),
            itemCount: tgItems.length
          };

          for (const item of tgItems) {
            itemsCheckedThisRun++;
            const normalizedItem = {
              title: item.title,
              summary: item.summary,
              url: item.url,
              source: tg.name,
              sourceId: tg.id,
              pubDate: item.pubDate
            };
            await this.handleIngestedItem(
              normalizedItem,
              clusters,
              activeTopics,
              () => newAlertsThisRun++,
              () => dedupedThisRun++
            );
          }
        } catch (tgErr) {
          this.sourcesHealth[tg.id] = {
            status: 'error',
            name: tg.name,
            lastChecked: new Date().toISOString(),
            error: tgErr.message
          };
        }
      }

      // 2. סריקת אתרי החדשות המובילים (RSS)
      for (const source of ISRAELI_NEWS_SOURCES) {
        if (!source.enabled) continue;

        try {
          const feed = await this.fetchAndParseFeed(source.url);
          this.sourcesHealth[source.id] = {
            status: 'ok',
            name: source.name,
            lastChecked: new Date().toISOString(),
            itemCount: feed.items ? feed.items.length : 0
          };

          const items = (feed.items || []).slice(0, 20);

          for (const rawItem of items) {
            itemsCheckedThisRun++;

            let cleanTitle = stripAndDecodeHtml(rawItem.title || '');
            let cleanSummary = stripAndDecodeHtml(rawItem.contentSnippet || rawItem.content || rawItem.description || '');

            if (!cleanTitle) continue;

            // ניקוי סיומת שם האתר וכותרות לא קשורות מתוך תיאור של Google News
            if (source.id === 'google_news_il') {
              cleanTitle = cleanTitle.replace(/\s+-\s+[^-]+$/, '').trim();
              cleanSummary = '';
            }

            const normalizedItem = {
              title: cleanTitle,
              summary: cleanSummary,
              url: rawItem.link || rawItem.guid,
              source: source.name,
              sourceId: source.id,
              pubDate: rawItem.pubDate ? new Date(rawItem.pubDate).toISOString() : new Date().toISOString()
            };

            await this.handleIngestedItem(
              normalizedItem,
              clusters,
              activeTopics,
              () => newAlertsThisRun++,
              () => dedupedThisRun++
            );
          }
        } catch (sourceErr) {
          this.sourcesHealth[source.id] = {
            status: 'error',
            name: source.name,
            lastChecked: new Date().toISOString(),
            error: sourceErr.message
          };
        }
      }

      this.stats.lastPollTime = new Date().toISOString();
      this.stats.totalScans++;
      this.stats.totalItemsChecked += itemsCheckedThisRun;

      notifier.notifyStatus({
        isScanning: false,
        lastPollTime: this.stats.lastPollTime,
        activeClusters: clusters.length,
        newAlertsThisRun,
        dedupedThisRun,
        sourcesHealth: this.sourcesHealth
      });

    } catch (err) {
      console.error('[RssPoller] שגיאה כללית בסריקה:', err);
    } finally {
      this.isPolling = false;
    }
  }

  getStats() {
    return {
      ...this.stats,
      sourcesHealth: this.sourcesHealth
    };
  }
}

export const poller = new RssPoller();
