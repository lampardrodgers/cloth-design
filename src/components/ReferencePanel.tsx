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

  return (
    <Section
      title="参考图"
      action={<Button icon={<Plus size={15} />} onClick={addReference}>添加</Button>}
      className="reference-section"
    >
      <div className="reference-grid">
        {references.map((ref) => (
          <div className="reference-card" key={ref.id}>
            <div className="reference-preview">
              {ref.previewUrl ? (
                <img src={ref.previewUrl} alt={`参考${ref.label}`} />
              ) : (
                <div className="reference-empty">
                  <ImagePlus size={22} />
                  <span>{ref.label}</span>
                </div>
              )}
              <strong>{ref.label}</strong>
              <label className="upload-hit">
                <input type="file" accept="image/*" onChange={(event) => handleFile(ref.id, event.target.files?.[0])} />
                <Upload size={15} />
              </label>
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
            </div>
            <button className="icon-button remove-ref" aria-label={`删除参考${ref.label}`} onClick={() => removeReference(ref.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}
