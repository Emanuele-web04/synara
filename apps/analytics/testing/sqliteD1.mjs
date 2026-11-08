// Real in-memory SQLite behind the D1 statement/batch interface for boundary tests.
import { DatabaseSync } from "node:sqlite";

class SQLiteD1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SQLiteD1Statement(this.database, this.sql, values);
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    });
  }

  all() {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  first() {
    return Promise.resolve(this.database.prepare(this.sql).get(...this.values) ?? null);
  }
}

export class SQLiteD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
  }

  prepare(sql) {
    return new SQLiteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
