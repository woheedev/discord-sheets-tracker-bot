import sqlite3 from "sqlite3";
import { open } from "sqlite";

let db;

export async function initializeDb() {
  db = await open({
    filename: "guild_data.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ingame_names (
      user_id TEXT PRIMARY KEY,
      ingame_name TEXT,
      verified_at DATETIME
    )
  `);
}

export async function saveIngameName(userId, name) {
  await db.run(
    "INSERT OR REPLACE INTO ingame_names (user_id, ingame_name, verified_at) VALUES (?, ?, ?)",
    [userId, name, new Date().toISOString()]
  );
}

export async function getIngameName(userId) {
  const result = await db.get(
    "SELECT ingame_name FROM ingame_names WHERE user_id = ?",
    [userId]
  );
  return result?.ingame_name || null;
}
