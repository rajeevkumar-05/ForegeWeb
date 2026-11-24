import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { CrudPlan } from '../../server/crud/plan.ts';
export function verifyCrud(plan: CrudPlan, open: (path: string) => {server: Server; db: DatabaseSync}): Promise<number>;
