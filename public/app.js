// State
let allEvents = [];
let allTopics = [];
let soundEnabled = true;
let currentFilterTopic = 'all';
let currentSortOrder = 'desc';
let searchQuery = '';
let editingTopicId = null;
let editingKeywords = [];

// Web Audio API chime synthesizer for notifications
function playChime() {
  if (!soundEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    const now = ctx.currentTime;
    // Tone 1
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.12, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Tone 2
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.00, now + 0.12); // A5
    gain2.gain.setValueAtTime(0.15, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.55);
  } catch (e) {
    // User hasn't interacted with audio yet
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function registerPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch('/api/push/public-key');
    const { publicKey } = await res.json();
    if (!publicKey) return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub })
    });
    console.log('[WebPush] המכשיר נרשם בהצלחה להתראות Push!');
  } catch (err) {
    console.warn('[WebPush] שגיאה ברישום Push:', err);
  }
}

// Request and toggle desktop & mobile push notification permission
function toggleNotifications() {
  if (!('Notification' in window)) {
    alert('הדפדפן שלך אינו תומך בהתראות.');
    return;
  }

  if (Notification.permission === 'granted') {
    registerPushSubscription();
    new Notification('מערכת מבזקון פעילה', {
      body: 'התראות פעילות עבור מכשיר זה',
      icon: '/icons/icon-192.png'
    });
    updateNotifyButtonUI('granted');
    return;
  }

  Notification.requestPermission().then(permission => {
    updateNotifyButtonUI(permission);
    if (permission === 'granted') {
      registerPushSubscription();
      new Notification('התראות מבזקון הופעלו בהצלחה!', {
        body: 'תקבל התראה אחת בלבד עבור כל אירוע חדש',
        icon: '/icons/icon-192.png'
      });
      playChime();
    }
  });
}

