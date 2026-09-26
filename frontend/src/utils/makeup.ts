import type { ObsNight, ObsSession, ObsTarget, Telescope } from '../types';
import { axisMinutes, durationMinutes, formatMinutes, minutesToTime, visibilityWindow } from './astro';

/** 单条改期预排结果 */
export interface MakeupPlanItem {
  /** 原排程段 ID */
  sessionId: string;
  /** 是否可安排 */
  ok: boolean;
  /** 安排到备用夜的开始时刻 HH:mm（ok 时给出） */
  startTime?: string;
  /** 安排到备用夜的结束时刻 HH:mm（ok 时给出） */
  endTime?: string;
  /** 无法安排的原因（ok=false 时给出，逐条说明） */
  failReason?: string;
}

/** 扫描步长（分钟）：与可见窗口采样步长一致 */
export const MAKEUP_STEP_MINUTES = 10;

/** 时间轴区间 [start, end)，18:00 起算分钟，跨零点已展开 */
export type AxisInterval = [number, number];

/** 排程段在时间轴上的占用区间 */
export function sessionAxisInterval(session: Pick<ObsSession, 'startTime' | 'endTime'>): AxisInterval {
  const start = axisMinutes(session.startTime);
  const rawEnd = axisMinutes(session.endTime);
  return [start, rawEnd <= start ? rawEnd + 1440 : rawEnd];
}

/** 望远镜在某观测夜的占用区间（仅统计有效排程：因云取消的原段不再占用设备） */
export function telescopeBusyIntervals(sessions: ObsSession[], nightId: string, telescopeId: string, ignoreSessionId?: string): AxisInterval[] {
  return sessions
    .filter(
      (session) =>
        session.nightId === nightId && session.telescopeId === telescopeId && session.id !== ignoreSessionId && session.status !== '因云取消',
    )
    .map(sessionAxisInterval);
}

function intervalsOverlap(a: AxisInterval, b: AxisInterval): boolean {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > 0;
}

/** 在 [windowStart, windowEnd] 内找能容纳 duration 且避开全部占用区间的最早起点；找不到返回 null */
export function earliestFitStart(windowStart: number, windowEnd: number, duration: number, busy: AxisInterval[]): number | null {
  for (let start = windowStart; start + duration <= windowEnd; start += MAKEUP_STEP_MINUTES) {
    const candidate: AxisInterval = [start, start + duration];
    if (!busy.some((interval) => intervalsOverlap(candidate, interval))) return start;
  }
  return null;
}

export interface MakeupPlanInput {
  /** 勾选的待改期排程段 */
  selected: ObsSession[];
  /** 全部排程段（用于设备占用与已有替补段判定） */
  allSessions: ObsSession[];
  targets: ObsTarget[];
  telescopes: Telescope[];
  /** 目标备用观测夜 */
  backupNight: ObsNight;
}

/**
 * 批量改期预排（纯函数，不写库）：按原时长在目标可见窗口与望远镜空闲区间内安排最早时段；
 * 同批已预排的替补段会立即计入设备占用，避免同望远镜撞车；
 * 目标不可见或设备始终被占用的段逐条给出原因，不生成排程。
 */
export function planMakeupBatch(input: MakeupPlanInput): MakeupPlanItem[] {
  const { selected, allSessions, targets, telescopes, backupNight } = input;
  const plannedByTelescope = new Map<string, AxisInterval[]>();
  const ordered = [...selected].sort(
    (a, b) => a.nightId.localeCompare(b.nightId) || axisMinutes(a.startTime) - axisMinutes(b.startTime) || a.id.localeCompare(b.id),
  );

  return ordered.map((session) => {
    const duration = durationMinutes(session.startTime, session.endTime);
    const target = targets.find((item) => item.id === session.targetId);
    if (!target) {
      return { sessionId: session.id, ok: false, failReason: '目标记录不存在（可能已删除），无法计算可见窗口' };
    }
    if (session.status === '已完成' || session.status === '进行中') {
      return { sessionId: session.id, ok: false, failReason: `该段状态为「${session.status}」，无需改期` };
    }
    const existing = allSessions.find((item) => item.makeupOfSessionId === session.id);
    if (existing) {
      return { sessionId: session.id, ok: false, failReason: `已存在替补段 ${existing.id}（${existing.startTime}-${existing.endTime}），如需调整请先删除该替补段` };
    }
    const window = visibilityWindow(target, backupNight);
    if (!window) {
      return { sessionId: session.id, ok: false, failReason: `目标在 ${backupNight.date} 全夜低于最小高度 ${target.minAltitude}°，不可见` };
    }
    if (window.durationMinutes < duration) {
      return {
        sessionId: session.id,
        ok: false,
        failReason: `可见窗口 ${window.startText}-${window.endText}（${formatMinutes(window.durationMinutes)}）短于原时长 ${formatMinutes(duration)}`,
      };
    }
    const telescope = telescopes.find((item) => item.id === session.telescopeId);
    const busy = [
      ...telescopeBusyIntervals(allSessions, backupNight.id, session.telescopeId, session.id),
      ...(plannedByTelescope.get(session.telescopeId) ?? []),
    ];
    const start = earliestFitStart(window.startAxis, window.endAxis, duration, busy);
    if (start === null) {
      return {
        sessionId: session.id,
        ok: false,
        failReason: `望远镜 ${telescope?.code ?? session.telescopeId} 在可见窗口 ${window.startText}-${window.endText} 内无连续 ${formatMinutes(duration)} 空闲`,
      };
    }
    const interval: AxisInterval = [start, start + duration];
    plannedByTelescope.set(session.telescopeId, [...(plannedByTelescope.get(session.telescopeId) ?? []), interval]);
    return { sessionId: session.id, ok: true, startTime: minutesToTime(start), endTime: minutesToTime(start + duration) };
  });
}

/** ISO 时间戳 → 'YYYY-MM-DD HH:mm'（本地时区，用于展示改期处理时间） */
export function formatDateTime(iso?: string): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
