import { z } from "zod";

export const WorkspaceRecordIdSchema = z.string().uuid();
export const VaultRevisionSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/u);
