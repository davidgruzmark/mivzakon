// מילות עצירה וקישור נפוצות בעברית ומילות מילוי עיתונאיות
export const HEBREW_STOP_WORDS = new Set([
  'של', 'את', 'על', 'אל', 'מן', 'עם', 'כל', 'זה', 'זו', 'אלה', 'אלו', 'אשר', 'כי',
  'אם', 'גם', 'לא', 'כן', 'הוא', 'היא', 'הם', 'הן', 'היו', 'היה', 'תהיה', 'יהיה',
  'דיווח', 'דיווחים', 'ראשוני', 'עכשיו', 'מבזק', 'חדשות', 'הותר', 'לפרסום', 'בעקבות',
  'לאחר', 'במהלך', 'על פי', 'לפי', 'כך', 'בין', 'יותר', 'פחות', 'כדי', 'כמו',
  'שלו', 'שלה', 'שלהם', 'אותו', 'אותה', 'אותם', 'אומר', 'אמרה', 'מסר', 'מסרה', 'נמסר',
  'פורסם', 'היום', 'אמש', 'הבוקר', 'הערב', 'שעה', 'שעות', 'דקות', 'רק', 'עוד', 'שוב',
  'כבר', 'נגד', 'לפני', 'אחרי', 'תוך', 'אצל', 'סביב', 'יחד', 'בגלל', 'מפני', 'אודות'
]);

// ניקוי ופיענוח תגיות HTML וישויות
export function stripAndDecodeHtml(html) {
  if (!html) return '';
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// נרמול גרשיים ומרכאות עבריות
export function normalizeHebrewQuotes(text) {
  if (!text) return '';
  return text
    .replace(/[״”"״]/g, '"')
    .replace(/[׳'’]/g, "'");
}

// הסרת אותיות יחס וקישור נפוצות בתחילת מילה (ו, ה, כ, ל, ב, מ, ש)
export function stripHebrewPrefix(word) {
  if (!word || word.length < 4) return word;
  
  // אותיות השימוש הנפוצות
  const prefixes = ['ומ', 'וה', 'וב', 'ול', 'וכ', 'וש', 'מה', 'בה', 'לה', 'שה', 'ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ'];
  for (const p of prefixes) {
    if (word.startsWith(p) && word.length - p.length >= 3) {
      return word.slice(p.length);
    }
  }
  return word;
}

// ניקוי טקסט והפקת רשימת מילים משמעותיות + השורש שלהן
export function tokenizeHebrew(text) {
  if (!text) return [];
  const normalized = normalizeHebrewQuotes(text)
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'<>\[\]\\|]/g, ' ')
    .toLowerCase();

  const words = normalized
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !HEBREW_STOP_WORDS.has(w));

  return words;
}

// הפקת מילים עם קידומת מקולפת לצורך השוואה מורחבת
export function getWordStems(tokens) {
  const stems = new Set();
  for (const token of tokens) {
    stems.add(token);
    const stripped = stripHebrewPrefix(token);
    if (stripped) stems.add(stripped);
  }
  return stems;
}

// בדיקת התאמת מילים רכה בין שתי מילים
export function wordsMatch(w1, w2) {
  if (w1 === w2) return true;
  const s1 = stripHebrewPrefix(w1);
  const s2 = stripHebrewPrefix(w2);
  return s1 === s2 || s1 === w2 || w1 === s2;
}

// חישוב מדד דמיון משוקלל בין שני טקסטים בעברית
export function calculateHebrewSimilarity(text1, text2) {
  const tokens1 = tokenizeHebrew(text1);
  const tokens2 = tokenizeHebrew(text2);

  if (tokens1.length === 0 || tokens2.length === 0) return 0;

  const stems1 = getWordStems(tokens1);
  const stems2 = getWordStems(tokens2);

  let matches = 0;
  for (const s1 of stems1) {
    if (stems2.has(s1)) {
      matches++;
    }
  }

  // Jaccard similarity על ה-stems
  const totalUnique = new Set([...stems1, ...stems2]).size;
  const jaccard = totalUnique > 0 ? matches / totalUnique : 0;

  // Overlap similarity ביחס לטקסט הקצר יותר (מצוין לכותרות קצרות שמצוטטות חלקית)
  const minSize = Math.min(stems1.size, stems2.size);
  const overlap = minSize > 0 ? matches / minSize : 0;

  // ממוצע משוקלל שנותן משקל גם לחפיפה מוחלטת של הקצר
  return (jaccard * 0.4) + (overlap * 0.6);
}
