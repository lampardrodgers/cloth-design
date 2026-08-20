import { useMemo, useState } from "react";
import { generationModes } from "../data/catalog";
import { taskDurationLabel } from "../lib/duration";
import { attachmentUsageLabels } from "../lib/freeStudio";
import { useNow } from "../lib/useNow";
import type { GeneratedResult, GenerationTask, SubmissionRecord, TaskStatus } from "../types";

const statusLabel: Record<TaskStatus, string> = {
  running: "运行中",
  success: "完成",
  failed: "失败",
};

function displayTaskMessage(message: string) {
  if (!message.includes("Images API failed")) return message;
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const data = JSON.parse(message.slice(jsonStart));
      return data?.error?.message || data?.message || "图像引擎请求失败，请检查模型或令牌配置。";
    } catch {
      return "图像引擎请求失败，请检查模型或令牌配置。";
    }
  }
  return message.replace(/^Images API failed:\s*/, "图像引擎请求失败：");
}

interface TaskRailProps {
  tasks: GenerationTask[];
  results?: GeneratedResult[];
  /** 提交现场：任务还在跑、输入框已经清空时，靠它回答「这条任务提交的是什么」。 */
  submissions?: SubmissionRecord[];
  onRetry: (task: GenerationTask) => void;
  /** 运行中的任务「放弃等待」：中断这次请求（服务端照样出图，成片之后会同步进列表）。 */
  onAbandon?: (task: GenerationTask) => void;
  onClose?: () => void;
}

/** 任务栏一次画多少条，点「显示更多」再往下加一批。 */
const TASK_PAGE_SIZE = 20;

export function TaskRail({ tasks, results = [], submissions = [], onRetry, onAbandon, onClose }: TaskRailProps) {
  const running = tasks.filter((task) => task.status === "running").length;
  const success = tasks.filter((task) => task.status === "success").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  // 有任务在跑才开秒表，「已跑 12s」得自己往前走；全跑完了时长就定格，不用再重画。
  const now = useNow(running > 0);

  // 任务攒到上百条时全画出来会明显卡：每条都带一张预览图，滚下去也看不到。
  const [visible, setVisible] = useState(TASK_PAGE_SIZE);
  const shown = tasks.slice(0, visible);
  const rest = tasks.length - shown.length;

  // 按 taskId 建索引：原来每条任务都要在 results / submissions 里各 find 一遍，
  // 两边都上百条的时候就是几万次比较，每次渲染都白跑一遍。
  const previewByTask = useMemo(() => {
    const map = new Map<string, GeneratedResult>();
    for (const result of results) if (!map.has(result.taskId)) map.set(result.taskId, result);
    return map;
  }, [results]);
  const submissionByTask = useMemo(() => new Map(submissions.map((item) => [item.taskId, item])), [submissions]);

  return (
    <section className="task-section">
      <header className="task-section-head">
        <strong>生成任务</strong>
        {onClose ? (
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭任务面板">×</button>
        ) : null}
      </header>

      <div className="metric-row">
        <div className="metric metric-warn"><span>运行中</span><strong>{running}</strong></div>
        <div className="metric metric-good"><span>成功</span><strong>{success}</strong></div>
        <div className="metric metric-default"><span>失败</span><strong>{failed}</strong></div>
      </div>

      <div className="task-list">
        {tasks.length === 0 ? (
          <div className="empty-task-list">
            <strong>还没有任务</strong>
            <span>生成后这里显示实时进度</span>
          </div>
        ) : null}
        {shown.map((task) => {
          const mode = generationModes.find((item) => item.id === task.mode);
          const preview = previewByTask.get(task.id);
          const submission = submissionByTask.get(task.id);
          const duration = taskDurationLabel({
            startedAt: task.startedAt,
            finishedAt: task.finishedAt,
            running: task.status === "running",
            now,
          });
          return (
            <article className={`task-item task-${task.status}`} key={task.id}>
              <div className="task-preview">{preview ? <img src={preview.imageUrl} alt="" loading="lazy" decoding="async" /> : null}</div>
              <div className="task-body">
                <div className="task-title">
                  <strong>{mode?.shortTitle ?? task.mode}</strong>
                  <em>{statusLabel[task.status]}</em>
                </div>
                <p>{task.prompt}</p>
                <div className="progress-track" aria-hidden="true">
                  <span style={{ width: `${task.progress}%` }} />
                </div>
                {submission ? (
                  <div className="task-submission">
                    <span>
                      {submission.ratioLabel} · {submission.sizeLabel} · {submission.quantity} 张 ·{" "}
                      {submission.references.length ? `${submission.references.length} 张参考图` : "无参考图"}
                    </span>
                    {submission.references.length ? (
                      <div className="task-submission-refs">
                        {submission.references.map((reference, index) =>
                          reference.thumbUrl ? (
                            <img
                              key={`${reference.name}-${index}`}
                              src={reference.thumbUrl}
                              alt={reference.name}
                              title={`${attachmentUsageLabels[reference.usage]} · ${reference.name}`}
                            />
                          ) : null,
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="task-foot">
                  <span>{task.createdAt}</span>
                  {duration ? <span>{duration}</span> : null}
                  <span>{task.credits} 积分</span>
                </div>
                <small>{displayTaskMessage(task.message)}</small>
                {task.status === "failed" ? (
                  <button type="button" className="btn btn-secondary" onClick={() => onRetry(task)}>恢复设置</button>
                ) : null}
                {task.status === "running" && onAbandon ? (
                  <button type="button" className="btn btn-secondary task-abandon" onClick={() => onAbandon(task)} title="不再等这张；服务器仍会出图，成片之后会同步进列表">
                    放弃等待
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {rest > 0 ? (
          <button type="button" className="btn btn-secondary task-more" onClick={() => setVisible((count) => count + TASK_PAGE_SIZE)}>
            还有 {rest} 条 · 显示更多
          </button>
        ) : null}
      </div>
    </section>
  );
}
