import assert from 'node:assert';
import { NewsDeduplicator } from '../src/services/deduplicator.js';
import { RssPoller } from '../src/services/rssPoller.js';
import { dbService } from '../src/services/db.js';
import { calculateHebrewSimilarity, tokenizeHebrew, getWordStems } from '../src/utils/textProcessor.js';

console.log('--- הרצת בדיקות מנוע Deduplication ו-Clustering לעברית ---');

const deduplicator = new NewsDeduplicator({ similarityThreshold: 0.30, timeWindowHours: 12 });

// בדיקה 1: זיהוי אותו אירוע בכותרות שונות של אתרים שונים (דובאי / סמוטריץ')
{
  const item1 = {
    title: "סמוטריץ': להקצות תקציב מיידי לטיסות החילוץ מדובאי",
    summary: "שר האוצר הנחה לתקצב טיסות חילוץ עבור ישראלים שנתקעו באיחוד האמירויות",
    url: "https://www.ynet.co.il/news/article/111",
    source: "Ynet",
    sourceId: "ynet",
    topicId: "economy",
    pubDate: new Date().toISOString()
  };

  const item2 = {
    title: "כ-10,000 ישראלים ממתינים לשוב ארצה; סמוטריץ' הנחה לתקצב טיסות חילוץ מדובאי",
    summary: "בצלאל סמוטריץ' פועל להחזרת הישראלים שטיסותיהם בוטלו",
    url: "https://www.inn.co.il/flashes/222",
    source: "ערוץ 7",
    sourceId: "inn",
    topicId: "economy",
    pubDate: new Date().toISOString()
  };

  const clusters = [];
  const res1 = deduplicator.processItem(clusters, item1);
  assert.strictEqual(res1.isNew, true, 'ידיעה ראשונה צריכה להיות אירוע חדש');
  clusters.push(res1.cluster);

  const res2 = deduplicator.processItem(clusters, item2);
  assert.strictEqual(res2.isNew, false, 'ידיעה שנייה על אותו אירוע צריכה להיות מזוהה ככפילות ולא להקפיץ התראה');
  assert.strictEqual(res2.cluster.sources.length, 2, 'האשכול צריך להכיל כעת 2 מקורות שונים');
  console.log('✅ בדיקה 1 עברה: איחוד מוצלח של כותרות שונות על טיסות החילוץ מדובאי');
}

// בדיקה 2: זיהוי פיגוע / אירוע ביטחוני עם ניסוחים שונים
{
  const item1 = {
    title: "ניסיון פיגוע דקירה סמוך למחסום קלנדיה: המחבל נוטרל בירי",
    summary: "לוחמי מגב ירו לעבר חשוד ששלף סכין",
    url: "https://news.walla.co.il/item/333",
    source: "וואלה",
    topicId: "security_attacks",
    pubDate: new Date().toISOString()
  };

  const item2 = {
    title: "מחבל חמוש בסכין נוטרל במחסום קלנדיה במהלך ניסיון פיגוע",
    summary: "אין נפגעים לכוחותינו, החשוד נוטרל במקום",
    url: "https://www.mako.co.il/news/444",
    source: "N12",
    topicId: "security_attacks",
    pubDate: new Date().toISOString()
  };

  const clusters = [];
  const res1 = deduplicator.processItem(clusters, item1);
  clusters.push(res1.cluster);

  const res2 = deduplicator.processItem(clusters, item2);
  assert.strictEqual(res2.isNew, false, 'אירוע הפיגוע בקלנדיה חייב להתאחד');
  assert.strictEqual(res2.cluster.sources.length, 2);
  console.log('✅ בדיקה 2 עברה: איחוד מוצלח של אירוע ביטחוני מאתרים שונים');
}

// בדיקה 3: שני אירועים שונים באותו נושא צריכים לייצר שני אשכולות נפרדים
{
  const itemA = {
    title: "יירוט כטב\"ם ששוגר מתימן לעבר אזור אילת והמפרץ",
    summary: "מערכת חץ יירטה בהצלחה מטרה חשודה שהגיעה מים סוף",
    url: "https://www.ynet.co.il/news/555",
    source: "Ynet",
    topicId: "yemen",
    pubDate: new Date().toISOString()
  };

  const itemB = {
    title: "בכירי החות'ים בתימן מזהירים: נתקוף ספינות נוספות בנתיבי השיט הבינלאומיים",
    summary: "דובר הצבא של צנעא הודיע על הרחבת המצור הימי",
    url: "https://www.israelhayom.co.il/news/666",
    source: "ישראל היום",
    topicId: "yemen",
    pubDate: new Date().toISOString()
  };

  const clusters = [];
  const resA = deduplicator.processItem(clusters, itemA);
  clusters.push(resA.cluster);

  const resB = deduplicator.processItem(clusters, itemB);
  assert.strictEqual(resB.isNew, true, 'שני אירועים שונים בנושא תימן צריכים להיות מופרדים');
  assert.strictEqual(clusters.length, 1);
  clusters.push(resB.cluster);
  assert.strictEqual(clusters.length, 2, 'חייבים להיות שני אירועים נפרדים');
  console.log('✅ בדיקה 3 עברה: הבחנה נכונה בין אירועים נפרדים באותו נושא');
}

