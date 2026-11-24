import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { CrudPlan } from '../../server/crud/plan.ts';
export function openRecords(path: string): DatabaseSync;
export function createCrudServer(plan: CrudPlan, db: DatabaseSync, html: string, script: string): Server;

export function startServer(server: Server, port?: number): Promise<string>;
export function stopServer(server: Server): Promise<void>;
