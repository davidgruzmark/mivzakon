import { calculateHebrewSimilarity, tokenizeHebrew, getWordStems } from '../utils/textProcessor.js';

export class NewsDeduplicator {
  constructor(options = {}) {
    this.similarityThreshold = options.similarityThreshold || 0.30;
    this.timeWindowHours = options.timeWindowHours || 12;
  }

  /**
   * בודק האם שתי כותרות/ידיעות מדברות על אותו אירוע בדיוק
   */
  isSameEvent(item1, item2) {
    if (!item1 || !item2) return false;

    // התאמת כותרות
    const titleSim = calculateHebrewSimilarity(item1.title, item2.title);
    if (titleSim >= 0.70) return true; // כמעט זהה לחלוטין

    // התאמת כותרת מול גוף/תקציר הידיעה
    const summarySim = calculateHebrewSimilarity(item1.summary || '', item2.summary || '');

    // חפיפת מילים משמעותיות
    const stems1 = getWordStems(tokenizeHebrew(item1.title));
    const stems2 = getWordStems(tokenizeHebrew(item2.title));
    
    let sharedStems = 0;
    for (const s of stems1) {
      if (stems2.has(s)) sharedStems++;
    }

    // אם יש לפחות 3 שורשים/מילות מפתח משמעותיות משותפות בכותרת (למשל: סמוטריץ', דובאי, טיסות)
    if (sharedStems >= 3 && titleSim >= 0.25) {
      return true;
    }

    // אם מדד הדמיון המשוקלל עולה על הסף
    if (titleSim >= this.similarityThreshold) {
      return true;
    }

    // חפיפה משולבת של כותרת + תקציר
    if (titleSim >= 0.22 && summarySim >= 0.25) {
      return true;
    }

    return false;
  }

  /**
   * מקבל ידיעה חדשה ומאגר אשכולות אירועים קיים, ובודק האם לשייך לאשכול קיים או לפתוח אשכול חדש
   */
  processItem(existingClusters, newItem) {
    const itemDate = new Date(newItem.pubDate || Date.now()).getTime();

    // 1. חיפוש באשכולות קיימים
    for (const cluster of existingClusters) {
      // בדיקת חלון זמן
      const clusterFirstTime = new Date(cluster.firstReportedAt).getTime();
      const hoursDiff = Math.abs(itemDate - clusterFirstTime) / (1000 * 60 * 60);

      if (hoursDiff > this.timeWindowHours) {
        continue; // אירוע מחוץ לחלון הזמן
      }

      // בדיקת התאמת נושא (אם שניהם מוגדרים, עדיף שיהיו באותו נושא)
      if (cluster.topicId && newItem.topicId && cluster.topicId !== newItem.topicId) {
        continue;
      }

      // בדיקה אם הקישור כבר שמור בדיוק באותו אשכול
      const urlExists = cluster.sources.some(s => s.url === newItem.url);
      if (urlExists) {
        return { matched: true, cluster, isNew: false, alreadyRecorded: true };
      }

      // בדיקת דמיון מול כותרת האשכול ומול כל המקורות שכבר נאספו תחתיו
      let matchedCluster = false;
      if (this.isSameEvent({ title: cluster.title, summary: cluster.summary }, newItem)) {
        matchedCluster = true;
      } else {
        // בודקים האם מתאים לאחד המקורות האחרים שצורפו לאשכול
        for (const source of cluster.sources) {
          if (this.isSameEvent(source, newItem)) {
            matchedCluster = true;
            break;
          }
        }
      }

      if (matchedCluster) {
        // האירוע כבר הותרא בעבר! מצרפים את המקור הנוסף לאשכול הקיים
        cluster.sources.push({
          title: newItem.title,
          url: newItem.url,
          source: newItem.source,
          sourceId: newItem.sourceId,
          pubDate: newItem.pubDate
        });
        cluster.lastUpdatedAt = new Date().toISOString();
        return { matched: true, cluster, isNew: false, alreadyRecorded: false };
      }
    }

    // 2. לא נמצא אשכול תואם -> זהו אירוע חדש לגמרי!
    const newCluster = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      topicId: newItem.topicId,
      topicTitle: newItem.topicTitle,
      title: newItem.title,
      summary: newItem.summary || '',
      firstReportedAt: newItem.pubDate || new Date().toISOString(),
      lastUpdatedAt: newItem.pubDate || new Date().toISOString(),
      sources: [
        {
          title: newItem.title,
          url: newItem.url,
          source: newItem.source,
          sourceId: newItem.sourceId,
          pubDate: newItem.pubDate
        }
      ],
      alertSent: true
    };

    return { matched: false, cluster: newCluster, isNew: true, alreadyRecorded: false };
  }
}
