Build a polished, professional desktop web application called Smart File Manager.

The application is an intelligent file-management system that combines a familiar desktop file explorer with AI-powered organization, natural-language file search, duplicate detection, smart folders, file insights, and intelligent recommendations.

The result should feel like a real production-quality productivity application, not a simple dashboard mockup.

1. PRODUCT VISION

Smart File Manager helps users manage large collections of files without requiring them to manually organize everything.

The traditional file manager remains the foundation.

AI works as an intelligent layer on top of it.

The user should be able to:

* Browse folders and files
* Search files normally
* Search using natural language
* Create, rename, move, copy, and delete files/folders
* Preview files
* Star important files
* View recent files
* Detect duplicate files
* Ask AI to organize files
* Review AI organization suggestions before applying them
* Create and use smart folders
* Analyze storage usage
* Receive AI recommendations
* Undo AI actions where possible

AI must never feel like a separate chatbot application. It should be deeply integrated into the file-management workflow.

2. PLATFORM

Design for a desktop application.

Primary target:

* Desktop
* Large screens
* Minimum supported layout approximately 1280px wide

Use a responsive layout that gracefully adapts to smaller desktop widths.

Do not design a mobile interface.

3. VISUAL STYLE

Create a modern premium productivity interface.

Visual references:

* macOS productivity applications
* Linear
* Arc
* Raycast
* Modern professional SaaS applications

Characteristics:

* Clean
* Minimal
* Spacious
* Professional
* Elegant
* Highly readable
* Strong visual hierarchy
* Subtle animations
* Restrained use of color

Avoid:

* Excessive gradients
* Excessive glassmorphism
* Neon AI aesthetics
* Huge decorative illustrations
* Excessive shadows
* Excessively rounded interfaces
* Generic AI chatbot styling

AI should be recognizable through subtle visual cues such as an AI icon, sparkle symbol, subtle accent, or badge.

Use a light theme as the primary interface.

Structure the styling so dark mode could be added later.

4. APPLICATION SHELL

Create a persistent application shell consisting of:

LEFT SIDEBAR
MAIN CONTENT AREA
OPTIONAL AI ASSISTANT PANEL

The sidebar should remain consistent across major screens.

Sidebar

At the top:

SmartFile logo/icon
Smart File Manager

Navigation:

Home
Files
Recent
Starred
Trash

Divider

Smart Folders

University
Projects
Documents
Images
Videos

Divider

AI

AI Assistant
AI Organization
Duplicates

Bottom:

Settings
Help

The active navigation item should have a clear selected state.

The sidebar should support collapsing.

5. GLOBAL TOP BAR

Create a top navigation bar inside the main application area.

Include:

* Breadcrumb navigation
* Global search field
* Search shortcut indicator
* Notifications
* AI Assistant button
* User profile/avatar

Search should be visually prominent.

Placeholder:

“Search files, folders, or ask anything…”

The search field should support natural-language queries.

Examples:

“Find my internship documents”

“Show large videos”

“Find duplicate PDFs”

“Show files I edited last week”

6. HOME DASHBOARD

Create a polished Home dashboard.

Header:

“Good morning”

Subtitle:

“Here’s what’s happening with your files.”

Include a quick statistics section.

Cards:

RECENT FILES
Show the number of recently accessed files.

STORAGE
Show used storage and available storage with a clean progress visualization.

AI ACTIONS
Show pending AI recommendations.

ORGANIZATION
Show how many files have been organized.

Then create:

Recent Files

Display realistic sample files.

Example:

Project Proposal.pdf
SIWES Report.docx
Database Architecture.png
Presentation.pptx
Research Notes.pdf

Show:

* File icon/thumbnail
* File name
* File type
* Location
* Modified date
* File size

Allow switching between list and grid views.

AI Recommendations

Create a visually distinct but subtle AI section.

Example:

“✨ Smart suggestions”

