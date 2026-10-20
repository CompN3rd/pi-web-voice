export const REQUEST = "compn3rd.voice:request:v1";
export const REPLY = "compn3rd.voice:reply:v1";
export const MARKER = "compn3rd.voice:worker:v1";
export const MAX_TEXT = 16_000;
export type WorkerStatus = "starting" | "running" | "needs-input" | "completed" | "failed" | "unknown";
export interface Worker {
  id: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  model: string;
  status: WorkerStatus;
  text: string;
  question?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Command {
  requestId: string;
  kind: "start" | "reply";
  title?: string;
  prompt: string;
  model?: string;
  workerId?: string;
  expectedRevision?: number;
}
export interface Lease { token: string; remaining: number; expiresAt: number }
export interface ModelOption { id: string; name: string }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
}
export function uuid(value: unknown): string {
  const id = text(value, "request ID", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid request ID");
  return id;
}
