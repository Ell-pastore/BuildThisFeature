export type FileType = "pdf" | "docx" | "png" | "jpg" | "pptx" | "zip" | "mp4" | "txt" | "xlsx" | "folder";

export interface FileItem {
  id: string;
  name: string;
  type: FileType;
  size: string;
  sizeBytes: number;
  modified: string;
  created: string;
  location: string;
  starred: boolean;
  isFolder?: boolean;
  itemCount?: number;
  deleted?: boolean;
  deletedOn?: string;
}

export const sampleFiles: FileItem[] = [
  { id: "1", name: "SIWES_Report_Final.pdf", type: "pdf", size: "2.4 MB", sizeBytes: 2516582, modified: "Aug 24, 2026", created: "Aug 10, 2026", location: "Documents/University", starred: true },
  { id: "2", name: "Computer_Networks_Assignment.docx", type: "docx", size: "845 KB", sizeBytes: 865280, modified: "Aug 22, 2026", created: "Aug 18, 2026", location: "Documents/University", starred: false },
  { id: "3", name: "Database_Architecture.png", type: "png", size: "1.2 MB", sizeBytes: 1258291, modified: "Aug 20, 2026", created: "Aug 15, 2026", location: "Documents/University", starred: false },
  { id: "4", name: "Project_Proposal.pdf", type: "pdf", size: "3.1 MB", sizeBytes: 3250586, modified: "Aug 18, 2026", created: "Aug 5, 2026", location: "Documents/Projects", starred: true },
  { id: "5", name: "Programming_Notes.pdf", type: "pdf", size: "512 KB", sizeBytes: 524288, modified: "Aug 15, 2026", created: "Jul 20, 2026", location: "Documents", starred: false },
  { id: "6", name: "Presentation_Final.pptx", type: "pptx", size: "8.7 MB", sizeBytes: 9122611, modified: "Aug 12, 2026", created: "Aug 1, 2026", location: "Documents/Projects", starred: false },
  { id: "7", name: "Holiday_Photos.zip", type: "zip", size: "234 MB", sizeBytes: 245366784, modified: "Aug 10, 2026", created: "Aug 10, 2026", location: "Downloads", starred: false },
  { id: "8", name: "Lecture_Recordings.mp4", type: "mp4", size: "1.8 GB", sizeBytes: 1932735283, modified: "Aug 8, 2026", created: "Aug 3, 2026", location: "Videos", starred: false },
  { id: "9", name: "Java_Project.zip", type: "zip", size: "45 MB", sizeBytes: 47185920, modified: "Aug 5, 2026", created: "Jul 28, 2026", location: "Downloads", starred: false },
  { id: "10", name: "Research_Paper.pdf", type: "pdf", size: "1.1 MB", sizeBytes: 1153434, modified: "Aug 3, 2026", created: "Jul 15, 2026", location: "Documents", starred: true },
  { id: "11", name: "Budget_2026.xlsx", type: "xlsx", size: "220 KB", sizeBytes: 225280, modified: "Jul 30, 2026", created: "Jan 5, 2026", location: "Documents", starred: false },
  { id: "12", name: "Campus_Map.png", type: "png", size: "3.4 MB", sizeBytes: 3565158, modified: "Jul 25, 2026", created: "Sep 1, 2025", location: "Downloads", starred: false },
  { id: "13", name: "Internship_Offer_Letter.pdf", type: "pdf", size: "180 KB", sizeBytes: 184320, modified: "Jun 12, 2026", created: "Jun 12, 2026", location: "Documents/University", starred: true },
  { id: "14", name: "Network_Topology.png", type: "png", size: "890 KB", sizeBytes: 911360, modified: "May 20, 2026", created: "May 20, 2026", location: "Downloads", starred: false },
  { id: "15", name: "Course_Outline_2026.docx", type: "docx", size: "310 KB", sizeBytes: 317440, modified: "Apr 10, 2026", created: "Jan 15, 2026", location: "Documents/University", starred: false },
];

export const sampleFolders: FileItem[] = [
  { id: "f1", name: "University", type: "folder", size: "—", sizeBytes: 0, modified: "Aug 24, 2026", created: "Sep 1, 2025", location: "Documents", starred: false, isFolder: true, itemCount: 34 },
  { id: "f2", name: "Projects", type: "folder", size: "—", sizeBytes: 0, modified: "Aug 18, 2026", created: "Jan 10, 2026", location: "Documents", starred: false, isFolder: true, itemCount: 12 },
  { id: "f3", name: "Downloads", type: "folder", size: "—", sizeBytes: 0, modified: "Aug 10, 2026", created: "Jan 1, 2026", location: "/", starred: false, isFolder: true, itemCount: 47 },
  { id: "f4", name: "Videos", type: "folder", size: "—", sizeBytes: 0, modified: "Aug 8, 2026", created: "Jan 1, 2026", location: "/", starred: false, isFolder: true, itemCount: 8 },
];

