import { dbService } from './db.js';

// מעטפת תאימות המפנה את כל פעולות האחסון ישירות למסד הנתונים SQLite (data/news.db)
export class StorageService {
  getTopics() {
    return dbService.getTopics();
  }

  saveTopics(topics) {
    return dbService.saveTopics(topics);
  }

  getClusters(query = {}) {
    return dbService.getClusters(query);
  }

  saveClusters(clusters) {
    return dbService.saveClusters(clusters);
  }

  deleteCluster(id) {
    return dbService.deleteCluster(id);
  }

  clearAllClusters() {
    return dbService.clearAllClusters();
  }

  getSettings() {
    return dbService.getSettings();
  }

  updateSettings(newSettings) {
    return dbService.updateSettings(newSettings);
  }
}

export const storage = new StorageService();
