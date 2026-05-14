import { AlertCircle, CheckCircle2, Clock3, ImageIcon, RotateCcw } from "lucide-react";
import { generationModes } from "../data/catalog";
import type { GeneratedResult, GenerationTask, TaskStatus } from "../types";
import { Button, Metric, Section } from "./ui";

const statusLabel: Record<TaskStatus, string> = {
  running: "运行中",
  success: "成功",
  failed: "失败",
};

const statusIcon = {
  running: <Clock3 size={15} />,
  success: <CheckCircle2 size={15} />,
  failed: <AlertCircle size={15} />,
};

interface TaskRailProps {
  tasks: GenerationTask[];
  results?: GeneratedResult[];
  onRetry: (task: GenerationTask) => void;
}

export function TaskRail({ tasks, results = [], onRetry }: TaskRailProps) {
  const running = tasks.filter((task) => task.status === "running").length;
  const success = tasks.filter((task) => task.status === "success").length;
  const failed = tasks.filter((task) => task.status === "failed").length;

  return (
    <Section title="任务" className="task-section">
      <div className="metric-row">
        <Metric label="运行中" value={`${running}`} tone="warn" />
        <Metric label="成功" value={`${success}`} tone="good" />
        <Metric label="失败" value={`${failed}`} />
      </div>
      <div className="task-list">
        {tasks.map((task) => {
          const mode = generationModes.find((item) => item.id === task.mode);
          const preview = results.find((result) => result.taskId === task.id);
          return (
            <article className={`task-item task-${task.status}`} key={task.id}>
              <div className="task-preview">
                {preview ? <img src={preview.imageUrl} alt={preview.title} /> : <ImageIcon size={19} />}
              </div>
              <div className="task-body">
                <div className="task-title">
                  <span>{statusIcon[task.status]}</span>
                  <strong>{mode?.shortTitle ?? task.mode}</strong>
                  <em>{statusLabel[task.status]}</em>
                </div>
                <p>{task.prompt}</p>
                <div className="progress-track">
                  <span style={{ width: `${task.progress}%` }} />
                </div>
                <div className="task-foot">
                  <span>{task.createdAt}</span>
                  <span>{task.credits} 积分</span>
                </div>
                <small>{task.message}</small>
                {task.status === "failed" ? (
                  <Button icon={<RotateCcw size={14} />} onClick={() => onRetry(task)}>重试</Button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </Section>
  );
}
