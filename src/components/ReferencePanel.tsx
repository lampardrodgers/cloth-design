import { useRef, useState, type DragEvent } from "react";
import { ImagePlus, Plus, Trash2, Upload } from "lucide-react";
import { roleLabels, roleNotePlaceholders } from "../data/catalog";
import type { ReferenceImage, ReferenceRole } from "../types";
import { Button, Section } from "./ui";

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
  required: "必填",
  recommended: "推荐",
  optional: "可选",
} as const;

export function ReferencePanel({ references, requiredRefs, recommendedRefs, onChange }: ReferencePanelProps) {
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const recommendedRoleSet = new Set(recommendedRefs);
  const claimedRequiredIds = new Set<string>();
  const requiredOrder = new Map<string, number>();
  requiredRefs.forEach((role, index) => {
    const ref = references.find((item) => item.role === role && !claimedRequiredIds.has(item.id));
    if (!ref) return;
    claimedRequiredIds.add(ref.id);
    requiredOrder.set(ref.id, index);
  });
  const visibleReferences = [...references].sort((first, second) => {
    const firstRequiredOrder = requiredOrder.get(first.id);
    const secondRequiredOrder = requiredOrder.get(second.id);
    if (firstRequiredOrder !== undefined && secondRequiredOrder !== undefined) return firstRequiredOrder - secondRequiredOrder;
    if (firstRequiredOrder !== undefined) return -1;
    if (secondRequiredOrder !== undefined) return 1;
    return references.indexOf(first) - references.indexOf(second);
  });

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
  };

  const updateReference = (id: string, patch: Partial<ReferenceImage>) => {
    onChange(references.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeReference = (id: string) => {
    onChange(references.filter((item) => item.id !== id));
  };

  const handleFile = (id: string, file?: File) => {
    if (!file) return;
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
    <Section
      title="参考图"
      action={<Button icon={<Plus size={15} />} onClick={addReference}>添加</Button>}
      className="reference-section"
    >
      <div className="reference-grid">
        {visibleReferences.map((ref) => {
          const status = claimedRequiredIds.has(ref.id) ? "required" : recommendedRoleSet.has(ref.role) ? "recommended" : "optional";
          const locked = status === "required";
          return (
            <div className={`reference-card reference-${status}`} key={ref.id}>
              <div className="reference-card-head">
                <span>
                  <strong>参考 {ref.label}</strong>
                  <em className={`reference-badge reference-badge-${status}`}>{referenceStatusLabels[status]}</em>
                </span>
                <button
                  className="icon-button remove-ref"
                  aria-label={`删除参考${ref.label}`}
                  disabled={locked}
                  title={locked ? "当前模式必填参考图，不能删除" : `删除参考${ref.label}`}
                  onClick={() => removeReference(ref.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            <div
              className={`reference-preview ${draggingId === ref.id ? "drag-active" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDraggingId(ref.id);
              }}
              onDragLeave={() => setDraggingId(null)}
              onDrop={(event) => handleDrop(ref.id, event)}
            >
              <input
                ref={(node) => {
                  inputRefs.current[ref.id] = node;
                }}
                type="file"
                accept="image/*"
                onChange={(event) => handleFile(ref.id, event.target.files?.[0])}
              />
              {ref.previewUrl ? <img src={ref.previewUrl} alt={`参考${ref.label}`} /> : null}
              <button type="button" className="upload-hit" onClick={() => inputRefs.current[ref.id]?.click()}>
                {ref.previewUrl ? <Upload size={16} /> : <ImagePlus size={22} />}
                <span>{ref.previewUrl ? "替换图片" : "点击或拖入图片"}</span>
              </button>
            </div>
            <div className="reference-fields">
              <select
                value={ref.role}
                disabled={locked}
                onChange={(event) => updateReference(ref.id, { role: event.target.value as ReferenceRole })}
              >
                {roles.map((role) => (
                  <option value={role} key={role}>
                    {roleLabels[role]}
                  </option>
                ))}
              </select>
              <input
                value={ref.note}
                onChange={(event) => updateReference(ref.id, { note: event.target.value })}
                placeholder={roleNotePlaceholders[ref.role]}
              />
              {ref.fileName ? <small>{ref.fileName}</small> : null}
            </div>
          </div>
          );
        })}
      </div>
    </Section>
  );
}
