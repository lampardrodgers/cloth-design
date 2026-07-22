import { useState, type DragEvent } from "react";
import { CheckCircle2, ImagePlus, Plus, Trash2, Upload } from "lucide-react";
import { roleLabels, roleNotePlaceholders } from "../data/catalog";
import type { ReferenceImage, ReferenceRole } from "../types";
import { Button } from "./ui";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const roles = Object.keys(roleLabels) as ReferenceRole[];

function nextReferenceLabel(references: ReferenceImage[]) {
  const used = new Set(references.map((item) => item.label));
  return alphabet.find((label) => !used.has(label)) ?? `${references.length + 1}`;
}

interface ReferencePanelProps {
  references: ReferenceImage[];
  requiredRefs: ReferenceRole[];
  recommendedRefs: ReferenceRole[];
  onChange: (references: ReferenceImage[]) => void;
}

const referenceStatusLabels = {
  required: "必需",
  recommended: "推荐",
  optional: "可选",
} as const;

function hasReferenceContent(reference: ReferenceImage) {
  return Boolean(reference.previewUrl || reference.fileName || reference.note.trim());
}

export function ReferencePanel({ references, requiredRefs, recommendedRefs, onChange }: ReferencePanelProps) {
  const inputRefs: Record<string, HTMLInputElement | null> = {};
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [showAllOptional, setShowAllOptional] = useState(false);
  const recommendedRoleSet = new Set(recommendedRefs);
  const claimedRequiredIds = new Set<string>();
  const requiredOrder = new Map<string, number>();

  requiredRefs.forEach((role, index) => {
    const reference = references.find((item) => item.role === role && !claimedRequiredIds.has(item.id));
    if (!reference) return;
    claimedRequiredIds.add(reference.id);
    requiredOrder.set(reference.id, index);
  });

  const orderedReferences = [...references].sort((first, second) => {
    const firstRequiredOrder = requiredOrder.get(first.id);
    const secondRequiredOrder = requiredOrder.get(second.id);
    if (firstRequiredOrder !== undefined && secondRequiredOrder !== undefined) return firstRequiredOrder - secondRequiredOrder;
    if (firstRequiredOrder !== undefined) return -1;
    if (secondRequiredOrder !== undefined) return 1;
    return references.indexOf(first) - references.indexOf(second);
  });

  const meaningfulReferences = orderedReferences.filter(
    (reference) => claimedRequiredIds.has(reference.id) || hasReferenceContent(reference),
  );
  const emptyOptionalReferences = orderedReferences.filter(
    (reference) => !claimedRequiredIds.has(reference.id) && !hasReferenceContent(reference),
  );
  const visibleReferences = showAllOptional
    ? orderedReferences
    : [
        ...meaningfulReferences,
        ...(meaningfulReferences.length === 0 ? emptyOptionalReferences.slice(0, 1) : []),
      ];
  const hiddenOptionalCount = Math.max(orderedReferences.length - visibleReferences.length, 0);
  const completedRequiredCount = requiredRefs.filter((role) =>
    references.some((reference) => reference.role === role && Boolean(reference.previewUrl)),
  ).length;
  const requirementsMet = completedRequiredCount === requiredRefs.length;

  const addReference = () => {
    const label = nextReferenceLabel(references);
    onChange([
      ...references,
      {
        id: `ref-${Date.now()}`,
        label,
        role: "style",
        note: "",
      },
    ]);
    setShowAllOptional(true);
  };

  const updateReference = (id: string, patch: Partial<ReferenceImage>) => {
    onChange(references.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeReference = (id: string) => {
    const removedReference = references.find((item) => item.id === id);
    if (removedReference?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(removedReference.previewUrl);
    onChange(references.filter((item) => item.id !== id));
  };

  const handleFile = (id: string, file?: File) => {
    if (!file) return;
    const previousReference = references.find((item) => item.id === id);
    if (previousReference?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previousReference.previewUrl);
    updateReference(id, {
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      file,
      note: file.name.replace(/\.[^.]+$/, ""),
    });
  };

  const handleDrop = (id: string, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingId(null);
    handleFile(id, event.dataTransfer.files?.[0]);
  };

  return (
    <section className="section flow-section reference-section" aria-labelledby="reference-heading">
      <header className="flow-section-head">
        <span className="flow-step-index" aria-hidden="true">2</span>
        <div className="flow-section-copy">
          <span className="flow-kicker">准备素材</span>
          <h2 id="reference-heading" aria-label="参考图">上传能帮助 AI 理解的图片</h2>
          <p>
            {requiredRefs.length > 0
              ? `这个任务需要 ${requiredRefs.map((role) => roleLabels[role]).join("、")}，其余素材可选。`
              : "没有必须上传的素材；加入参考图可以更准确地控制人物、面料或风格。"}
          </p>
        </div>
        <span className={`flow-step-state ${requirementsMet ? "complete" : "pending"}`}>
          {requiredRefs.length === 0 ? "可选" : `${completedRequiredCount}/${requiredRefs.length} 已准备`}
        </span>
      </header>

      <div className="reference-toolbar">
        <div className="reference-readiness" aria-live="polite">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            {requirementsMet
              ? requiredRefs.length > 0
                ? "必需素材已准备好"
                : "可以直接描述画面，也可以添加参考图"
              : `还需上传 ${requiredRefs.length - completedRequiredCount} 张必需素材`}
          </span>
        </div>
        <div className="reference-toolbar-actions">
          {hiddenOptionalCount > 0 ? (
            <button type="button" className="text-button" onClick={() => setShowAllOptional(true)}>
              展开 {hiddenOptionalCount} 个可选素材位
            </button>
          ) : showAllOptional && emptyOptionalReferences.length > 0 ? (
            <button type="button" className="text-button" onClick={() => setShowAllOptional(false)}>
              收起空素材位
            </button>
          ) : null}
          <Button aria-label="添加" icon={<Plus size={15} />} onClick={addReference}>添加素材</Button>
        </div>
      </div>

      <div className="reference-grid">
        {visibleReferences.map((reference) => {
          const status = claimedRequiredIds.has(reference.id)
            ? "required"
            : recommendedRoleSet.has(reference.role)
              ? "recommended"
              : "optional";
          const locked = status === "required";
          const roleName = roleLabels[reference.role];
          return (
            <article className={`reference-card reference-${status}`} key={reference.id}>
              <div className="reference-card-head">
                <span>
                  <strong>{roleName}素材</strong>
                  <em className={`reference-badge reference-badge-${status}`}>{referenceStatusLabels[status]}</em>
                  <small>参考 {reference.label}</small>
                </span>
                <button
                  type="button"
                  className="icon-button remove-ref"
                  aria-label={`删除参考${reference.label}`}
                  disabled={locked}
                  title={locked ? `“${roleName}”是当前任务的必需素材` : `删除参考${reference.label}`}
                  onClick={() => removeReference(reference.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>

              <div
                className={`reference-preview ${draggingId === reference.id ? "drag-active" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDraggingId(reference.id);
                }}
                onDragLeave={() => setDraggingId(null)}
                onDrop={(event) => handleDrop(reference.id, event)}
              >
                <input
                  ref={(node) => {
                    inputRefs[reference.id] = node;
                  }}
                  type="file"
                  accept="image/*"
                  aria-label={`上传${roleName}图片`}
                  onChange={(event) => handleFile(reference.id, event.target.files?.[0])}
                />
                {reference.previewUrl ? <img src={reference.previewUrl} alt={`${roleName}参考图`} /> : null}
                <button type="button" className="upload-hit" onClick={() => inputRefs[reference.id]?.click()}>
                  {reference.previewUrl ? <Upload size={16} /> : <ImagePlus size={22} />}
                  <span>{reference.previewUrl ? "替换图片" : `上传${roleName}图片`}</span>
                  {!reference.previewUrl ? <small>点击选择或拖入这里</small> : null}
                </button>
              </div>

              <div className="reference-fields">
                <label>
                  <span className="sr-only">参考 {reference.label} 的素材类型</span>
                  <select
                    aria-label={`参考${reference.label}类型`}
                    value={reference.role}
                    disabled={locked}
                    onChange={(event) => updateReference(reference.id, { role: event.target.value as ReferenceRole })}
                  >
                    {roles.map((role) => (
                      <option value={role} key={role}>{roleLabels[role]}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="sr-only">参考 {reference.label} 的补充说明</span>
                  <input
                    aria-label={`参考${reference.label}说明`}
                    value={reference.note}
                    onChange={(event) => updateReference(reference.id, { note: event.target.value })}
                    placeholder={roleNotePlaceholders[reference.role]}
                  />
                </label>
                {reference.fileName ? <small className="reference-file-name">已上传 · {reference.fileName}</small> : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