// בדיקה 4: בדיקת חלון זמן
{
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24 שעות אחורה
  const itemOld = {
    title: "פגישת טראמפ וזלנסקי בוושינגטון",
    url: "https://example.com/old",
    source: "חדשות",
    topicId: "us_politics",
    pubDate: pastDate
  };

  const itemNew = {
    title: "פגישת טראמפ וזלנסקי בוושינגטון",
    url: "https://example.com/new",
    source: "וואלה",
    topicId: "us_politics",
    pubDate: new Date().toISOString()
  };

  const clusters = [];
  const resOld = deduplicator.processItem(clusters, itemOld);
  clusters.push(resOld.cluster);

  const resNew = deduplicator.processItem(clusters, itemNew);
  assert.strictEqual(resNew.isNew, true, 'אירוע שקרה מחוץ לחלון הזמן (מעל 12 שעות) אינו ממוזג');
  console.log('✅ בדיקה 4 עברה: כיבוד חלון הזמן למניעת איחוד חדשות ישנות');
}

// בדיקה 5: סינון ידיעות ישנות מעל 48 שעות בקליטה (מניעת חזרה של חדשות שנמחקו)
{
  const pollerInstance = new RssPoller();
  const hours49Ago = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  const hours2Ago = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  assert.strictEqual(pollerInstance.isItemTooOld(hours49Ago, 48), true, 'ידיעה בת 49 שעות חייבת להיות מסוננת');
  assert.strictEqual(pollerInstance.isItemTooOld(hours2Ago, 48), false, 'ידיעה בת שעתיים חייבת להתקבל');
  assert.strictEqual(pollerInstance.isItemTooOld('', 48), false, 'ידיעה ללא תאריך לא נפסלת סתם');

  const clusters = [];
  let newCalls = 0;
  pollerInstance.handleIngestedItem(
    {
      title: 'ידיעה ישנה על המלחמה וביטחון',
      summary: 'דיווח ישן מלפני יותר מיומיים',
      url: 'https://example.com/old-49h',
      source: 'בדיקה',
      sourceId: 'test',
      pubDate: hours49Ago
    },
    clusters,
    [{ id: 'security', title: 'ביטחון', keywords: ['ביטחון'], enabled: true }],
    () => newCalls++,
    () => {}
  );
  assert.strictEqual(newCalls, 0, 'handleIngestedItem לא אמורה לקלוט ידיעה בת מעל 48 שעות');
  console.log('✅ בדיקה 5 עברה: סינון ידיעות ישנות מעל 48 שעות בעת קליטה');
}

// בדיקה 6: ניקוי אוטומטי מה-DB של אירועים מעל 48 שעות ושמירת אירועים חדשים
{
  const oldId = `test_old_${Date.now()}`;
  const freshId = `test_fresh_${Date.now()}`;
  const hours50Ago = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
  const hours1Ago = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

  dbService.saveClusters([
    {
      id: oldId,
      topicId: 'test_topic',
      topicTitle: 'בדיקה',
      title: 'אירוע בדיקה ישן מעל 48 שעות',
      summary: '',
      firstReportedAt: hours50Ago,
      lastUpdatedAt: hours50Ago,
      alertSent: true,
      sources: [{ title: 'ישן', url: `https://example.com/${oldId}`, source: 'בדיקה', sourceId: 'test', pubDate: hours50Ago }]
    },
    {
      id: freshId,
      topicId: 'test_topic',
      topicTitle: 'בדיקה',
      title: 'אירוע בדיקה טרי מהשעה האחרונה',
      summary: '',
      firstReportedAt: hours1Ago,
      lastUpdatedAt: hours1Ago,
      alertSent: true,
      sources: [{ title: 'טרי', url: `https://example.com/${freshId}`, source: 'בדיקה', sourceId: 'test', pubDate: hours1Ago }]
    }
  ]);

  dbService.pruneOldClusters(48);
  const remainingIds = new Set(dbService.getClusters().map(c => c.id));
  assert.strictEqual(remainingIds.has(oldId), false, 'אירוע בן 50 שעות חייב להימחק מה-DB');
  assert.strictEqual(remainingIds.has(freshId), true, 'אירוע בן שעה חייב להישאר ב-DB');

  // ניקוי רשומת הבדיקה הטרייה
  dbService.deleteCluster(freshId);

  const cloudStatus = dbService.getCloudStatus();
  assert.strictEqual(cloudStatus.retentionHours, 48, 'מדיניות השמירה צריכה להיות 48 שעות');
  console.log('✅ בדיקה 6 עברה: מחיקה אוטומטית מה-DB של אירועים מעל 48 שעות');
}

console.log('\n🎉 כל 6 בדיקות היחידה עברו בהצלחה מושלמת!');
