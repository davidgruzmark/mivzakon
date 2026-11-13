import Parser from 'rss-parser';
import { ISRAELI_NEWS_SOURCES } from '../config/sources.js';
import { storage } from './storage.js';
import { NewsDeduplicator } from './deduplicator.js';
import { notifier } from './notifier.js';
import { stripAndDecodeHtml, normalizeHebrewQuotes } from '../utils/textProcessor.js';
import { telegramPoller, TELEGRAM_CHANNELS } from './telegramPoller.js';

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
    const intervalSec = this.settings.pollIntervalSeconds || 20;
    console.log(`[RssPoller] מפעיל סורק מבזקים מהיר (כל ${intervalSec} שניות) הכולל RSS וטלגרם...`);
    
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

  matchTopic(item, activeTopics) {
    const rawContent = `${item.title} ${item.summary || ''}`;
    const normalizedContent = normalizeHebrewQuotes(rawContent).toLowerCase();

    for (const topic of activeTopics) {
      if (!topic.enabled) continue;

      for (const kw of topic.keywords) {
        const normalizedKw = normalizeHebrewQuotes(kw).toLowerCase().trim();
        if (!normalizedKw) continue;

        if (normalizedContent.includes(normalizedKw)) {
          return topic;
        }
      }
    }

    return null;
  }

  handleIngestedItem(item, clusters, activeTopics, onNew, onDedup) {
    const matchedTopic = this.matchTopic(item, activeTopics);
    if (!matchedTopic) return;

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

      storage.saveClusters(clusters);
      notifier.notifyNewAlert(result.cluster);
    } else if (result.matched && !result.alreadyRecorded) {
      if (onDedup) onDedup();
      this.stats.dedupedCount++;

      clusters.sort((a, b) => {
        const timeA = new Date(a.firstReportedAt || a.lastUpdatedAt || 0).getTime();
        const timeB = new Date(b.firstReportedAt || b.lastUpdatedAt || 0).getTime();
        return timeB - timeA;
      });

      storage.saveClusters(clusters);
      notifier.notifyClusterUpdated(result.cluster, item);
    }
  }

  async pollAll() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
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
            this.handleIngestedItem(
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
          const feed = await this.parser.parseURL(source.url);
          this.sourcesHealth[source.id] = {
            status: 'ok',
            name: source.name,
            lastChecked: new Date().toISOString(),
            itemCount: feed.items ? feed.items.length : 0
          };

          const items = (feed.items || []).slice(0, 20);

          for (const rawItem of items) {
            itemsCheckedThisRun++;

            const cleanTitle = stripAndDecodeHtml(rawItem.title || '');
            const cleanSummary = stripAndDecodeHtml(rawItem.contentSnippet || rawItem.content || rawItem.description || '');

            if (!cleanTitle) continue;

            const normalizedItem = {
              title: cleanTitle,
              summary: cleanSummary,
              url: rawItem.link || rawItem.guid,
              source: source.name,
              sourceId: source.id,
              pubDate: rawItem.pubDate ? new Date(rawItem.pubDate).toISOString() : new Date().toISOString()
            };

            this.handleIngestedItem(
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
