import { generationModes } from "../data/catalog";
import type { GeneratedResult, GenerationTask, TaskStatus } from "../types";

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
  onRetry: (task: GenerationTask) => void;
  onClose?: () => void;
}

export function TaskRail({ tasks, results = [], onRetry, onClose }: TaskRailProps) {
  const running = tasks.filter((task) => task.status === "running").length;
  const success = tasks.filter((task) => task.status === "success").length;
  const failed = tasks.filter((task) => task.status === "failed").length;

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
        {tasks.map((task) => {
          const mode = generationModes.find((item) => item.id === task.mode);
          const preview = results.find((result) => result.taskId === task.id);
          return (
            <article className={`task-item task-${task.status}`} key={task.id}>
              <div className="task-preview">{preview ? <img src={preview.imageUrl} alt="" /> : null}</div>
              <div className="task-body">
                <div className="task-title">
                  <strong>{mode?.shortTitle ?? task.mode}</strong>
                  <em>{statusLabel[task.status]}</em>
                </div>
                <p>{task.prompt}</p>
                <div className="progress-track" aria-hidden="true">
                  <span style={{ width: `${task.progress}%` }} />
                </div>
                <div className="task-foot">
                  <span>{task.createdAt}</span>
                  <span>{task.credits} 积分</span>
                </div>
                <small>{displayTaskMessage(task.message)}</small>
                {task.status === "failed" ? (
                  <button type="button" className="btn btn-secondary" onClick={() => onRetry(task)}>恢复设置</button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
