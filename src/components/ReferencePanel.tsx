import { useRef, type DragEvent } from "react";
import { roleLabels, roleNotePlaceholders } from "../data/catalog";
import type { ReferenceImage, ReferenceRole } from "../types";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const roles = Object.keys(roleLabels) as ReferenceRole[];

function nextReferenceLabel(references: ReferenceImage[]) {
  const used = new Set(references.map((item) => item.label));
  return alphabet.find((label) => !used.has(label)) ?? `${references.length + 1}`;
}

const referenceStatusLabels = {
  required: "必需",
  recommended: "推荐",
  optional: "可选",
} as const;

interface ReferencePanelProps {
  references: ReferenceImage[];
  requiredRefs: ReferenceRole[];
  recommendedRefs: ReferenceRole[];
  onChange: (references: ReferenceImage[]) => void;
  /** 当前悬停的素材位，用于和描述里的「参考 X」标记连线。 */
  hoveredId?: string;
  onHover?: (id: string) => void;
  registerCardEl?: (id: string, element: HTMLElement | null) => void;
}

export function ReferencePanel({
  references,
  requiredRefs,
  recommendedRefs,
  onChange,
  hoveredId = "",
  onHover,
  registerCardEl,
}: ReferencePanelProps) {
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const recommendedRoleSet = new Set(recommendedRefs);

  // 必需素材位按功能声明的顺序排在最前，且不可删除、不可改类型。
  const claimedRequiredIds = new Set<string>();
  const requiredOrder = new Map<string, number>();
  requiredRefs.forEach((role, index) => {
    const reference = references.find((item) => item.role === role && !claimedRequiredIds.has(item.id));
    if (!reference) return;
    claimedRequiredIds.add(reference.id);
    requiredOrder.set(reference.id, index);
  });

  const orderedReferences = [...references].sort((first, second) => {
    const firstOrder = requiredOrder.get(first.id);
    const secondOrder = requiredOrder.get(second.id);
    if (firstOrder !== undefined && secondOrder !== undefined) return firstOrder - secondOrder;
    if (firstOrder !== undefined) return -1;
    if (secondOrder !== undefined) return 1;
    return references.indexOf(first) - references.indexOf(second);
  });

  const filledCount = references.filter((item) => Boolean(item.previewUrl)).length;

  const addReference = () => {
    onChange([
      ...references,
      { id: `ref-${Date.now()}`, label: nextReferenceLabel(references), role: "style", note: "" },
    ]);
  };

  const updateReference = (id: string, patch: Partial<ReferenceImage>) => {
    onChange(references.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeReference = (id: string) => {
    const removed = references.find((item) => item.id === id);
    if (removed?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
    registerCardEl?.(id, null);
    onChange(references.filter((item) => item.id !== id));
  };

  const handleFile = (id: string, file?: File) => {
    if (!file) return;
    const previous = references.find((item) => item.id === id);
    if (previous?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previous.previewUrl);
    updateReference(id, {
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      file,
      note: file.name.replace(/\.[^.]+$/, ""),
    });
  };

  const handleDrop = (id: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    handleFile(id, event.dataTransfer.files?.[0]);
  };

  return (
    <section className="rail-section reference-section" aria-labelledby="reference-heading">
      <header className="rail-section-head">
        <span className="rail-kicker" id="reference-heading">参考素材</span>
        <span className="rail-section-actions">
          <small>{filledCount} / {references.length}</small>
          <button type="button" className="text-button" onClick={addReference} title="添加素材位">
            + 添加
          </button>
        </span>
      </header>

      <div className="reference-grid panel-scroll">
        {orderedReferences.map((reference) => {
          const locked = claimedRequiredIds.has(reference.id);
          const status = locked ? "required" : recommendedRoleSet.has(reference.role) ? "recommended" : "optional";
          const roleName = roleLabels[reference.role];
          const expanded = hoveredId === reference.id;
          return (
            <article
              className={`reference-card reference-${status} ${expanded ? "expanded" : ""}`}
              key={reference.id}
              ref={(node) => registerCardEl?.(reference.id, node)}
              onPointerEnter={() => onHover?.(reference.id)}
              onPointerLeave={() => onHover?.("")}
              onFocus={() => onHover?.(reference.id)}
              onBlur={() => onHover?.("")}
            >
              <header className="reference-card-head">
                <span className="reference-label">{reference.label}</span>
                <strong>{roleName}</strong>
                <em className={`reference-badge reference-badge-${status}`}>{referenceStatusLabels[status]}</em>
                <button
                  type="button"
                  className="icon-button remove-ref"
                  aria-label={`删除参考${reference.label}`}
                  disabled={locked}
                  title={locked ? `“${roleName}”是当前用途的必需素材` : `删除参考${reference.label}`}
                  onClick={() => removeReference(reference.id)}
                >
                  ×
                </button>
              </header>

              <button
                type="button"
                className="reference-preview"
                onClick={() => inputRefs.current[reference.id]?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(reference.id, event)}
                aria-label={reference.previewUrl ? `替换${roleName}图片` : `上传${roleName}图片`}
              >
                {reference.previewUrl ? (
                  <img src={reference.previewUrl} alt={`${roleName}参考图`} />
                ) : (
                  <span className="reference-empty">
                    <em>+</em>
                    点击或拖入
                  </span>
                )}
              </button>
              <input
                ref={(node) => {
                  inputRefs.current[reference.id] = node;
                }}
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label={`上传${roleName}图片`}
                onChange={(event) => handleFile(reference.id, event.target.files?.[0])}
              />

              <div className="reference-caption">
                {reference.note || reference.fileName || roleNotePlaceholders[reference.role]}
              </div>

              {expanded ? (
                <div className="reference-fields">
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
                  <input
                    aria-label={`参考${reference.label}说明`}
                    value={reference.note}
                    onChange={(event) => updateReference(reference.id, { note: event.target.value })}
                    placeholder={roleNotePlaceholders[reference.role]}
                  />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
