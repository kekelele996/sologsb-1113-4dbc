/** 排程段状态 */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消';

/** 排程段类别：常规段 / 因云取消保留的原段 / 备用夜上的替补段 */
export type SessionKind = '常规段' | '原段' | '替补段';

/** 观测排程段 */
export interface ObsSession {
  id: string;
  /** 观测夜 ID */
  nightId: string;
  /** 观测目标 ID */
  targetId: string;
  /** 开始时刻 HH:mm */
  startTime: string;
  /** 结束时刻 HH:mm（可跨零点） */
  endTime: string;
  /** 望远镜 ID */
  telescopeId: string;
  /** 终端 ID */
  instrumentId: string;
  /** 滤镜轮位 */
  filterSlot: string;
  /** 计划帧数 */
  plannedFrames: number;
  /** 状态 */
  status: SessionStatus;
  /** 类别（v3 起写入，旧数据按常规段处理） */
  kind?: SessionKind;
  /** 改期原因 */
  rescheduleReason?: string;
  /** 替补夜 ID（原段迁移或改期时挂接） */
  backupNightId?: string;
  /** 替补段指向的原段 ID（多次改期时指向最初原段） */
  originalSessionId?: string;
  /** 替补段记录的原段所在观测夜 ID */
  originalNightId?: string;
  /** 原段指向已生成的替补段 ID（标记后原段不再计入设备占用与冲突） */
  replacedById?: string;
  /** 改期处理时间（ISO 字符串） */
  processedAt?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 取排程段类别，缺省（v2 旧数据）视为常规段 */
export function sessionKind(session: Pick<ObsSession, 'kind'>): SessionKind {
  return session.kind ?? '常规段';
}

/** 替补段：备用夜上实际执行的新时段 */
export function isReplacementSession(session: Pick<ObsSession, 'kind' | 'originalSessionId'>): boolean {
  return session.kind === '替补段' || Boolean(session.originalSessionId);
}

/** 已被替补段取代的原段：保留留痕，但不再占用设备、不计入冲突 */
export function isReplacedOriginal(session: Pick<ObsSession, 'kind' | 'replacedById'>): boolean {
  return session.kind === '原段' || Boolean(session.replacedById);
}

/** 仍占用设备的有效排程段（排除已生成替补段的原段） */
export function isActiveSession(session: ObsSession): boolean {
  return !isReplacedOriginal(session);
}

/** 冲突项 */
export interface ConflictItem {
  /** 当前排程段 */
  sessionId: string;
  /** 与之冲突的排程段 */
  otherId: string;
  nightId: string;
  telescopeId: string;
  /** 重叠分钟数 */
  overlapMinutes: number;
  /** 重叠区间文案 */
  overlapText: string;
}

export const SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消'];

/** 4 种状态配色（MUI Chip color） */
export const STATUS_CHIP_COLOR: Record<SessionStatus, 'default' | 'primary' | 'success' | 'error'> = {
  待执行: 'default',
  进行中: 'primary',
  已完成: 'success',
  因云取消: 'error',
};