“23 files in Downloads appear to belong to your University folder.”

Buttons:

Review
Dismiss

Another suggestion:

“8 duplicate files were detected.”

Button:

Review duplicates

Quick Actions

Create buttons:

Upload files
New folder
Organize with AI
Find duplicates

7. FILE EXPLORER

Create a full file-management interface.

Header:

Breadcrumb:

Home / Documents / University

Toolbar:

New
Upload
Sort
Filter
View
More

Main content should support:

Grid view
List view

Each file should show:

Icon or thumbnail
File name
Type
Size
Modified date

Folder items should appear visually distinct from files.

Support selection.

When selecting a file, show a contextual toolbar:

Open
Share
Rename
Move
Star
Delete
More

Right-click/context-menu behavior should be represented visually where appropriate.

8. FILE PREVIEW

Create a detailed file-preview experience.

When a user opens a file:

Show:

File preview area

Right information panel:

File name
File type
File size
Location
Created date
Modified date

Actions:

Open
Download
Share
Rename
Move
Star
Delete

For documents, show a realistic document preview.

For images, show the image preview.

For videos, show a video player placeholder.

For unsupported files, show an appropriate file-type illustration.

9. NATURAL-LANGUAGE SEARCH

Create a dedicated AI-powered search experience.

The user can enter queries such as:

“Find all PDFs related to my programming projects”

“Show images from August”

“Find the report I edited yesterday”

“Find large files that I haven’t opened recently”

The search page should show:

Query
AI interpretation
Results
Filters
Sorting

Example:

SEARCH QUERY

Find my internship documents

AI UNDERSTANDING

Looking for:

* Documents
* Internship/SIWES related content
* Recent or relevant files

RESULTS

Show matching files with:

File name
Match percentage
Reason for match
Location
Modified date

Example:

SIWES_Final_Report.pdf

94% match

“Contains internship-related content and references to SIWES.”

Do not make match percentages look scientifically precise. They should feel like relevance indicators.

10. AI ASSISTANT

Create a slide-out right-side AI assistant panel.

The assistant should feel integrated with the current file context.

Header:

✨ Smart Assistant

Example conversation:

User:

“Can you organize my Downloads folder?”

AI:

“I found 47 files that could be organized.”

Show categories:

Documents — 18
Images — 12
Videos — 9
Archives — 5
Other — 3

Then:

“I recommend creating these folders…”

Documents
Images
Videos
Archives
Other

Buttons:

Review changes
Cancel

The AI must ask for confirmation before destructive or large-scale changes.

The assistant should also support:

Find files
Explain files
Summarize documents
Suggest organization
Find duplicates
Identify large files
Suggest smart folders

Create suggested prompt buttons:

Organize my files
Find duplicates
Clean Downloads
Find important documents

11. AI ORGANIZATION

Create a dedicated AI Organization screen.

Header:

“AI Organization”

Subtitle:

“Let Smart File Manager analyze your files and suggest a better structure.”

Show:

Files analyzed
Potentially misplaced files
Duplicate files
Suggested folders

Example recommendation:

“Your Downloads folder contains files that appear to belong in other folders.”

Show a review interface.

Each proposed action should display:

Current location
Proposed location
Reason
Confidence/relevance indicator

Example:

SIWES_Report_Final.pdf

Downloads

→

University / SIWES

Reason:
“Appears to be related to your internship documents.”

Actions:

Accept
Reject

Allow multiple changes to be reviewed before applying them.

Include:

Select all
Accept selected
Reject selected

12. DUPLICATE DETECTION

Create a dedicated Duplicates screen.

Show:

“8 duplicate groups found”

Each duplicate group should show:

File thumbnails/icons
Names
Locations
File sizes
Dates

Example:

Duplicate Group 01

Project_Report.pdf
Documents/University
2.4 MB

Project_Report_Copy.pdf
Downloads
2.4 MB