function updateNotifyButtonUI(permission) {
  const btn = document.getElementById('notifyBtn');
  const text = document.getElementById('notifyText');
  const icon = document.getElementById('notifyIcon');

  if (permission === 'granted') {
    text.innerText = 'התראות פעילות ✅';
    icon.innerText = '🔔';
    btn.className = 'bg-slate-800 hover:bg-slate-700 border border-emerald-500/40 text-emerald-400 text-xs px-3.5 py-2 rounded-xl transition flex items-center gap-2';
  } else if (permission === 'denied') {
    text.innerText = 'התראות חסומות ❌';
    icon.innerText = '🔕';
    btn.className = 'bg-slate-800 border border-rose-500/40 text-rose-400 text-xs px-3.5 py-2 rounded-xl transition flex items-center gap-2 cursor-not-allowed';
  } else {
    text.innerText = 'הפעל התראות דסקטופ';
    icon.innerText = '🔔';
    btn.className = 'bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs px-3.5 py-2 rounded-xl transition flex items-center gap-2 shadow-lg shadow-blue-600/20';
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  const icon = document.getElementById('soundIcon');
  const text = document.getElementById('soundText');
  if (soundEnabled) {
    icon.innerText = '🔊';
    text.innerText = 'צליל פעיל';
    playChime();
  } else {
    icon.innerText = '🔇';
    text.innerText = 'צליל מושתק';
  }
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);

  if (diffSec < 60) return 'עכשיו';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `לפני ${diffMin} דק'`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `לפני ${diffHours} שע'`;
  return date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Render Functions
function renderTopics() {
  const container = document.getElementById('topicsContainer');
  const select = document.getElementById('filterTopicSelect');

  container.innerHTML = allTopics.map(topic => {
    const kwPreview = topic.keywords.join(', ');
    const kwCount = topic.keywords.length;

    return `
      <div title="מילות מפתח: ${kwPreview}" class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs transition shadow-sm ${
        topic.enabled 
          ? (topic.badgeColor || 'border-blue-500/30 text-blue-300 bg-blue-500/10') 
          : 'border-slate-800 text-slate-500 bg-slate-950/60 line-through opacity-60'
      }">
        <!-- הפעלה / כיבוי של הנושא -->
        <span onclick="toggleTopic('${topic.id}', ${!topic.enabled})" class="font-semibold select-none cursor-pointer hover:underline" title="לחץ להפעלה או השבתה">
          ${topic.title}
        </span>

        <!-- מונה מילות מפתח -->
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 border border-slate-700/60 font-mono">
          ${kwCount} מילים
        </span>

        <!-- כפתור עריכת מילות מפתח -->
        <button onclick="openEditTopicModal('${topic.id}')" title="צפה וערוך את מילות המפתח" class="text-blue-400 hover:text-blue-200 transition font-medium px-1 py-0.5 rounded hover:bg-slate-800 flex items-center gap-1">
          <span>✏️</span>
          <span class="text-[11px] underline">ערוך</span>
        </button>

        <!-- מחיקת נושא -->
        <button onclick="deleteTopic('${topic.id}')" title="מחק נושא" class="text-slate-500 hover:text-rose-400 font-bold leading-none p-1 rounded hover:bg-slate-800">&times;</button>
      </div>
    `;
  }).join('');

  // עדכון ה-Dropdown
  select.innerHTML = '<option value="all">כל הנושאים</option>' + allTopics.map(t => `
    <option value="${t.id}" ${currentFilterTopic === t.id ? 'selected' : ''}>${t.title}</option>
  `).join('');
}

function renderEvents() {
  const container = document.getElementById('eventsContainer');

  let filtered = allEvents;
  if (currentFilterTopic !== 'all') {
    filtered = filtered.filter(e => e.topicId === currentFilterTopic);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(e => 
      e.title.toLowerCase().includes(q) || 
      (e.summary && e.summary.toLowerCase().includes(q))
    );
  }

  // מיון כרונולוגי לפי זמן הידיעה (מהחדש לישן או מהישן לחדש)
  filtered.sort((a, b) => {
    const timeA = new Date(a.firstReportedAt || a.lastUpdatedAt || 0).getTime();
    const timeB = new Date(b.firstReportedAt || b.lastUpdatedAt || 0).getTime();
    return currentSortOrder === 'asc' ? timeA - timeB : timeB - timeA;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="text-center py-16 border border-dashed border-slate-800 rounded-2xl bg-slate-900/30">
        <div class="text-3xl mb-2">🔍</div>
        <div class="text-slate-300 font-medium mb-1">לא נמצאו אירועים מתאימים</div>
        <div class="text-xs text-slate-500">המערכת ממשיכה לנטר ברקע. ברגע שיפורסם מבזק רלוונטי תקפוץ התראה.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(evt => {
    const isMultiSource = evt.sources && evt.sources.length > 1;
    const timeFormatted = formatRelativeTime(evt.firstReportedAt);
    const lastUpdatedFormatted = evt.lastUpdatedAt && evt.lastUpdatedAt !== evt.firstReportedAt
      ? formatRelativeTime(evt.lastUpdatedAt)
      : null;

    return `
      <article class="bg-slate-900 border border-slate-800 hover:border-slate-700/80 rounded-2xl p-5 transition shadow-sm relative group">
        <!-- ראש כרטיסייה: נושא וזמן -->
        <div class="flex items-center justify-between gap-2 mb-2.5">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full border border-blue-500/20 text-blue-300 bg-blue-500/10">
              ${evt.topicTitle}
            </span>
            ${isMultiSource ? `
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                🛡️ אוחד מ-${evt.sources.length} אתרים
              </span>
            ` : ''}
          </div>

          <div class="flex items-center gap-3">
            <span class="text-xs text-slate-400" title="דיווח ראשוני: ${new Date(evt.firstReportedAt).toLocaleTimeString('he-IL')}">
              ${timeFormatted}
            </span>
            <button onclick="deleteEvent('${evt.id}')" title="הסר אירוע מהפיד" class="text-slate-500 hover:text-rose-400 text-xs transition opacity-0 group-hover:opacity-100">
              🗑️
            </button>
          </div>
        </div>

        <!-- כותרת הידיעה -->
        <h3 class="text-base md:text-lg font-bold text-white mb-2 leading-relaxed">
          ${evt.title}
        </h3>

        <!-- תקציר הידיעה (אם קיים) -->
        ${evt.summary ? `
          <p class="text-slate-300 text-sm mb-4 leading-relaxed line-clamp-3">
            ${evt.summary}
          </p>
        ` : ''}

        <!-- תחתית הכרטיסייה: מקורות וקישורים ישירים -->
        <div class="border-t border-slate-800/80 pt-3.5 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-xs text-slate-400 font-medium ml-1">מקורות:</span>
            ${evt.sources.map(s => `
              <a href="${s.url}" target="_blank" rel="noopener noreferrer" class="bg-slate-800 hover:bg-slate-700/80 border border-slate-700/60 text-slate-200 text-xs px-2.5 py-1 rounded-lg transition flex items-center gap-1.5 shadow-sm">
                <span>🔗</span>
                <span class="font-medium">${s.source}</span>
              </a>
            `).join('')}
          </div>

          ${lastUpdatedFormatted ? `
            <div class="text-[11px] text-slate-500">
              דיווח אחרון: ${lastUpdatedFormatted}
            </div>
          ` : ''}
        </div>
      </article>
    `;
  }).join('');
}

function updateStats(stats) {
  if (!stats) return;
  if (stats.totalClustersCount !== undefined) {
    document.getElementById('statEventsCount').innerText = stats.totalClustersCount;
  }
  if (stats.dedupedCount !== undefined) {
    document.getElementById('statDedupedCount').innerText = stats.dedupedCount;
  }
  if (stats.totalItemsChecked !== undefined) {
    document.getElementById('statScannedCount').innerText = stats.totalItemsChecked;
  }
  if (stats.lastPollTime) {
    document.getElementById('lastPollTimeText').innerText = `סריקה אחרונה: ${new Date(stats.lastPollTime).toLocaleTimeString('he-IL')}`;
  }
}

// User Actions
async function triggerManualPoll() {
  const icon = document.getElementById('pollIcon');
  icon.classList.add('animate-spin');
  try {
    await fetch('/api/poll-now', { method: 'POST' });
    setTimeout(() => icon.classList.remove('animate-spin'), 1500);
  } catch (err) {
    icon.classList.remove('animate-spin');
  }
}

function toggleTopicForm() {
  const form = document.getElementById('addTopicForm');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    document.getElementById('newTopicTitle').focus();
  }
}

async function handleCreateTopic(e) {
  e.preventDefault();
  const titleInput = document.getElementById('newTopicTitle');
  const keywordsInput = document.getElementById('newTopicKeywords');

  const title = titleInput.value.trim();
  const keywords = keywordsInput.value.trim();
  if (!title || !keywords) return;

  try {
    const res = await fetch('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, keywords })
    });
    const newTopic = await res.json();
    allTopics.push(newTopic);
    renderTopics();
    titleInput.value = '';
    keywordsInput.value = '';
    toggleTopicForm();
  } catch (err) {
    console.error('Failed to create topic:', err);
  }
}

async function toggleTopic(id, enabled) {
  try {
    await fetch(`/api/topics/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const topic = allTopics.find(t => t.id === id);
    if (topic) topic.enabled = enabled;
    renderTopics();
  } catch (err) {
    console.error('Failed to toggle topic:', err);
  }
}

async function deleteTopic(id) {
  if (!confirm('האם אתה בטוח שברצונך להסיר נושא מעקב זה?')) return;
  try {
    await fetch(`/api/topics/${id}`, { method: 'DELETE' });
    allTopics = allTopics.filter(t => t.id !== id);
    renderTopics();
  } catch (err) {
    console.error('Failed to delete topic:', err);
  }
}

// ניהול מודל עריכת מילות מפתח
function openEditTopicModal(id) {
  const topic = allTopics.find(t => t.id === id);
  if (!topic) return;

  editingTopicId = id;
  editingKeywords = [...topic.keywords];

  document.getElementById('editTopicTitle').value = topic.title;
  document.getElementById('newKeywordInput').value = '';
  renderEditModalKeywords();

  const modal = document.getElementById('editTopicModal');
  modal.classList.remove('hidden');
}

function closeEditTopicModal() {
  const modal = document.getElementById('editTopicModal');
  modal.classList.add('hidden');
  editingTopicId = null;
  editingKeywords = [];
}

function renderEditModalKeywords() {
  const container = document.getElementById('editKeywordsBadges');
  const countBadge = document.getElementById('keywordCountBadge');
  countBadge.innerText = `${editingKeywords.length} מילים`;

  if (editingKeywords.length === 0) {
    container.innerHTML = '<span class="text-xs text-slate-500 py-2">אין מילות מפתח. הוסף לפחות מילת מפתח אחת.</span>';
    return;
  }

  container.innerHTML = editingKeywords.map((kw, idx) => `
    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200">
      <span>${kw}</span>
      <button type="button" onclick="removeKeywordFromEditModal(${idx})" class="text-slate-400 hover:text-rose-400 font-bold leading-none p-0.5" title="הסר מילת מפתח">&times;</button>
    </span>
  `).join('');
}

function removeKeywordFromEditModal(index) {
  editingKeywords.splice(index, 1);
  renderEditModalKeywords();
}

function addKeywordToEditModal() {
  const input = document.getElementById('newKeywordInput');
  const raw = input.value.trim();
  if (!raw) return;

  const addedWords = raw
    .split(',')
    .map(w => w.trim())
    .filter(w => w.length > 0 && !editingKeywords.includes(w));

  editingKeywords.push(...addedWords);
  input.value = '';
  renderEditModalKeywords();
}

async function saveEditedTopic() {
  if (!editingTopicId) return;
  const newTitle = document.getElementById('editTopicTitle').value.trim();
  if (!newTitle) {
    alert('נא להזין שם נושא');
    return;
  }
  if (editingKeywords.length === 0) {
    alert('נא להגדיר לפחות מילת מפתח אחת');
    return;
  }

  try {
    const res = await fetch(`/api/topics/${editingTopicId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTitle,
        keywords: editingKeywords
      })
    });

    const updated = await res.json();
    const index = allTopics.findIndex(t => t.id === editingTopicId);
    if (index !== -1) {
      allTopics[index] = updated;
    }

    renderTopics();
    closeEditTopicModal();
  } catch (err) {
    console.error('Failed to save topic changes:', err);
    alert('שגיאה בשמירת השינויים');
  }
}

