const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tasks.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    current INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    expected_total INTEGER NOT NULL DEFAULT 0,
    searched_count INTEGER NOT NULL DEFAULT 0,
    downloaded_count INTEGER NOT NULL DEFAULT 0,
    search_started_at INTEGER,
    canceled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS images (
    task_id TEXT NOT NULL,
    image_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    original_name TEXT,
    url TEXT,
    disk_path TEXT,
    size INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (task_id, image_index),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_images_task ON images(task_id, image_index);
  CREATE TABLE IF NOT EXISTS results (
    task_id TEXT NOT NULL,
    image_index INTEGER NOT NULL,
    image_name TEXT NOT NULL,
    payload TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, image_index),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
  );
`);
try { db.exec('ALTER TABLE results ADD COLUMN result_count INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

const taskUpsert = db.prepare(`INSERT INTO tasks
  (task_id, created_at, status, message, current, total, expected_total, searched_count, downloaded_count, search_started_at, canceled)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, message=excluded.message,
  current=excluded.current, total=excluded.total, expected_total=excluded.expected_total,
  searched_count=excluded.searched_count, downloaded_count=excluded.downloaded_count,
  search_started_at=excluded.search_started_at, canceled=excluded.canceled`);
const imageUpsert = db.prepare(`INSERT INTO images
  (task_id, image_index, name, original_name, url, disk_path, size, status, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(task_id, image_index) DO UPDATE SET name=excluded.name,
  original_name=excluded.original_name, url=excluded.url, disk_path=excluded.disk_path,
  size=excluded.size, status=excluded.status, error=excluded.error`);
const resultUpsert = db.prepare(`INSERT INTO results (task_id, image_index, image_name, payload, result_count)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, image_index) DO UPDATE SET image_name=excluded.image_name, payload=excluded.payload, result_count=excluded.result_count`);

function saveTask(task) {
  taskUpsert.run(task.taskId, task.createdAt, task.status, task.message || '', task.current || 0,
    task.total || 0, task.expected_total || 0, task.searched_count || 0, task.downloaded_count || 0,
    task.search_started_at || null, task.canceled ? 1 : 0);
}
function saveImage(taskId, image, index) {
  imageUpsert.run(taskId, index, image.name || `image_${index}`, image.originalName || null,
    image.url || null, image.diskPath || null, image.size || null, image.status || 'pending', image.error || null);
}
function saveResult(taskId, imageIndex, imageName, result) {
  resultUpsert.run(taskId, imageIndex, imageName, JSON.stringify(result), Number(result.result_count) || 0);
}
function persistTask(task) {
  db.exec('BEGIN');
  try {
    saveTask(task);
    task.images.forEach((image, index) => saveImage(task.taskId, image, index));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function loadTask(taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  if (!row) return null;
  const images = db.prepare('SELECT * FROM images WHERE task_id = ? ORDER BY image_index').all(taskId)
    .map((r) => ({ name: r.name, originalName: r.original_name, url: r.url, diskPath: r.disk_path,
      size: r.size, status: r.status, error: r.error }));
  // 结果正文按 /api/results 的 limit/offset 分页读取，避免重启时把万级结果全部载入内存。
  const task = { taskId: row.task_id, createdAt: row.created_at, images, results: {}, status: row.status,
    message: row.message, current: row.current, total: row.total, expected_total: row.expected_total,
    searched_count: Math.min(row.total, row.searched_count), downloaded_count: Math.min(row.total, row.downloaded_count),
    search_started_at: row.search_started_at, canceled: Boolean(row.canceled),
    // URL 已全部保存在 SQLite；重启恢复后没有待提交批次，流水线可在下载队列清空后正常收尾。
    submitDone: true, dlQueued: 0, pipelineActive: false };
  if (task.status === 'searching' || task.status === 'downloading') {
    task.images.forEach((image) => { if (image.status === 'searching' || image.status === 'downloading') image.status = 'pending'; });
    const allTerminal = task.images.every((image) => ['completed', 'no_results', 'failed'].includes(image.status));
    const failedCount = task.images.filter((image) => image.status === 'failed').length;
    if (allTerminal) {
      task.status = failedCount ? 'partial' : 'completed';
      task.message = failedCount ? `部分完成，${failedCount} 张失败，已保留成功结果` : '完成';
    } else {
      task.status = 'failed';
      task.message = '服务曾中断，已保留已完成结果，可继续任务';
    }
    saveTask(task);
    task.images.forEach((image, index) => saveImage(task.taskId, image, index));
  }
  return task;
}
function listTasks() {
  return db.prepare(`SELECT task_id taskId, created_at createdAt, status, message, current, total,
    expected_total expectedTotal, searched_count searchedCount, downloaded_count downloadedCount
    FROM tasks ORDER BY created_at DESC`).all();
}
function getResultRows(taskId, limit = 500, offset = 0) {
  return db.prepare('SELECT image_name imageName, payload FROM results WHERE task_id = ? ORDER BY image_index LIMIT ? OFFSET ?')
    .all(taskId, Math.max(1, Math.min(5000, limit)), Math.max(0, offset));
}
function getResultSummary(taskId) {
  return db.prepare('SELECT COUNT(*) image_count, COALESCE(SUM(result_count), 0) product_count FROM results WHERE task_id = ?').get(taskId);
}
function clearTasks() {
  db.exec('DELETE FROM results; DELETE FROM images; DELETE FROM tasks;');
}
function deleteTask(taskId) {
  db.prepare('DELETE FROM results WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM images WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
}

module.exports = { saveTask, saveImage, saveResult, persistTask, loadTask, listTasks, getResultRows, getResultSummary, clearTasks, deleteTask };
