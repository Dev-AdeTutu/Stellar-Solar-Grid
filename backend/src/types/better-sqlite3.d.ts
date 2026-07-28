declare module "better-sqlite3" {
  type BindParameter = string | number | bigint | null | Buffer;

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: BindParameter[]): RunResult;
    get(...params: BindParameter[]): unknown;
    all(...params: BindParameter[]): unknown[];
  }

  class Database {
    constructor(filename: string);
    pragma(source: string): unknown;
    exec(source: string): this;
    prepare(source: string): Statement;
  }

  export = Database;
}
