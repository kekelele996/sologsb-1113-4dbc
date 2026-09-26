import { create } from 'zustand';
import { db, deleteRow, persistRow, persistRows, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { MakeupPlanItem } from '../utils/makeup';
import type { ObsSession, SessionStatus } from '../types';

export interface SessionInput {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason?: string;
  backupNightId?: string;
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 按预排结果生成替补段：原段置为「因云取消」并记录替补夜、原因与处理时间 */
  applyMakeupReschedule: (plans: MakeupPlanItem[], backupNightId: string, reason: string) => Promise<{ created: number; failed: number }>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
}

/** 排程段与冲突检测所需数据 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await db.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    const session: ObsSession = {
      id: uid('s'),
      nightId: input.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', session);
    set({ sessions: [...get().sessions, session] });
    return session;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  removeSession: async (id) => {
    await deleteRow('sessions', id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  applyMakeupReschedule: async (plans, backupNightId, reason) => {
    const now = new Date().toISOString();
    const trimmedReason = reason.trim() || '改期至备用观测夜';
    const okPlans = plans.filter((plan) => plan.ok && plan.startTime && plan.endTime);
    const makeups: ObsSession[] = [];
    const updatedOriginals: ObsSession[] = [];
    for (const plan of okPlans) {
      const original = get().sessions.find((session) => session.id === plan.sessionId);
      if (!original) continue;
      // 替补段：排在备用夜新时段，保留原段、原夜、原因与处理时间
      makeups.push({
        id: uid('s'),
        nightId: backupNightId,
        targetId: original.targetId,
        startTime: plan.startTime as string,
        endTime: plan.endTime as string,
        telescopeId: original.telescopeId,
        instrumentId: original.instrumentId,
        filterSlot: original.filterSlot,
        plannedFrames: original.plannedFrames,
        status: '待执行',
        rescheduleReason: trimmedReason,
        makeupOfSessionId: original.id,
        originalNightId: original.nightId,
        rescheduledAt: now,
        schemaVersion: SCHEMA_VERSION,
      });
      // 原段：置为因云取消并记录替补夜，此后不再计入设备冲突
      updatedOriginals.push({
        ...original,
        status: '因云取消',
        backupNightId,
        rescheduleReason: trimmedReason,
        rescheduledAt: now,
        schemaVersion: SCHEMA_VERSION,
      });
    }
    await persistRows('sessions', [...updatedOriginals, ...makeups]);
    set({
      sessions: [
        ...get().sessions.map((session) => updatedOriginals.find((item) => item.id === session.id) ?? session),
        ...makeups,
      ],
    });
    return { created: makeups.length, failed: plans.length - okPlans.length };
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },
}));
