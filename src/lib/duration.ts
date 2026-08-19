/**
 * 任务卡上的「跑了多久」。
 * 时间戳来源不统一：创作台任务记的是毫秒数，短视频任务是服务端的 ISO 串，
 * 简易模式的占位卡又是客户端 new Date().toISOString()，所以先在这里收成一个数。
 */
export type TimeInput = string | number | null | undefined;

export function toEpochMs(value: TimeInput): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 12s / 2m05s / 1h03m。任务卡上摆到秒就够了，毫秒只会让人多读一眼。 */
export function formatDuration(ms: number) {
  // 演示模式几百毫秒就出图，写「0s」像是没算出来，不如直说不到一秒。
  if (ms > 0 && ms < 1000) return "<1s";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * 还在跑就一直数到现在（「已跑 12s」），跑完了就定格成总用时（「用时 34s」）。
 * 缺开始或结束时间的——旧任务、刷新时断了跟踪的记录——返回空串，调用方直接不画这一格，
 * 别拿服务端和客户端两个时钟凑出一个看着像真的假数字。
 */
export function taskDurationLabel({
  startedAt,
  finishedAt,
  running,
  now,
}: {
  startedAt: TimeInput;
  finishedAt?: TimeInput;
  running: boolean;
  now: number;
}) {
  const start = toEpochMs(startedAt);
  if (start === null) return "";
  if (running) return `已跑 ${formatDuration(now - start)}`;
  const end = toEpochMs(finishedAt);
  if (end === null) return "";
  return `用时 ${formatDuration(end - start)}`;
}
