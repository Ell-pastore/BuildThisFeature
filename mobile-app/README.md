AI File Manager — Design-First Flutter Scaffold
Static UI implementation of the 8-screen design board approved earlier.
No business logic yet — every screen renders hard-coded dummy data so your
group can iterate on the look & feel before wiring any state.
Run
```
flutter pub get
flutter run
```
What's inside
```
lib/
├── main.dart                        # App entry, theme bootstrap
├── theme/
│   ├── app_colors.dart             # All hex tokens (single source of truth)
│   └── app_theme.dart              # Light + dark Material 3 ThemeData
├── widgets/
│   ├── app_status_bar.dart         # 9:41 status bar
│   ├── bottom_nav.dart             # Shared M3 bottom nav
│   ├── pill_chip.dart              # Active / inactive pill chip
│   ├── search_pill_bar.dart        # Search-bar with leading icon
│   ├── file_tile.dart              # File-type-aware list row
│   ├── storage_hero.dart           # Storage usage card with segmented bar
│   ├── ai_insight_card.dart        # Tip card with gradient orb
│   └── confirm_sheet.dart          # Plan-confirmation bottom sheet
└── screens/
    ├── home_shell.dart             # Bottom-nav root + 4 demo FABs
    ├── home_screen.dart            # Screen 1 — Storage Overview
    ├── browse_screen.dart          # Screen 2 — Smart Categories
    ├── file_list_screen.dart       # Screen 3 — File list + multi-select
    ├── ai_chat_screen.dart         # Screen 4 — AI plan preview
    ├── confirm_screen.dart         # Screen 5 — Confirmation sheet
    ├── search_screen.dart          # Screen 6 — Semantic search results
    ├── settings_screen.dart        # Screen 7 — AI & Privacy
    └── dark_home_screen.dart       # Screen 8 — Dark variant
```
Reach every screen
`HomeShell` renders the 4 main tabs. Four extra FloatingActionButtons
(default `Wrap` stack, bottom-right) jump directly to the other screens so
designers can review each one without switching tabs.
Next steps for the team
Replace hard-coded lists in each screen with `FutureBuilder`s hitting
your storage / AI backend.
Introduce a single `ActionPlan` model — the chat plan and the
confirmation sheet should consume the same data structure.
Add `go_router` when you outgrow `Navigator.push` (probably at the
confirmation-flow stage).
