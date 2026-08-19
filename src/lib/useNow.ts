import { useEffect, useState } from "react";

/**
 * 每秒给一次当前时间，用来刷新任务卡上的「已跑 12s」。
 * active 为 false 时不开定时器：任务面板常年挂着，没任务在跑还每秒重画整列纯属白烧。
 */
export function useNow(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