export const trashedFiles: FileItem[] = [
  { id: "t1", name: "Old_Draft_v1.docx", type: "docx", size: "420 KB", sizeBytes: 430080, modified: "Aug 20, 2026", created: "Aug 1, 2026", location: "Documents", starred: false, deleted: true, deletedOn: "Aug 26, 2026" },
  { id: "t2", name: "temp_screenshot.png", type: "png", size: "1.5 MB", sizeBytes: 1572864, modified: "Aug 22, 2026", created: "Aug 22, 2026", location: "Downloads", starred: false, deleted: true, deletedOn: "Aug 25, 2026" },
  { id: "t3", name: "Assignment_v2_BACKUP.pdf", type: "pdf", size: "845 KB", sizeBytes: 865280, modified: "Aug 15, 2026", created: "Aug 14, 2026", location: "Documents/University", starred: false, deleted: true, deletedOn: "Aug 24, 2026" },
];

export const duplicateGroups = [
  {
    id: "d1",
    files: [
      { id: "d1a", name: "Project_Report.pdf", location: "Documents/University", size: "2.4 MB", modified: "Aug 20, 2026", isBest: true },
      { id: "d1b", name: "Project_Report_Copy.pdf", location: "Downloads", size: "2.4 MB", modified: "Aug 18, 2026", isBest: false },
      { id: "d1c", name: "Project_Report_Final.pdf", location: "Desktop", size: "2.4 MB", modified: "Aug 15, 2026", isBest: false },
    ]
  },
  {
    id: "d2",
    files: [
      { id: "d2a", name: "SIWES_Report_Final.pdf", location: "Documents/University", size: "2.4 MB", modified: "Aug 24, 2026", isBest: true },
      { id: "d2b", name: "SIWES_Report_Final (1).pdf", location: "Downloads", size: "2.4 MB", modified: "Aug 10, 2026", isBest: false },
    ]
  },
  {
    id: "d3",
    files: [
      { id: "d3a", name: "Campus_Map.png", location: "Documents", size: "3.4 MB", modified: "Jul 25, 2026", isBest: true },
      { id: "d3b", name: "Campus_Map_copy.png", location: "Downloads", size: "3.4 MB", modified: "Jul 20, 2026", isBest: false },
    ]
  },
];

export const smartFolders = [
  { id: "sf1", name: "University", description: "Files related to your university coursework and assignments.", count: 126, rule: "AI-curated: files matching academic patterns", icon: "🎓" },
  { id: "sf2", name: "Programming", description: "Source code, projects, and development resources.", count: 43, rule: "AI-curated: .java, .py, .js, project archives", icon: "💻" },
  { id: "sf3", name: "SIWES", description: "Internship-related documents and reports.", count: 18, rule: "AI-curated: SIWES, internship keyword match", icon: "📋" },
  { id: "sf4", name: "Important Documents", description: "High-priority documents starred or frequently accessed.", count: 9, rule: "Rule: starred + opened ≥ 5 times", icon: "⭐" },
  { id: "sf5", name: "Large Files", description: "Files over 100 MB that may be candidates for cleanup.", count: 7, rule: "Rule: size > 100 MB", icon: "📦" },
  { id: "sf6", name: "Recently Modified", description: "Files changed in the last 7 days.", count: 24, rule: "Rule: modified within 7 days", icon: "🕐" },
  { id: "sf7", name: "Images", description: "All image files across every folder.", count: 58, rule: "Rule: .png, .jpg, .jpeg, .gif, .webp", icon: "🖼️" },
  { id: "sf8", name: "Videos", description: "All video files across every folder.", count: 11, rule: "Rule: .mp4, .mov, .avi, .mkv", icon: "🎬" },
];

export const aiOrgSuggestions = [
  { id: "s1", name: "SIWES_Report_Final.pdf", from: "Downloads", to: "Documents/University/SIWES", reason: "Appears to be related to your internship documents.", confidence: 94, accepted: null as boolean | null },
  { id: "s2", name: "Java_Project.zip", from: "Downloads", to: "Documents/Projects/Programming", reason: "Contains Java source files matching your programming projects.", confidence: 88, accepted: null as boolean | null },
  { id: "s3", name: "Network_Topology.png", from: "Downloads", to: "Documents/University/Networks", reason: "Filename matches your Computer Networks coursework.", confidence: 82, accepted: null as boolean | null },
  { id: "s4", name: "Internship_Offer_Letter.pdf", from: "Downloads", to: "Documents/University/SIWES", reason: "Likely belongs with your SIWES internship documents.", confidence: 91, accepted: null as boolean | null },
  { id: "s5", name: "Research_Paper.pdf", from: "Downloads", to: "Documents/University", reason: "Academic paper format matching your University folder.", confidence: 79, accepted: null as boolean | null },
  { id: "s6", name: "Budget_2026.xlsx", from: "Downloads", to: "Documents/Personal/Finance", reason: "Financial spreadsheet not found in any organized folder.", confidence: 75, accepted: null as boolean | null },
];
