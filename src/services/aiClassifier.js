/**
 * שכבת אימות חכמה אופציונלית מבוססת Gemini 2.5 Flash החינמי (Google AI Studio).
 * מופעלת רק אם הוגדר משתנה הסביבה GEMINI_API_KEY בשרת.
 * אם אינו מוגדר (או במקרה של חריגת מכסה/שגיאה), מחזירה מיידית את תוצאת מנוע ה-NLP המקומי (0ms).
 */
export class AiClassifierService {
  isEnabled() {
    return Boolean((process.env.GEMINI_API_KEY || '').trim());
  }

  getApiKey() {
    return (process.env.GEMINI_API_KEY || '').trim();
  }

  async verifyTopicMatch(item, matchedTopic, activeTopics) {
    if (!this.isEnabled() || !matchedTopic) {
      return matchedTopic;
    }

    try {
      const topicListText = activeTopics
        .map(t => `- id: "${t.id}", title: "${t.title}"`)
        .join('\n');

      const prompt = `אתה מסווג מבזקי חדשות ישראלי. תפקידך לוודא אם ידיעה אכן שייכת מהותית לאחד הנושאים הבאים, או שמדובר בשימוש מטפורי, ידיעת בורסה/כלכלה, מזג אוויר, או פלילים אזרחיים שלא קשורים לנושא הביטחוני/מדיני.

הנושאים הפעילים:
${topicListText}

סיווג ראשוני של האלגוריתם: "${matchedTopic.id}"

כותרת הידיעה: ${item.title}
תקציר: ${(item.summary || '').slice(0, 300)}

החזר JSON בלבד בפורמט:
{"topicId": "<id מתוך הרשימה או null אם הידיעה לא קשורה אף לאחד מהנושאים>"}`;

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.getApiKey()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json'
            }
          }),
          signal: AbortSignal.timeout(4000)
        }
      );

      if (!res.ok) {
        return matchedTopic;
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) return matchedTopic;

      const parsed = JSON.parse(rawText);
      if (parsed.topicId === null) {
        return null;
      }

      const found = activeTopics.find(t => t.id === parsed.topicId);
      return found || matchedTopic;
    } catch (err) {
      // במקרה של Timeout או מגבלת חינם — לא עוצרים את ההתראה, חוזרים לסיווג של מנוע ה-NLP המקומי
      return matchedTopic;
    }
  }
}

export const aiClassifier = new AiClassifierService();