Project_Report_Final.pdf
Desktop
2.4 MB

Show which file appears to be the best version.

Actions:

Keep
Delete duplicate
Review

Never make deletion automatic.

13. SMART FOLDERS

Create a Smart Folders screen.

Smart folders are dynamic folders generated from rules or AI understanding.

Examples:

University
Programming
SIWES
Important Documents
Large Files
Recently Modified
Images
Videos

Each smart folder should show:

Name
Description
Number of files
Rule or AI explanation

Example:

University

“Files related to your university work.”

126 files

Smart folders should visually differ slightly from normal folders without becoming confusing.

14. STORAGE ANALYSIS

Create a storage-analysis screen.

Show:

Total storage
Used storage
Available storage

Then a visual breakdown:

Documents
Images
Videos
Audio
Archives
Other

Include:

Largest files

Old files

Potential duplicates

Potential cleanup suggestions

Example:

“Your Videos folder uses 42% of your storage.”

AI suggestion:

“12 large videos haven’t been opened in 6 months.”

Button:

Review

15. RECENT

Create a Recent Files screen.

Organize recent activity into:

Today
Yesterday
Earlier this week
Earlier

Show file activity such as:

Opened
Modified
Created
Moved
Renamed

16. STARRED

Create a Starred Files screen.

Show important files and folders marked by the user.

Include empty state when no files are starred.

17. TRASH

Create a Trash screen.

Show deleted files.

Include:

Restore
Delete permanently

Show a warning before permanent deletion.

18. SETTINGS

Create a Settings interface.

Sections:

General
Appearance
Storage
AI
Privacy
Notifications
Keyboard Shortcuts

AI settings should include:

Enable AI suggestions
Enable natural-language search
Enable automatic duplicate detection
Ask before moving files
Ask before deleting files

Privacy settings should clearly explain that file analysis should be transparent to the user.

19. INTERACTION DESIGN

Create realistic interactions between screens.

Examples:

Click Home → Dashboard

Click Files → File Explorer

Click Search → Search screen

Click AI Assistant → Open right-side assistant

Click a folder → Navigate into folder

Click a file → File Preview

Click Organize with AI → AI Organization screen

Click Review → Review proposed changes

Click Accept → Mark action for confirmation

Click Delete → Confirmation dialog

Click Undo → Reverse recent action where possible

Create hover states, selected states, loading states, empty states, error states, and confirmation states.

20. SAMPLE DATA

Populate the interface with realistic sample files.

Use names such as:

SIWES_Report_Final.pdf
Computer_Networks_Assignment.docx
Database_Architecture.png
Project_Proposal.pdf
Programming_Notes.pdf
Presentation_Final.pptx
Holiday_Photos.zip
Lecture_Recordings.mp4
Java_Project.zip
Research_Paper.pdf

Use realistic file sizes, dates, and locations.

21. IMPORTANT UX RULES

The application must always make it clear what the AI is doing.

Never silently:

* Delete files
* Move large numbers of files
* Rename large numbers of files
* Permanently delete files

Use confirmation and review interfaces.

Destructive actions should be clearly distinguishable.

Provide Undo wherever technically reasonable.

The normal file manager must remain completely usable without AI.

22. DESIGN SYSTEM

Use consistent:

Typography
Spacing
Colors
Borders
Corner radius
Icons
Button styles
Input styles
Cards
Modals
Toast notifications

Use reusable components rather than creating every element independently.

Maintain consistent spacing based on a 4px/8px spacing system.

Use subtle borders and restrained shadows.

23. FINAL QUALITY BAR

The final result should feel like a real product that could be shown in a professional software portfolio.

Prioritize:

* Excellent hierarchy
* Strong usability
* Clear navigation
* Consistent components
* Realistic interactions
* Professional visual design
* AI features integrated naturally into the file-management workflow

Do not create a generic landing page.

Build the actual Smart File Manager application interface and its connected screens.