import type { FileType } from "../types";

const typeConfig: Record<string, { bg: string; text: string; label: string }> = {
  pdf: { bg: "bg-red-100", text: "text-red-600", label: "PDF" },
  docx: { bg: "bg-blue-100", text: "text-blue-600", label: "DOC" },
  png: { bg: "bg-emerald-100", text: "text-emerald-600", label: "PNG" },
  jpg: { bg: "bg-emerald-100", text: "text-emerald-600", label: "JPG" },
  jpeg: { bg: "bg-emerald-100", text: "text-emerald-600", label: "JPG" },
  gif: { bg: "bg-emerald-100", text: "text-emerald-600", label: "GIF" },
  webp: { bg: "bg-emerald-100", text: "text-emerald-600", label: "WEBP" },
  svg: { bg: "bg-emerald-100", text: "text-emerald-600", label: "SVG" },
  pptx: { bg: "bg-orange-100", text: "text-orange-600", label: "PPT" },
  ppt: { bg: "bg-orange-100", text: "text-orange-600", label: "PPT" },
  zip: { bg: "bg-amber-100", text: "text-amber-600", label: "ZIP" },
  rar: { bg: "bg-amber-100", text: "text-amber-600", label: "RAR" },
  mp4: { bg: "bg-purple-100", text: "text-purple-600", label: "MP4" },
  mov: { bg: "bg-purple-100", text: "text-purple-600", label: "MOV" },
  avi: { bg: "bg-purple-100", text: "text-purple-600", label: "AVI" },
  mkv: { bg: "bg-purple-100", text: "text-purple-600", label: "MKV" },
  mp3: { bg: "bg-fuchsia-100", text: "text-fuchsia-600", label: "MP3" },
  wav: { bg: "bg-fuchsia-100", text: "text-fuchsia-600", label: "WAV" },
  txt: { bg: "bg-zinc-100", text: "text-zinc-600", label: "TXT" },
  md: { bg: "bg-zinc-100", text: "text-zinc-600", label: "MD" },
  json: { bg: "bg-yellow-100", text: "text-yellow-700", label: "JSON" },
  js: { bg: "bg-yellow-100", text: "text-yellow-700", label: "JS" },
  ts: { bg: "bg-blue-100", text: "text-blue-700", label: "TS" },
  xlsx: { bg: "bg-green-100", text: "text-green-600", label: "XLS" },
  xls: { bg: "bg-green-100", text: "text-green-600", label: "XLS" },
  csv: { bg: "bg-green-100", text: "text-green-600", label: "CSV" },
  html: { bg: "bg-orange-100", text: "text-orange-600", label: "HTML" },
  folder: { bg: "bg-indigo-50", text: "text-indigo-500", label: "DIR" },
};

interface FileIconProps {
  type: string;
  size?: "sm" | "md" | "lg";
}

export default function FileIcon({ type, size = "md" }: FileIconProps) {
  const cfg = typeConfig[type] ?? typeConfig.txt;
  const sizeClasses = {
    sm: "w-8 h-8 text-[9px]",
    md: "w-10 h-10 text-[10px]",
    lg: "w-14 h-14 text-xs",
  };

  if (type === "folder") {
    return (
      <div className={`${sizeClasses[size]} ${cfg.bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
        <svg viewBox="0 0 24 24" fill="currentColor" className={`${cfg.text} ${size === "sm" ? "w-4 h-4" : size === "lg" ? "w-7 h-7" : "w-5 h-5"}`}>
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
        </svg>
      </div>
    );
  }

  return (
    <div className={`${sizeClasses[size]} ${cfg.bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
      <span className={`${cfg.text} font-mono font-semibold tracking-tight`}>{cfg.label}</span>
    </div>
  );
}