// ניהול מודל גישה מהסמארטפון
let currentMobileUrl = '';

async function openMobileModal() {
  const modal = document.getElementById('mobileModal');
  modal.classList.remove('hidden');

  try {
    const res = await fetch('/api/network-info');
    const info = await res.json();
    currentMobileUrl = info.mobileUrl || `http://${window.location.hostname}:${info.port || 3000}`;
    
    document.getElementById('mobileDirectUrl').innerText = currentMobileUrl;
    
    const qrImg = document.getElementById('mobileQrCode');
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(currentMobileUrl)}`;
  } catch (err) {
    currentMobileUrl = window.location.href;
    document.getElementById('mobileDirectUrl').innerText = currentMobileUrl;
  }
}

function closeMobileModal() {
  const modal = document.getElementById('mobileModal');
  modal.classList.add('hidden');
}

function copyMobileUrl() {
  if (!currentMobileUrl) return;
  navigator.clipboard.writeText(currentMobileUrl).then(() => {
    alert('הכתובת הועתקה ללוח: ' + currentMobileUrl);
  }).catch(() => {
    prompt('העתק את הכתובת:', currentMobileUrl);
  });
}

async function deleteEvent(id) {
  try {
    await fetch(`/api/events/${id}`, { method: 'DELETE' });
    allEvents = allEvents.filter(e => e.id !== id);
    renderEvents();
    loadStats();
  } catch (err) {
    console.error('Failed to delete event:', err);
  }
}

async function clearAllEvents() {
  if (!confirm('האם למחוק את כל היסטוריית האירועים?')) return;
  try {
    await fetch('/api/events', { method: 'DELETE' });
    allEvents = [];
    renderEvents();
    loadStats();
  } catch (err) {
    console.error('Failed to clear events:', err);
  }
}

function applyFilters() {
  currentFilterTopic = document.getElementById('filterTopicSelect').value;
  searchQuery = document.getElementById('searchInput').value.trim();
  renderEvents();
}

function changeSortOrder() {
  currentSortOrder = document.getElementById('sortOrderSelect').value;
  renderEvents();
}

// Initial Data Fetch
async function loadTopics() {
  try {
    const res = await fetch('/api/topics');
    allTopics = await res.json();
    renderTopics();
  } catch (err) {
    console.error('Failed to load topics:', err);
  }
}

async function loadEvents() {
  try {
    const res = await fetch(`/api/events?sort=${currentSortOrder}`);
    allEvents = await res.json();
    renderEvents();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    updateStats(stats);
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// Server-Sent Events (SSE) Real-time Connection
function connectSSE() {
  const eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (e) => {
    try {
      const { type, data } = JSON.parse(e.data);

      if (type === 'NEW_ALERT') {
        // אירוע חדש לגמרי!
        allEvents.unshift(data);
        renderEvents();
        loadStats();

        // 1. צליל התראה
        playChime();

        // 2. התראת שולחן עבודה
        if (Notification.permission === 'granted') {
          new Notification(`[${data.topicTitle}] מבזק חדש 🔔`, {
            body: data.title,
            icon: 'https://cdn-icons-png.flaticon.com/512/3208/3208726.png',
            tag: data.id // מונע כפילויות במערכת ההפעלה
          });
        }
      } else if (type === 'CLUSTER_UPDATED') {
        // אירוע קיים קיבל דיווח מאתר נוסף - מעדכנים שקט ללא צפצוף!
        const index = allEvents.findIndex(ev => ev.id === data.id);
        if (index !== -1) {
          allEvents[index] = data;
          renderEvents();
          loadStats();
        }
      } else if (type === 'STATUS_UPDATE') {
        const statusEl = document.getElementById('statusText');
        if (data.isScanning) {
          statusEl.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-blue-400 animate-spin"></span> סורק אתרי חדשות...`;
        } else {
          statusEl.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-ring"></span> מנטר באופן רציף`;
        }
        updateStats(data);
      }
    } catch (err) {
      console.error('Error handling SSE message:', err);
    }
  };

  eventSource.onerror = () => {
    console.warn('SSE disconnected, retrying in 3 seconds...');
    eventSource.close();
    setTimeout(connectSSE, 3000);
  };
}

async function sendTestPushNotification() {
  try {
    await fetch('/api/push/test', { method: 'POST' });
    alert('🔔 התראת בדיקה נשלחה כעת לכל המכשירים הרשומים!');
  } catch (err) {
    alert('שגיאה בשליחת התראת בדיקה');
  }
}

// Initialization on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  // רישום Service Worker להתראות רקע ומסך נעילה
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('[PWA] Service Worker רשום בהצלחה');
      if (Notification.permission === 'granted') {
        registerPushSubscription();
      }
    }).catch((err) => {
      console.warn('[PWA] שגיאה ברישום Service Worker:', err);
    });
  }

  if ('Notification' in window) {
    updateNotifyButtonUI(Notification.permission);
  }
  loadTopics();
  loadEvents();
  loadStats();
  connectSSE();

  // רענון זמנים יחסיים כל 30 שניות
  setInterval(() => {
    renderEvents();
  }, 30000);
});
