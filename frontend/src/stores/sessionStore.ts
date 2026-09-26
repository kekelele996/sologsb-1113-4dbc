import { create } from 'zustand';
import { db, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { planReschedule, type ReschedulePlanRow } from '../utils/reschedule';
import { useNightStore } from './nightStore';
import { useTargetStore } from './targetStore';
import { useEquipmentStore } from './equipmentStore';
import type { ObsSession, SessionKind, SessionStatus } from '../types';

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
  kind?: SessionKind;
  rescheduleReason?: string;
  backupNightId?: string;
  originalSessionId?: string;
  originalNightId?: string;
  replacedById?: string;
  processedAt?: string;
}

/** 批量改期结果：成功生成的替补段与逐条失败原因 */
export interface RescheduleResult {
  created: ObsSession[];
  rows: ReschedulePlanRow[];
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /**
   * 批量改期到备用观测夜：保持原段时长，按目标可见窗口与望远镜空闲区间
   * 取最早时段生成替补段；原段保留（状态「因云取消」、记原因与处理时间），
   * 不再计入设备占用与冲突。规划失败的段逐条返回原因，不生成替补段。
   */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<RescheduleResult>;
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
      kind: input.kind,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      originalSessionId: input.originalSessionId,
      originalNightId: input.originalNightId,
      replacedById: input.replacedById,
      processedAt: input.processedAt,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', session);
    set({ sessions: [...get().sessions, session] });
    return session;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = {
      ...current,
      ...patch,
      rescheduleReason: patch.rescheduleReason !== undefined ? patch.rescheduleReason.trim() || undefined : current.rescheduleReason,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  removeSession: async (id) => {
    await db.sessions.delete(id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const backupNight = useNightStore.getState().nights.find((night) => night.id === backupNightId);
    if (!backupNight) return { created: [], rows: [] };

    const sources = ids
      .map((id) => get().sessions.find((session) => session.id === id))
      .filter((session): session is ObsSession => Boolean(session));

    const rows = planReschedule({
      sources,
      backupNight,
      sessions: get().sessions,
      targets: useTargetStore.getState().targets,
      telescopes: useEquipmentStore.getState().telescopes,
    });

    const trimmedReason = reason.trim() || '改期至备用观测夜';
    const processedAt = new Date().toISOString();
    const created: ObsSession[] = [];
    const updated = new Map<string, ObsSession>();

    for (const row of rows) {
      if (!row.startTime || !row.endTime) continue;
      const source = row.source;
      // 多次改期：替补段再次改期时，新替补段始终挂在最初原段名下
      const rootOriginalId = source.originalSessionId ?? source.id;
      const rootOriginal = get().sessions.find((session) => session.id === rootOriginalId) ?? updated.get(rootOriginalId);
      const replacement: ObsSession = {
        id: uid('s'),
        nightId: backupNight.id,
        targetId: source.targetId,
        startTime: row.startTime,
        endTime: row.endTime,
        telescopeId: source.telescopeId,
        instrumentId: source.instrumentId,
        filterSlot: source.filterSlot,
        plannedFrames: source.plannedFrames,
        status: '待执行',
        kind: '替补段',
        rescheduleReason: trimmedReason,
        originalSessionId: rootOriginalId,
        originalNightId: rootOriginal?.nightId ?? source.nightId,
        processedAt,
        schemaVersion: SCHEMA_VERSION,
      };
      // eslint-disable-next-line no-await-in-loop
      await persistRow('sessions', replacement);
      created.push(replacement);

      // 原段保留：原夜、原时段、原因、处理时间齐备，并指向替补段
      const replacedNext: ObsSession = {
        ...source,
        kind: '原段',
        status: '因云取消',
        rescheduleReason: trimmedReason,
        backupNightId: backupNight.id,
        replacedById: replacement.id,
        processedAt,
        schemaVersion: SCHEMA_VERSION,
      };
      // eslint-disable-next-line no-await-in-loop
      await persistRow('sessions', replacedNext);
      updated.set(source.id, replacedNext);
    }

    if (created.length > 0) {
      set({
        sessions: get().sessions
          .map((session) => updated.get(session.id) ?? session)
          .concat(created),
      });
    }
    return { created, rows };
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },
}));
