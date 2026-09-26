import type { ObsNight, ObsSession, ObsTarget, Telescope } from '../types';
import { NIGHT_TOTAL_MINUTES } from '../types/night';
import { altitudeAt, axisMinutes, durationMinutes, minutesToTime } from './astro';

/** 规划步长（分钟）：在可见窗口与设备空闲区间内逐档寻找最早时段 */
const PLAN_STEP_MINUTES = 10;

export interface ReschedulePlanRow {
  source: ObsSession;
  /** 规划成功的替补时段（失败时为空） */
  startTime?: string;
  endTime?: string;
  /** 逐条失败原因；存在即表示不生成替补段 */
  reason?: string;
  /** 目标在备用夜的可见窗口文案（预览展示，不可见时为空） */
  visibilityText?: string;
}

export interface ReschedulePlanInput {
  sources: ObsSession[];
  backupNight: ObsNight;
  sessions: ObsSession[];
  targets: ObsTarget[];
  telescopes: Telescope[];
}

interface AxisRange {
  start: number;
  end: number;
}

/** 夜内时刻转刻度：日落可略早于 18:00（允许负刻度），日出归一到次晨 */
function eveningAxis(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v) || 0);
  const clock = h * 60 + m;
  return clock >= 12 * 60 ? clock - 18 * 60 : clock + (1440 - 18 * 60);
}

function morningAxis(hhmm: string): number {
  const value = eveningAxis(hhmm);
  return value <= 0 ? value + 1440 : value;
}

/**
 * 计算目标在指定观测夜的可见窗口轴区间（地平高度 ≥ 目标阈值）。
 * 与 visibilityWindow 同算法，但允许日落早于 18:00 的负刻度，并返回轴坐标供区间求交。
 */
function visibilityRange(target: ObsTarget, night: ObsNight): AxisRange | null {
  const base = new Date(`${night.date}T18:00:00`);
  const from = eveningAxis(night.sunset);
  const to = morningAxis(night.sunrise) || NIGHT_TOTAL_MINUTES;
  let first: number | null = null;
  let last = from;
  for (let axis = from; axis <= to; axis += PLAN_STEP_MINUTES) {
    const date = new Date(base.getTime() + axis * 60_000);
    if (altitudeAt(target, date, night.siteLat, night.siteLng) >= target.minAltitude) {
      if (first === null) first = axis;
      last = axis;
    }
  }
  if (first === null) return null;
  return { start: first, end: last + PLAN_STEP_MINUTES };
}

/** 把可能跨零点的排程段拆为落在 [0, 1440) 内的轴区间 */
function sessionRanges(session: ObsSession): AxisRange[] {
  const start = axisMinutes(session.startTime);
  let end = axisMinutes(session.endTime);
  if (end <= start) end += 1440;
  if (start < 0) return [{ start: start + 1440, end: Math.min(1440, end + 1440) }];
  const ranges: AxisRange[] = [{ start, end: Math.min(end, NIGHT_TOTAL_MINUTES) }];
  if (end > NIGHT_TOTAL_MINUTES) ranges.push({ start: 0, end: end - NIGHT_TOTAL_MINUTES });
  return ranges.filter((range) => range.end > range.start);
}

function overlaps(a: AxisRange, b: AxisRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 为单个排程段在备用夜规划替补时段：保持原时长，在目标可见窗口与该望远镜
 * 有效占用区间的交集内取最早可放入的整步长时段。
 *
 * @param busy 规划过程中逐步累积的新增占用（同一批多段按勾选顺序避让彼此）
 */
function planOne(
  source: ObsSession,
  backupNight: ObsNight,
  allSessions: ObsSession[],
  target: ObsTarget | undefined,
  telescope: Telescope | undefined,
  busy: Array<{ telescopeId: string; ranges: AxisRange[] }>,
): Omit<ReschedulePlanRow, 'source'> {  if (source.nightId === backupNight.id) {
    return { reason: `原段本就在 ${backupNight.date}，不能改期到同一观测夜` };
  }
  if (!target) {
    return { reason: '目标数据缺失，无法计算可见窗口' };
  }
  if (!telescope) {
    return { reason: '原段使用的望远镜已被删除，无法安排设备' };
  }
  if (telescope.status !== '可用') {
    return { reason: `望远镜 ${telescope.code} 在备用夜处于「${telescope.status}」状态，全程不可用` };
  }

  const window = visibilityRange(target, backupNight);
  if (!window) {
    return { reason: `目标 ${target.name} 在 ${backupNight.date} 整夜低于地平高度阈值 ${target.minAltitude}°，不可见` };
  }
  const windowText = `${minutesToTime(window.start)}-${minutesToTime(window.end)}（≥ ${target.minAltitude}°）`;

  const length = durationMinutes(source.startTime, source.endTime);
  if (window.end - window.start < length) {
    return {
      reason: `目标 ${target.name} 可见窗口 ${windowText} 仅 ${window.end - window.start} 分钟，短于原段时长 ${length} 分钟`,
      visibilityText: windowText,
    };
  }

  // 已生成替补段的原段不再占用设备；只考虑备用夜上同一望远镜的有效排程
  const occupied = allSessions
    .filter((session) => session.nightId === backupNight.id && session.telescopeId === source.telescopeId)
    .filter((session) => session.id !== source.id && !session.replacedById && session.kind !== '原段')
    .flatMap(sessionRanges);
  const planned = busy.filter((item) => item.telescopeId === source.telescopeId).flatMap((item) => item.ranges);
  const blocked = [...occupied, ...planned];

  // 时间轴只渲染 18:00→06:00，窗口起点早于 18:00 时钳到 0
  const domainStart = Math.max(0, window.start);
  const domainEnd = Math.min(NIGHT_TOTAL_MINUTES, window.end);
  for (let start = domainStart; start + length <= domainEnd; start += PLAN_STEP_MINUTES) {
    const candidate = { start, end: start + length };
    if (!blocked.some((range) => overlaps(candidate, range))) {
      busy.push({ telescopeId: source.telescopeId, ranges: sessionRanges({ ...source, startTime: minutesToTime(start), endTime: minutesToTime(start + length) }) });
      return { startTime: minutesToTime(start), endTime: minutesToTime(start + length), visibilityText: windowText };
    }
  }

  const occupiedText = blocked.length
    ? blocked.map((range) => `${minutesToTime(range.start)}-${minutesToTime(range.end)}`).join('、')
    : '全夜';
  return {
    reason: `望远镜 ${telescope.code} 在目标可见窗口 ${windowText} 内始终被占用（已占用：${occupiedText}），放不下 ${length} 分钟的原段`,
    visibilityText: windowText,
  };
}

/**
 * 批量改期预检：按原时长在目标可见窗口与望远镜空闲区间内，为每个勾选段
 * 求最早替补时段；不可见或设备始终占用的逐条给出原因且不产出时段。
 * 多段之间按传入顺序互相避让。
 */
export function planReschedule(input: ReschedulePlanInput): ReschedulePlanRow[] {
  const { sources, backupNight, sessions, targets, telescopes } = input;
  const busy: Array<{ telescopeId: string; ranges: AxisRange[] }> = [];
  return sources.map((source) => {
    const target = targets.find((item) => item.id === source.targetId);
    const telescope = telescopes.find((item) => item.id === source.telescopeId);
    return { source, ...planOne(source, backupNight, sessions, target, telescope, busy) };
  });
}
