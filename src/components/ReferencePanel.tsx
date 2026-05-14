import { useRef, useState, type DragEvent } from "react";
import { ImagePlus, Plus, Trash2, Upload } from "lucide-react";
import { roleLabels } from "../data/catalog";
import type { ReferenceImage, ReferenceRole } from "../types";
import { Button, Section } from "./ui";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const roles = Object.keys(roleLabels) as ReferenceRole[];

interface ReferencePanelProps {
  references: ReferenceImage[];
  onChange: (references: ReferenceImage[]) => void;
}

export function ReferencePanel({ references, onChange }: ReferencePanelProps) {
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const addReference = () => {
    const label = alphabet[references.length] ?? `${references.length + 1}`;
    onChange([
      ...references,
      {
        id: `ref-${Date.now()}`,
        label,
        role: "style",
        note: "补充参考",
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
        {references.map((ref) => (
          <div className="reference-card" key={ref.id}>
            <div className="reference-card-head">
              <strong>参考 {ref.label}</strong>
              <button className="icon-button remove-ref" aria-label={`删除参考${ref.label}`} onClick={() => removeReference(ref.id)}>
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
              <select value={ref.role} onChange={(event) => updateReference(ref.id, { role: event.target.value as ReferenceRole })}>
                {roles.map((role) => (
                  <option value={role} key={role}>
                    {roleLabels[role]}
                  </option>
                ))}
              </select>
              <input
                value={ref.note}
                onChange={(event) => updateReference(ref.id, { note: event.target.value })}
                placeholder="备注"
              />
              {ref.fileName ? <small>{ref.fileName}</small> : null}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
