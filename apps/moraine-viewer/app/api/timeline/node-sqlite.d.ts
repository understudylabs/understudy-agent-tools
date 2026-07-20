// Minimal typings for node:sqlite — the installed @types/node is v20, which
// predates the module (runtime is Node 22, where it exists). Only what
// scan-db.ts uses.
declare module "node:sqlite" {
  export interface StatementSync {
    all(...params: Array<string | number | bigint | null>): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
