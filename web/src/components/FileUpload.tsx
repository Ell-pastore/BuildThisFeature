import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { getFilesystemProvider } from "../services/filesystem";

interface FileUploadProps {
  /** The directory the picked files are written into, e.g. the open folder. */
  destDir: string;
  /** Called once after ANY file in the selection was written successfully. */
  onUploaded: () => void;
  /** Renders the visible control; calls `openPicker` to launch the hidden input. */
  renderTrigger: (openPicker: () => void) => ReactNode;
}

/**
 * Shared local file upload flow. A hidden `input[type=file][multiple]` feeds
 * the picker; each selected file's bytes are read in the web layer and written
 * through the filesystem provider into `destDir/<filename>`. Cancelling the
 * picker (empty selection) is a no-op. Files whose write fails are surfaced
 * inline and never reported as uploaded — `onUploaded` fires only when at
 * least one write actually succeeded.
 */
export default function FileUpload({ destDir, onUploaded, renderTrigger }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files;
    e.target.value = "";
    if (!picked || picked.length === 0) return;
    const provider = getFilesystemProvider();
    const sep = destDir.endsWith("/") ? "" : "/";
    const newErrors: string[] = [];
    let uploaded = 0;
    for (const file of Array.from(picked)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await provider.writeFile(`${destDir}${sep}${file.name}`, bytes);
        uploaded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        newErrors.push(`Couldn't upload ${file.name}: ${message}`);
      }
    }
    if (newErrors.length > 0) setErrors((prev) => [...prev, ...newErrors]);
    if (uploaded > 0) onUploaded();
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        data-testid="file-upload-input"
        className="hidden"
        onChange={handleChange}
      />
      {renderTrigger(() => inputRef.current?.click())}
      {errors.length > 0 && (
        <div role="alert" className="text-xs text-red-600">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
    </>
  );
}