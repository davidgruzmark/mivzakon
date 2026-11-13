import { poller } from '../src/services/rssPoller.js';
import { storage } from '../src/services/storage.js';

console.log('--- בדיקת אינטגרציה מלאה (סריקה של כל מקורות המבזקים) ---');

async function runE2ETest() {
  console.log('מפעיל סריקה יחידה של כל המקורות...');
  await poller.pollAll();

  const stats = poller.getStats();
  const clusters = storage.getClusters();

  console.log('\n--- תוצאות הסריקה ---');
  console.log(`סה"כ מבזקים שנסרקו: ${stats.totalItemsChecked}`);
  console.log(`אירועים פעילים שנשמרו: ${clusters.length}`);
  console.log(`כפילויות שנמנעו: ${stats.dedupedCount}`);

  console.log('\nפירוט אירועים שנקלטו:');
  for (const c of clusters.slice(0, 5)) {
    console.log(`- [${c.topicTitle}] ${c.title} (מקורות: ${c.sources.map(s => s.source).join(', ')})`);
  }

  console.log('\nסטטוס מקורות חדשות:');
  for (const [id, health] of Object.entries(stats.sourcesHealth)) {
    console.log(`  ${health.name}: ${health.status === 'ok' ? '✅ תקין (' + health.itemCount + ' פריטים)' : '❌ שגיאה (' + health.error + ')'}`);
  }

  console.log('\n🎉 בדיקת האינטגרציה הסתיימה בהצלחה!');
  process.exit(0);
}

runE2ETest().catch(err => {
  console.error('שגיאה בבדיקת אינטגרציה:', err);
  process.exit(1);
});
